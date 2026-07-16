// Endpoint-level tests for POST /api/verify-band (verify_band.mjs).
//
// Mirrors tests/bands-write-endpoints.test.mjs's overall style: auth and
// validation checks are exercised without touching a real database by
// relying on the auth-before-DB / validation-before-DB ordering in the
// handler (missing token -> 401 before any DB call; malformed band_id ->
// 400 before any DB call).
//
// The 404 case necessarily needs to reach a real `select ... from bands`
// query. Rather than skip it (as bands-write-endpoints.test.mjs does for
// its success paths), we mock `globalThis.fetch` to intercept the Neon
// serverless driver's HTTP calls (it POSTs queries as JSON to
// api.neon.tech/sql — see @neondatabase/serverless's HTTP transport) and
// hand back a canned "no rows" response. This keeps the test hermetic (no
// real network access) while still exercising the actual 404 code path
// end-to-end, including the findUserByToken lookup.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import verifyBand from '../netlify/functions/verify_band.mjs';

function req(method, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request('https://example.test/api/verify-band', init);
}

function withoutDb(fn) {
  return async () => {
    const before = process.env[DB_URL_ENV];
    delete process.env[DB_URL_ENV];
    try {
      await fn();
    } finally {
      if (before !== undefined) process.env[DB_URL_ENV] = before;
    }
  };
}

function withFakeDb(fn) {
  return async () => {
    const before = process.env[DB_URL_ENV];
    process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake.neon.tech/fake';
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env[DB_URL_ENV];
      else process.env[DB_URL_ENV] = before;
    }
  };
}

// The Neon serverless driver's HTTP transport requires each field to carry
// a Postgres `dataTypeID` so its result parser can look up a type parser
// (see @neondatabase/serverless's processQueryResult) -- 25 is `text`,
// good enough for every column these mocked queries return.
function textField(name) {
  return { name, dataTypeID: 25 };
}

// Installs a fetch mock that intercepts Neon's HTTP transport
// (api.neon.tech/sql) and routes each query to a caller-supplied resolver
// based on a regex match against the SQL text. Anything else (e.g. a real
// MusicBrainz/Wikipedia call, which this test suite should never reach
// because we return 404 before those fire) throws loudly instead of
// silently hitting the network.
function withMockedNeonFetch(queryResolvers, fn) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (!urlStr.includes('neon.tech')) {
        throw new Error(`unexpected non-Neon fetch in test: ${urlStr}`);
      }
      const body = JSON.parse(opts.body);
      const sqlText = body.query;
      for (const { pattern, rows, fieldNames } of queryResolvers) {
        if (pattern.test(sqlText)) {
          const rowsOut = rows || [];
          const fields = (fieldNames || []).map(textField);
          return new Response(
            JSON.stringify({ fields, rows: rowsOut, command: 'SELECT', rowCount: rowsOut.length }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
      }
      throw new Error(`no mock resolver matched query: ${sqlText}`);
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

const VALID_UUID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';

// --- method + auth ------------------------------------------------------------

test('GET /api/verify-band (wrong method) is rejected with 405', async () => {
  const r = await verifyBand(req('GET'));
  assert.equal(r.status, 405);
});

test('PUT /api/verify-band is rejected with 405', async () => {
  const r = await verifyBand(req('PUT', { authorization: 'Bearer sometoken' }));
  assert.equal(r.status, 405);
});

test('POST /api/verify-band returns 401 when no bearer token is provided',
  withoutDb(async () => {
    const r = await verifyBand(req('POST', {}, { band_id: VALID_UUID }));
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.ok, false);
  })
);

test('POST /api/verify-band checks auth before DB configuration',
  withoutDb(async () => {
    // No token AND no DB configured -> must be 401, not 503, proving auth
    // is checked first (same ordering discipline as bands_create.mjs).
    const r = await verifyBand(req('POST', {}, { band_id: VALID_UUID }));
    assert.equal(r.status, 401);
  })
);

test('POST /api/verify-band returns 503 when authorized but DB URL missing',
  withoutDb(async () => {
    const r = await verifyBand(req('POST', { authorization: 'Bearer sometoken' }, { band_id: VALID_UUID }));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

// --- body validation ------------------------------------------------------------

test('POST /api/verify-band returns 400 when body is not JSON',
  withFakeDb(async () => {
    const r = await verifyBand(
      req('POST', { authorization: 'Bearer sometoken', 'content-type': 'application/json' }, 'not json {')
    );
    assert.equal(r.status, 400);
  })
);

test('POST /api/verify-band returns 400 when body is missing entirely (empty object)',
  withFakeDb(async () => {
    const r = await verifyBand(req('POST', { authorization: 'Bearer sometoken' }, {}));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'band_id');
  })
);

test('POST /api/verify-band returns 400 when band_id is missing',
  withFakeDb(async () => {
    const r = await verifyBand(req('POST', { authorization: 'Bearer sometoken' }, { not_band_id: 'x' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'band_id');
  })
);

test('POST /api/verify-band returns 400 when band_id is not a valid UUID',
  withFakeDb(async () => {
    const r = await verifyBand(req('POST', { authorization: 'Bearer sometoken' }, { band_id: 'not-a-uuid' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'band_id');
    assert.ok(body.error.toLowerCase().includes('uuid'));
  })
);

test('POST /api/verify-band returns 400 for malformed body before ever needing a real DB row',
  withFakeDb(async () => {
    const r = await verifyBand(req('POST', { authorization: 'Bearer sometoken' }, { band_id: 12345 }));
    assert.equal(r.status, 400);
  })
);

// --- 404 (real DB path, mocked at the fetch layer) ------------------------------

const USERS_FIELD_NAMES = ['id', 'email', 'name', 'token', 'bands_added', 'bands_edited', 'created_at'];

test('POST /api/verify-band returns 404 when band_id does not exist in the bands table',
  withFakeDb(
    withMockedNeonFetch(
      [
        // findUserByToken -> one matching user
        {
          pattern: /from users/i,
          fieldNames: USERS_FIELD_NAMES,
          rows: [['user-1', 'a@b.com', 'Alice', 'sometoken', '0', '0', new Date().toISOString()]],
        },
        // select * from bands where id = ... -> no rows
        { pattern: /from bands where id/i, rows: [] },
      ],
      async () => {
        const r = await verifyBand(req('POST', { authorization: 'Bearer sometoken' }, { band_id: VALID_UUID }));
        assert.equal(r.status, 404);
        const body = await r.json();
        assert.equal(body.ok, false);
      }
    )
  )
);

test('POST /api/verify-band returns 401 when the bearer token does not match any user',
  withFakeDb(
    withMockedNeonFetch(
      [
        // findUserByToken -> no matching user
        { pattern: /from users/i, rows: [] },
      ],
      async () => {
        const r = await verifyBand(req('POST', { authorization: 'Bearer invalidtoken' }, { band_id: VALID_UUID }));
        assert.equal(r.status, 401);
      }
    )
  )
);
