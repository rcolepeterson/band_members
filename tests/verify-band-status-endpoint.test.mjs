// Endpoint-level tests for GET /api/verify-band-status
// (verify_band_status.mjs). Mirrors the style of
// tests/verify-band-endpoint.test.mjs: method/validation checks that never
// need a real DB are exercised directly; the one success-shaped path (an
// unknown id resolving to null) is exercised against a mocked Neon fetch,
// same technique as verify-band-endpoint.test.mjs's 404 test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import verifyBandStatus from '../netlify/functions/verify_band_status.mjs';

function req(method, query = '') {
  return new Request(`https://example.test/api/verify-band-status${query}`, { method });
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

// See verify-band-endpoint.test.mjs for why dataTypeID: 25 (text) is
// sufficient for every column these mocked queries return.
function field(name) {
  return { name, dataTypeID: 25 };
}

function withMockedNeonFetch(rows, fn) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (!urlStr.includes('neon.tech')) {
        throw new Error(`unexpected non-Neon fetch in test: ${urlStr}`);
      }
      const fieldNames = ['band_id', 'verified_at', 'overall_score', 'breakdown', 'musicbrainz_mbid', 'musicbrainz_url', 'wikipedia_title', 'wikipedia_url'];
      return new Response(
        JSON.stringify({ fields: fieldNames.map(field), rows, command: 'SELECT', rowCount: rows.length }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

const UUID_A = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const UUID_B_SAFE = '6c22a5df-b73e-582f-921d-b7a09389d8eb';

// --- method -----------------------------------------------------------------

test('POST /api/verify-band-status is rejected with 405', async () => {
  const r = await verifyBandStatus(req('POST'));
  assert.equal(r.status, 405);
});

test('PATCH /api/verify-band-status is rejected with 405', async () => {
  const r = await verifyBandStatus(req('PATCH'));
  assert.equal(r.status, 405);
});

// --- validation (no DB call needed since these all fail before the query) ---

test('GET /api/verify-band-status returns 400 when band_ids is missing',
  withFakeDb(async () => {
    const r = await verifyBandStatus(req('GET'));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'band_ids');
  })
);

test('GET /api/verify-band-status returns 400 when band_ids is empty',
  withFakeDb(async () => {
    const r = await verifyBandStatus(req('GET', '?band_ids='));
    assert.equal(r.status, 400);
  })
);

test('GET /api/verify-band-status returns 400 when a band_id is not a valid UUID',
  withFakeDb(async () => {
    const r = await verifyBandStatus(req('GET', `?band_ids=${UUID_A},not-a-uuid`));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'band_ids');
    assert.ok(Array.isArray(body.invalid));
    assert.ok(body.invalid.includes('not-a-uuid'));
  })
);

test('GET /api/verify-band-status returns 400 when more than 100 band_ids are supplied',
  withFakeDb(async () => {
    // Reuse one valid-shaped UUID pattern with varying last hex digit so all
    // 101 entries pass the UUID_RE shape check individually.
    const ids = Array.from({ length: 101 }, (_, i) =>
      `5b11f4ce-a62d-471e-81fc-a69a8278c7${String(i).padStart(2, '0')}`
    );
    const r = await verifyBandStatus(req('GET', `?band_ids=${ids.join(',')}`));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'band_ids');
    assert.equal(body.max, 100);
    assert.equal(body.received, 101);
  })
);

test('GET /api/verify-band-status accepts exactly 100 band_ids',
  withFakeDb(
    withMockedNeonFetch([], async () => {
      const ids = Array.from({ length: 100 }, (_, i) =>
        `5b11f4ce-a62d-471e-81fc-a69a8278c7${String(i).padStart(2, '0')}`
      );
      const r = await verifyBandStatus(req('GET', `?band_ids=${ids.join(',')}`));
      assert.equal(r.status, 200);
    })
  )
);

test('GET /api/verify-band-status returns 503 when DB URL is not configured',
  withoutDb(async () => {
    const r = await verifyBandStatus(req('GET', `?band_ids=${UUID_A}`));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

test('GET /api/verify-band-status never requires auth (public read)',
  withFakeDb(
    withMockedNeonFetch([], async () => {
      // No Authorization header at all — should not 401.
      const r = await verifyBandStatus(req('GET', `?band_ids=${UUID_A}`));
      assert.notEqual(r.status, 401);
      assert.equal(r.status, 200);
    })
  )
);

// --- response shape -----------------------------------------------------------

test('GET /api/verify-band-status maps an unknown band_id to null',
  withFakeDb(
    withMockedNeonFetch([], async () => {
      const r = await verifyBandStatus(req('GET', `?band_ids=${UUID_A}`));
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.verifications, { [UUID_A]: null });
    })
  )
);

test('GET /api/verify-band-status returns a verification object for a known band_id and null for an unknown one',
  withFakeDb(
    withMockedNeonFetch(
      [[UUID_A, new Date('2026-07-01T00:00:00Z').toISOString(), '87', JSON.stringify({ name: { score: 100 } }), 'mbid-123', 'https://musicbrainz.org/artist/mbid-123', 'Some Band', 'https://en.wikipedia.org/wiki/Some_Band']],
      async () => {
        const r = await verifyBandStatus(req('GET', `?band_ids=${UUID_A},${UUID_B_SAFE}`));
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.ok, true);
        assert.equal(body.verifications[UUID_B_SAFE], null);
        const known = body.verifications[UUID_A];
        assert.ok(known);
        assert.equal(known.overall_score, '87');
        assert.equal(known.sources.musicbrainz.mbid, 'mbid-123');
        assert.equal(known.sources.wikipedia.title, 'Some Band');
      }
    )
  )
);

test('GET /api/verify-band-status returns null sources sub-objects when no external match was ever found',
  withFakeDb(
    withMockedNeonFetch(
      [[UUID_A, new Date().toISOString(), '0', JSON.stringify({}), null, null, null, null]],
      async () => {
        const r = await verifyBandStatus(req('GET', `?band_ids=${UUID_A}`));
        const body = await r.json();
        assert.equal(body.verifications[UUID_A].sources.musicbrainz, null);
        assert.equal(body.verifications[UUID_A].sources.wikipedia, null);
      }
    )
  )
);
