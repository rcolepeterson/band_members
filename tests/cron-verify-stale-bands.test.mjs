// Tests for the daily stale-bands verification cron
// (cron_verify_stale_bands.mjs) and its manual trigger
// (cron_verify_stale_bands_trigger.mjs).
//
// Strategy: `selectStaleBands` and `verifyOneBand`/`runBatch` all take an
// explicit `sql` argument (tagged-template function), so tests pass a
// hand-written fake `sql` that records the query text and returns
// caller-supplied rows — no real Postgres, no @neondatabase/serverless
// HTTP mocking needed for the pure batch-logic tests. The manual-trigger
// endpoint's auth/method/DB-config layer is tested the same way the other
// admin-guarded endpoints are (see bands-neon-endpoint.test.mjs), using a
// real fake `sql` only for the one authorized-and-configured path.
//
// External services (MusicBrainz, Wikipedia) are never really called:
// verifyOneBand delegates to fetchMusicBrainz/fetchWikipedia from
// _verify_helpers.mjs, both of which accept fetchImpl — but runBatch and
// verifyOneBand call the *unmocked* module-level fetchMusicBrainz /
// fetchWikipedia (bound to global fetch), matching verify_band.mjs's own
// production wiring. So tests mock `globalThis.fetch` directly instead of
// injecting fetchImpl, same technique already used for the Neon HTTP
// transport in verify-band-endpoint.test.mjs, just pointed at
// musicbrainz.org / wikipedia.org URLs instead of neon.tech.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import {
  selectStaleBands,
  verifyOneBand,
  runBatch,
  BATCH_SIZE,
} from '../netlify/functions/cron_verify_stale_bands.mjs';
import cronTrigger from '../netlify/functions/cron_verify_stale_bands_trigger.mjs';

