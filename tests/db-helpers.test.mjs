// Unit tests for the pure helpers in netlify/functions/_db.mjs.
// Everything covered here is dependency-free (no DB required).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DB_URL_ENV,
  isDbConfigured,
  json,
  ok,
  badRequest,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  generateToken,
  normalizeEmail,
  normalizeName,
  normalizeCity,
  normalizeState,
  normalizeCountry,
  normalizeInstrument,
  isPlausibleEmail,
} from '../netlify/functions/_db.mjs';

// --- env-config helpers -----------------------------------------------------

test('isDbConfigured is true when NETLIFY_DATABASE_URL is set', () => {
  const before = process.env[DB_URL_ENV];
  process.env[DB_URL_ENV] = 'postgresql://x:y@z/db';
  try {
    assert.equal(isDbConfigured(), true);
  } finally {
    if (before === undefined) delete process.env[DB_URL_ENV];
    else process.env[DB_URL_ENV] = before;
  }
});

test('isDbConfigured is false when NETLIFY_DATABASE_URL is missing or empty', () => {
  const before = process.env[DB_URL_ENV];
  delete process.env[DB_URL_ENV];
  try {
    assert.equal(isDbConfigured(), false);
    process.env[DB_URL_ENV] = '';
    assert.equal(isDbConfigured(), false);
  } finally {
    if (before === undefined) delete process.env[DB_URL_ENV];
    else process.env[DB_URL_ENV] = before;
  }
});

// --- JSON response builders -------------------------------------------------

test('json() returns a Response with correct status, body, and no-store cache header', async () => {
  const res = json(418, { teapot: true });
  assert.equal(res.status, 418);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body, { teapot: true });
});

test('ok/badRequest/unauthorized/notFound/methodNotAllowed/serverError/dbUnavailable produce expected shapes', async () => {
  const okRes = ok({ foo: 1 });
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { ok: true, foo: 1 });

  const bad = badRequest('bad thing', { field: 'x' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: 'bad thing', field: 'x' });

  const unauth = unauthorized();
  assert.equal(unauth.status, 401);
  assert.deepEqual(await unauth.json(), { ok: false, error: 'unauthorized' });

  const notAllowed = methodNotAllowed();
  assert.equal(notAllowed.status, 405);

  const serverErr = serverError('boom', { message: 'why' });
  assert.equal(serverErr.status, 500);
  assert.deepEqual(await serverErr.json(), { ok: false, error: 'boom', message: 'why' });

  const dbErr = dbUnavailable();
  assert.equal(dbErr.status, 503);
  const dbBody = await dbErr.json();
  assert.equal(dbBody.ok, false);
  assert.equal(dbBody.error, 'database not configured');
  assert.ok(dbBody.hint.includes(DB_URL_ENV), 'hint should reference the env var name');
});

// --- bearer token extraction ------------------------------------------------

test('extractBearerToken returns the token string on valid header', () => {
  const req = { headers: new Headers({ authorization: 'Bearer abc.def-ghi_123' }) };
  assert.equal(extractBearerToken(req), 'abc.def-ghi_123');
});

test('extractBearerToken is case-insensitive on the scheme', () => {
  const req = { headers: new Headers({ authorization: 'bearer xyz' }) };
  assert.equal(extractBearerToken(req), 'xyz');
});

test('extractBearerToken returns empty string on missing or malformed header', () => {
  assert.equal(extractBearerToken({ headers: new Headers() }), '');
  assert.equal(extractBearerToken({ headers: new Headers({ authorization: 'Basic abc' }) }), '');
  assert.equal(extractBearerToken({}), '');
});

// --- token generation -------------------------------------------------------

test('generateToken returns a base64url string with at least 40 chars of entropy', () => {
  const t = generateToken();
  assert.equal(typeof t, 'string');
  assert.ok(t.length >= 40, `expected long token, got length ${t.length}`);
  assert.match(t, /^[A-Za-z0-9_-]+$/, 'token must be base64url-safe (no +/=)');
});

test('generateToken produces unique values across many calls', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(generateToken());
  assert.equal(seen.size, 100, 'tokens should be unique');
});

// --- normalizers ------------------------------------------------------------

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM  '), 'foo@bar.com');
  assert.equal(normalizeEmail('a+b@x.io'), 'a+b@x.io');
});

test('normalizeEmail handles non-strings safely', () => {
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(42), '');
});

test('normalizeName trims and collapses whitespace and caps length', () => {
  assert.equal(normalizeName('  Jane   Doe  '), 'Jane Doe');
  const huge = 'a'.repeat(500);
  assert.equal(normalizeName(huge).length, 100);
});

test('isPlausibleEmail accepts obvious valid addresses', () => {
  for (const e of ['a@b.co', 'jane.doe+tag@example.com', 'x@y']) {
    assert.equal(isPlausibleEmail(e), true, `expected ${e} plausible`);
  }
});

test('isPlausibleEmail rejects obvious garbage', () => {
  for (const e of ['', 'a', 'no-at-sign', '@leading', 'trailing@', undefined, null, 42]) {
    assert.equal(isPlausibleEmail(e), false, `expected ${JSON.stringify(e)} rejected`);
  }
});

// --- profile-field normalizers (signup-profile-fields) ---------------------
// All four share the same shape (trim + collapse whitespace + length-cap), so
// this is one parameterized suite instead of four near-identical blocks.
const PROFILE_NORMALIZERS = [
  { name: 'normalizeCity',       fn: normalizeCity,       cap: 80 },
  { name: 'normalizeState',      fn: normalizeState,      cap: 80 },
  { name: 'normalizeCountry',    fn: normalizeCountry,    cap: 80 },
  { name: 'normalizeInstrument', fn: normalizeInstrument, cap: 60 },
];

for (const { name, fn, cap } of PROFILE_NORMALIZERS) {
  test(`${name} trims and collapses whitespace`, () => {
    assert.equal(fn('  Seattle  '), 'Seattle');
    assert.equal(fn('San   Francisco'), 'San Francisco');
  });

  test(`${name} caps length at ${cap}`, () => {
    const huge = 'a'.repeat(cap * 3);
    assert.equal(fn(huge).length, cap);
  });

  test(`${name} handles non-strings safely`, () => {
    assert.equal(fn(undefined), '');
    assert.equal(fn(null), '');
    assert.equal(fn(42), '');
  });

  test(`${name} preserves non-ASCII characters`, () => {
    // Postgres text column stores UTF-8 and we don't want to strip diacritics.
    // Explicit test so a future "clean up" refactor doesn't silently do so.
    assert.equal(fn('  Zürich  '), 'Zürich');
    assert.equal(fn('  São Paulo  '), 'São Paulo');
  });
}

test('normalizeInstrument accepts the "Music listener" non-player option', () => {
  // This is a copy contract: the client placeholder + server error message
  // both point users to enter "Music listener" or "Music connoisseur" when
  // they don't play. The normalizer must let those pass through unchanged.
  assert.equal(normalizeInstrument('Music listener'),     'Music listener');
  assert.equal(normalizeInstrument('Music connoisseur'),  'Music connoisseur');
});
