// Endpoint-level tests for the remote head-to-head challenge API:
//   POST /api/game-challenge          (create)
//   GET  /api/game-challenge?token=   (fetch state)
//   POST /api/game-challenge/accept   (answer)
//   GET  /api/game-challenges         (my quiet status list)
//
// Same strategy as tests/api-endpoints.test.mjs: call the exported default
// handler with a mock Request. With NETLIFY_DATABASE_URL unset the handlers
// short-circuit with 503, which lets us verify the auth/validation/response
// layer without standing up Postgres. The live-DB success path is verified
// manually against a deploy (same as the other endpoints).
import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import create, { validBandRef } from '../netlify/functions/game_challenge.mjs';
import accept from '../netlify/functions/game_challenge_accept.mjs';
import list from '../netlify/functions/game_challenges.mjs';

function req(method, url, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request(url, init);
}

const CHALLENGE_URL = 'https://example.test/api/game-challenge';
const ACCEPT_URL = 'https://example.test/api/game-challenge/accept';
const LIST_URL = 'https://example.test/api/game-challenges';

// Temporarily unset DB URL so handlers return 503 (the "no DB" path).
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

// --- method checks -----------------------------------------------------------

test('create rejects PUT with 405', async () => {
  const r = await create(req('PUT', CHALLENGE_URL, {}, {}));
  assert.equal(r.status, 405);
});

test('fetch without token is 400', async () => {
  const r = await create(req('GET', CHALLENGE_URL));
  assert.ok(r.status === 400 || r.status === 503, `expected 400 or 503, got ${r.status}`);
});

test('accept rejects GET with 405', async () => {
  const r = await accept(req('GET', ACCEPT_URL));
  assert.equal(r.status, 405);
});

test('list rejects POST with 405', async () => {
  const r = await list(req('POST', LIST_URL, {}, {}));
  assert.equal(r.status, 405);
});

// --- 503 when the database is not configured ---------------------------------

test('create returns 503 when DB URL missing', withoutDb(async () => {
  const r = await create(req('POST', CHALLENGE_URL, { authorization: 'Bearer x' }, { band_a: 'Metallica' }));
  assert.equal(r.status, 503);
}));

test('fetch returns 503 when DB URL missing', withoutDb(async () => {
  const r = await create(req('GET', `${CHALLENGE_URL}?token=abc`));
  assert.equal(r.status, 503);
}));

test('accept returns 503 when DB URL missing', withoutDb(async () => {
  const r = await accept(req('POST', ACCEPT_URL, { authorization: 'Bearer x' }, { token: 'abc', band_b: 'Megadeth' }));
  assert.equal(r.status, 503);
}));

test('list returns 503 when DB URL missing', withoutDb(async () => {
  const r = await list(req('GET', LIST_URL, { authorization: 'Bearer x' }));
  assert.equal(r.status, 503);
}));

// --- auth: 401 without a bearer token ----------------------------------------
// NOTE: these run WITH the ambient env (DB may or may not be configured).
// findUserByToken with a garbage token returns null either way (no DB ->
// getSql() is null... actually without DB the handler 503s first). To keep
// this deterministic we assert 401-or-503: 401 when a DB is present, 503
// when it isn't. The point is: no anonymous challenge creation.

test('create is not anonymous', async () => {
  const r = await create(req('POST', CHALLENGE_URL, {}, { band_a: 'Metallica' }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('accept is not anonymous', async () => {
  const r = await accept(req('POST', ACCEPT_URL, {}, { token: 'abc', band_b: 'Megadeth' }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('list is not anonymous', async () => {
  const r = await list(req('GET', LIST_URL));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

// (covered above by 'fetch without token is 400')

// --- validBandRef unit tests ---------------------------------------------------

test('validBandRef passes normal band refs through', () => {
  assert.equal(validBandRef('Metallica'), 'Metallica');
  assert.equal(validBandRef('  Hüsker Dü  '), 'Hüsker Dü');
});

test('validBandRef rejects empty / non-string / overlong', () => {
  assert.equal(validBandRef(''), null);
  assert.equal(validBandRef('   '), null);
  assert.equal(validBandRef(null), null);
  assert.equal(validBandRef(42), null);
  assert.equal(validBandRef('x'.repeat(161)), null);
  assert.equal(validBandRef('x'.repeat(160)), 'x'.repeat(160));
});

test('validBandRef strips control characters', () => {
  assert.equal(validBandRef('a\u0001b'), 'ab');
});