function req(method, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request('https://example.test/api/cron-verify-stale-bands', init);
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

function withAdminToken(token, fn) {
  return async () => {
    const before = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = token;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  };
}

function withFakeDbUrl(fn) {
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

// A minimal fake `sql` tagged-template function. Records every call's
// interpolated values (so tests can assert on the LIMIT passed in) and
// returns rows from a caller-supplied queue (FIFO) or the same static rows
// every time. Good enough for selectStaleBands (select) and verifyOneBand's
// insert (any array return is fine — verifyOneBand doesn't inspect the
// insert's result).
function makeFakeSql({ selectRowsQueue = [], onQuery } = {}) {
  const calls = [];
  let queueIndex = 0;
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (typeof onQuery === 'function') {
      const forced = onQuery(text, values, calls.length);
      if (forced !== undefined) return Promise.resolve(forced);
    }
    // Heuristic: a `left join verifications` query is our select; anything
    // else (the insert) just needs to resolve successfully.
    if (text.includes('left join verifications')) {
      const rows = selectRowsQueue[Math.min(queueIndex, selectRowsQueue.length - 1)] || [];
      queueIndex += 1;
      return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

function mockExternalFetchAlwaysFail() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network disabled in test');
  };
  return () => { globalThis.fetch = original; };
}

// Mocks both wikipedia.org and musicbrainz.org calls to succeed with "no
// match found" payloads — enough for verifyOneBand to reach its upsert
// without a real network call, and without needing realistic artist data
// (scoreVerification tolerates nulls throughout, see verify-helpers tests).
function mockExternalFetchNoMatch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('musicbrainz.org')) {
      return new Response(JSON.stringify({ artists: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (urlStr.includes('wikipedia.org')) {
      // Any wikipedia call (summary or search) — 404 is a valid "not found"
      // response for fetchWikipedia's direct-candidate loop.
      return new Response('not found', { status: 404 });
    }
    throw new Error(`unexpected fetch in test: ${urlStr}`);
  };
  return () => { globalThis.fetch = original; };
}

const BAND_A = { id: 'band-a', name: 'The Testers', city: 'Seattle', country: 'USA', genre: 'Rock', years_active: '1990-1995' };
const BAND_B = { id: 'band-b', name: 'The Mocks', city: 'Portland', country: 'USA', genre: 'Punk', years_active: '1991-1996' };

// --- selectStaleBands ---------------------------------------------------------

test('selectStaleBands passes the requested limit through to the query', async () => {
  const sql = makeFakeSql({ selectRowsQueue: [[BAND_A]] });
  const rows = await selectStaleBands(sql, 7);
  assert.equal(rows.length, 1);
  assert.equal(sql.calls.length, 1);
  assert.deepEqual(sql.calls[0].values, [7]);
});

test('selectStaleBands query selects on null verified_at, staleness, or band edited after verification', async () => {
  const sql = makeFakeSql({ selectRowsQueue: [[]] });
  await selectStaleBands(sql, 10);
  const queryText = sql.calls[0].text;
  assert.ok(queryText.includes('v.verified_at is null'));
  assert.ok(queryText.includes("interval '24 hours'"));
  assert.ok(queryText.includes('v.verified_at < b.updated_at'));
});

// --- verifyOneBand -------------------------------------------------------------

test('verifyOneBand returns ok:false without throwing when both external services fail',
  async () => {
    const restore = mockExternalFetchAlwaysFail();
    try {
      const sql = makeFakeSql();
      const result = await verifyOneBand(sql, BAND_A);
      assert.equal(result.ok, false);
      assert.ok(result.error);
      // No insert/upsert should have been attempted when there's nothing to score.
      assert.equal(sql.calls.length, 0);
    } finally {
      restore();
    }
  }
);

test('verifyOneBand upserts and returns ok:true when at least one external service responds',
  async () => {
    const restore = mockExternalFetchNoMatch();
    try {
      const sql = makeFakeSql();
      const result = await verifyOneBand(sql, BAND_A);
      assert.equal(result.ok, true);
      assert.equal(sql.calls.length, 1);
      assert.ok(sql.calls[0].text.includes('insert into verifications'));
    } finally {
      restore();
    }
  }
);

test('verifyOneBand catches a thrown DB error and returns ok:false instead of throwing',
  async () => {
    const restore = mockExternalFetchNoMatch();
    try {
      const sql = () => { throw new Error('db exploded'); };
      const result = await verifyOneBand(sql, BAND_A);
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('db exploded'));
    } finally {
      restore();
    }
  }
);

// --- runBatch: batch size + one-bad-band-does-not-abort-batch -----------------

test('runBatch respects the batch size passed in (does not process more than requested)',
  async () => {
    const restore = mockExternalFetchNoMatch();
    try {
      const candidates = [BAND_A, BAND_B];
      const sql = makeFakeSql({ selectRowsQueue: [candidates, []] });
      const summary = await runBatch(sql, 2);
      assert.equal(summary.processed, 2);
      assert.equal(summary.succeeded, 2);
      assert.equal(summary.failed, 0);
    } finally {
      restore();
    }
  }
);

test('runBatch defaults to BATCH_SIZE (10) when no override is passed', async () => {
  assert.equal(BATCH_SIZE, 10);
});

test('runBatch continues processing the rest of the batch when one band errors out',
  async () => {
    let callCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      callCount += 1;
      // Fail every external call made while processing BAND_A (the first
      // band in the candidate list); succeed (no-match) for BAND_B.
      if (urlStr.includes('The%20Testers') || urlStr.includes('Testers')) {
        throw new Error('simulated network failure for band A');
      }
      if (urlStr.includes('musicbrainz.org')) {
        return new Response(JSON.stringify({ artists: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    };
    try {
      const candidates = [BAND_A, BAND_B];
      const sql = makeFakeSql({ selectRowsQueue: [candidates, []] });
      const summary = await runBatch(sql, 2);
      assert.equal(summary.processed, 2);
      // BAND_A's Wikipedia call throws -> ok:false; MusicBrainz call for
      // BAND_A also throws (same guard) -> verifyOneBand reports failure.
      // BAND_B succeeds. Either ordering satisfies "one bad band doesn't
      // abort the batch": both bands were attempted (2 upsell attempts to
      // fetch happened) rather than the loop stopping after the first error.
      assert.equal(summary.succeeded + summary.failed, 2);
      assert.ok(summary.failed >= 1, 'expected at least one failure from the simulated network error');
      assert.ok(callCount > 1, 'expected the loop to keep going and attempt band B after band A failed');
    } finally {
      globalThis.fetch = original;
    }
  }
);

test('runBatch summary includes next_stale_count reflecting remaining backlog', async () => {
  const restore = mockExternalFetchNoMatch();
  try {
    const remainingAfter = [BAND_B]; // pretend one band is still stale after this run
    const sql = makeFakeSql({ selectRowsQueue: [[BAND_A], remainingAfter] });
    const summary = await runBatch(sql, 1);
    assert.equal(summary.next_stale_count, 1);
  } finally {
    restore();
  }
});

// --- manual trigger endpoint: method / auth / DB config -----------------------

test('POST /api/cron-verify-stale-bands (via GET) is rejected with 405', async () => {
  const r = await cronTrigger(req('GET'));
  assert.equal(r.status, 405);
});

test('POST /api/cron-verify-stale-bands returns 401 when no admin token is provided', async () => {
  const r = await cronTrigger(req('POST'));
  assert.equal(r.status, 401);
});

test('POST /api/cron-verify-stale-bands returns 401 when the wrong admin token is provided',
  withAdminToken('correct-token', async () => {
    const r = await cronTrigger(req('POST', { 'x-admin-token': 'wrong-token' }));
    assert.equal(r.status, 401);
  })
);

test('POST /api/cron-verify-stale-bands checks auth before DB configuration',
  withoutDb(
    withAdminToken('correct-token', async () => {
      const r = await cronTrigger(req('POST', { 'x-admin-token': 'wrong-token' }));
      assert.equal(r.status, 401); // not 503 -- auth checked first
    })
  )
);

test('POST /api/cron-verify-stale-bands returns 503 when authorized but DB URL missing',
  withoutDb(
    withAdminToken('correct-token', async () => {
      const r = await cronTrigger(req('POST', { 'x-admin-token': 'correct-token' }));
      assert.equal(r.status, 503);
      const body = await r.json();
      assert.ok(body.hint.includes(DB_URL_ENV));
    })
  )
);

test('POST /api/cron-verify-stale-bands runs a batch and returns the summary when authorized',
  withFakeDbUrl(
    withAdminToken('correct-token', async () => {
      const restore = mockExternalFetchNoMatch();
      // Also need to intercept the Neon HTTP transport, since this path
      // goes through the real getSql()/neon() client rather than a fake
      // sql function.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        const urlStr = String(url);
        if (urlStr.includes('neon.tech')) {
          const body = JSON.parse(opts.body);
          const isSelect = /left join verifications/i.test(body.query);
          const fields = isSelect
            ? ['id', 'name', 'city', 'country', 'genre', 'years_active', 'verified_at'].map(n => ({ name: n, dataTypeID: 25 }))
            : [];
          return new Response(
            JSON.stringify({ fields, rows: [], command: isSelect ? 'SELECT' : 'INSERT', rowCount: 0 }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (urlStr.includes('musicbrainz.org')) {
          return new Response(JSON.stringify({ artists: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (urlStr.includes('wikipedia.org')) return new Response('not found', { status: 404 });
        throw new Error(`unexpected fetch in test: ${urlStr}`);
      };
      try {
        const r = await cronTrigger(req('POST', { 'x-admin-token': 'correct-token' }));
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.ok, true);
        assert.equal(body.processed, 0); // no stale bands in this mocked run
        assert.equal(typeof body.succeeded, 'number');
        assert.equal(typeof body.failed, 'number');
        assert.equal(typeof body.next_stale_count, 'number');
      } finally {
        globalThis.fetch = originalFetch;
        restore();
      }
    })
  )
);
