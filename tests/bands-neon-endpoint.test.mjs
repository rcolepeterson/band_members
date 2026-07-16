// Endpoint-level tests for the new /api/bands (bands_neon.mjs) and
// /api/seed-bands (seed_bands.mjs) handlers, mirroring the style of
// tests/api-endpoints.test.mjs. Real DB calls are avoided the same way:
// when NETLIFY_DATABASE_URL is unset the handlers short-circuit with 503,
// which lets us verify the method/auth layer without standing up Postgres.
//
// The success path (200 with real rows) against a live DB is covered by
// manual verification against the deploy preview once migrate + seed have
// run there — see the PR description. Automating that here would require
// either a real DB per test run or a full mock of
// @neondatabase/serverless, neither of which is warranted at this stage
// (same rationale as api-endpoints.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import bandsNeon from '../netlify/functions/bands_neon.mjs';
import seedBands from '../netlify/functions/seed_bands.mjs';

function req(method, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request('https://example.test/api', init);
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

// --- GET /api/bands ----------------------------------------------------------

test('GET /api/bands returns 503 with configuration hint when DB URL missing',
  withoutDb(async () => {
    const r = await bandsNeon(req('GET'));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

test('POST /api/bands is rejected with 405 (write path is PR 3b)', async () => {
  const r = await bandsNeon(req('POST', {}, { name: 'New Band' }));
  assert.equal(r.status, 405);
  const body = await r.json();
  assert.equal(body.ok, false);
});

test('PUT /api/bands is rejected with 405', async () => {
  const r = await bandsNeon(req('PUT'));
  assert.equal(r.status, 405);
});

test('DELETE /api/bands is rejected with 405', async () => {
  const r = await bandsNeon(req('DELETE'));
  assert.equal(r.status, 405);
});

// GET is public (no auth required) — confirm the handler doesn't 401 before
// hitting the DB guard. Without a DB configured, the first thing to trip
// should be the 503, never a 401, proving no auth check gates this route.
test('GET /api/bands never returns 401 (public read, no auth required)',
  withoutDb(async () => {
    const r = await bandsNeon(req('GET'));
    assert.notEqual(r.status, 401);
    assert.equal(r.status, 503);
  })
);

// --- POST /api/seed-bands -----------------------------------------------------

test('POST /api/seed-bands returns 401 when no admin token is provided', async () => {
  const r = await seedBands(req('POST', {}, { rows: [] }));
  assert.equal(r.status, 401);
});

test('POST /api/seed-bands returns 401 when the wrong admin token is provided', async () => {
  const before = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'correct-token';
  try {
    const r = await seedBands(req('POST', { 'x-admin-token': 'wrong-token' }, { rows: [] }));
    assert.equal(r.status, 401);
  } finally {
    if (before === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = before;
  }
});

test('GET /api/seed-bands is rejected with 405 regardless of auth', async () => {
  const r = await seedBands(req('GET'));
  assert.equal(r.status, 405);
});

test('DELETE /api/seed-bands is rejected with 405', async () => {
  const r = await seedBands(req('DELETE'));
  assert.equal(r.status, 405);
});

test('POST /api/seed-bands returns 503 when authorized but DB URL missing',
  withoutDb(async () => {
    const before = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-token';
    try {
      const r = await seedBands(req('POST', { 'x-admin-token': 'correct-token' }, { rows: [] }));
      assert.equal(r.status, 503);
      const body = await r.json();
      assert.ok(body.hint.includes(DB_URL_ENV));
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  })
);

test('POST /api/seed-bands returns 400 when body is not JSON', async () => {
  const before = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'correct-token';
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const r = await seedBands(
      req('POST', { 'x-admin-token': 'correct-token', 'content-type': 'application/json' }, 'not json {')
    );
    assert.equal(r.status, 400);
  } finally {
    if (before === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = before;
    delete process.env[DB_URL_ENV];
  }
});

test('POST /api/seed-bands returns 400 when body.rows is missing or not an array', async () => {
  const before = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'correct-token';
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const cases = [{}, { rows: 'not-an-array' }, { rows: null }];
    for (const body of cases) {
      const r = await seedBands(req('POST', { 'x-admin-token': 'correct-token' }, body));
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const j = await r.json();
      assert.equal(j.field, 'rows');
    }
  } finally {
    if (before === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = before;
    delete process.env[DB_URL_ENV];
  }
});

// Auth is checked BEFORE the DB guard, mirroring migrate.mjs's ordering
// (unauthenticated callers should not learn whether the DB is configured).
test('POST /api/seed-bands checks admin auth before DB configuration',
  withoutDb(async () => {
    const r = await seedBands(req('POST', {}, { rows: [] }));
    assert.equal(r.status, 401);
  })
);
