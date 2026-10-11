// Endpoint-level tests for the new /api/signup, /api/me, /api/contributions,
// and /api/migrate handlers. We test them by calling the exported default
// handler with a mock Request. Real DB calls are avoided by controlling the
// NETLIFY_DATABASE_URL env var: when it's unset the handlers short-circuit
// with 503, which lets us verify the auth/validation/response layer without
// standing up Postgres.
//
// The success path against a live DB is covered by the integration probe I
// run manually against the deploy preview (see PR description). Automating
// that here would require either a real DB per test run (slow, flaky) or a
// full mock of @neondatabase/serverless (a lot of surface for little
// benefit at this stage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import signup from '../netlify/functions/signup.mjs';
import me from '../netlify/functions/me.mjs';
import contributions from '../netlify/functions/contributions.mjs';
import migrate from '../netlify/functions/migrate.mjs';

// Helper: build a plain Request. `body` is stringified if object, sent as-is
// if string, omitted if undefined.
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

// Temporarily unset DB URL so handlers return 503 (this is the "no DB" path).
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

// --- method-not-allowed on wrong verbs --------------------------------------

test('signup rejects GET with 405', async () => {
  const r = await signup(req('GET'));
  assert.equal(r.status, 405);
});

test('me rejects POST with 405', async () => {
  const r = await me(req('POST', {}, {}));
  assert.equal(r.status, 405);
});

test('contributions rejects GET with 405', async () => {
  const r = await contributions(req('GET'));
  assert.equal(r.status, 405);
});

test('migrate rejects GET with 405', async () => {
  const r = await migrate(req('GET'));
  assert.equal(r.status, 405);
});

// --- 503 when the database is not configured --------------------------------

test('signup returns 503 with configuration hint when DB URL missing',
  withoutDb(async () => {
    const r = await signup(req('POST', {}, { email: 'a@b.co', name: 'A B' }));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

test('me returns 401 before checking DB when no bearer token', async () => {
  // With or without DB config, missing token should be 401 (auth is first
  // filter). This test intentionally does not touch DB env.
  const r = await me(req('GET'));
  assert.equal(r.status, 401);
});

test('contributions returns 401 before checking DB when no bearer token', async () => {
  const r = await contributions(req('POST', {}, { action: 'add_band' }));
  assert.equal(r.status, 401);
});

test('migrate returns 401 when no admin token is provided', async () => {
  const r = await migrate(req('POST'));
  assert.equal(r.status, 401);
});

test('migrate returns 401 when the wrong admin token is provided',
  async () => {
    const before = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-token';
    try {
      const r = await migrate(req('POST', { 'x-admin-token': 'wrong-token' }));
      assert.equal(r.status, 401);
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  }
);

// --- signup input validation (still requires DB URL to bypass the 503 guard,
// so we set a fake value; the handler will then try to run SQL which will
// fail cleanly before we get too deep. To keep these tests hermetic we only
// exercise the branches that reject BEFORE any SQL runs.) ---

test('signup returns 400 when body is not JSON', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const r = await signup(req('POST', { 'content-type': 'application/json' }, 'not json {'));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /JSON/);
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

test('signup returns 400 when email is missing or invalid', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const cases = [
      {},
      { name: 'Jane' },
      { email: '', name: 'Jane' },
      { email: 'no-at', name: 'Jane' },
      { email: '   ', name: 'Jane' },
    ];
    for (const body of cases) {
      const r = await signup(req('POST', {}, body));
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const j = await r.json();
      assert.equal(j.field, 'email');
    }
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

// --- sign-up asks for the email only (2026-10-11) --------------------------
// Name, city, state, country and instrument used to be required (PR
// signup-profile-fields). They are optional now: a blank name is made from
// the email, and the profile is filled in later on "Your card" (PATCH
// /api/me). With a fake database the request can't succeed, but it must get
// past validation: no 400 naming any of those fields.

for (const missing of ['name', 'city', 'state', 'country', 'instrument']) {
  test(`signup does not require ${missing}`, async () => {
    process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
    try {
      const r = await signup(req('POST', {}, { email: 'a@b.co' }));
      const j = await r.json();
      if (r.status === 400) assert.notEqual(j.field, missing);
      assert.doesNotMatch(String(j.error || ''), new RegExp(`${missing} is required`));
    } finally {
      delete process.env[DB_URL_ENV];
    }
  });
}

test('an email-only account gets a starting name from the email', async () => {
  const { nameFromEmail } = await import('../netlify/functions/signup.mjs');
  assert.equal(nameFromEmail('jane.doe@example.com'), 'Jane Doe');
  assert.equal(nameFromEmail('vimana17@gmail.com'), 'Vimana17');
  assert.equal(nameFromEmail('rock_n+roll@x.co'), 'Rock N Roll');
  assert.equal(nameFromEmail('@x.co'), 'Rock fan');
});

test('a returning sign-up never blanks a saved profile field', () => {
  const source = readFileSync(new URL('../netlify/functions/signup.mjs', import.meta.url), 'utf8');
  assert.match(source, /city:\s+city\s+\?\? current\.city/);
  assert.match(source, /instrument: instrument \?\? current\.instrument/);
  assert.match(source, /name:\s+normalizeName\(body\.name\) \|\| current\.name/);
});

test('Your card: PATCH /api/me changes only what is sent, and never empties the name', async () => {
  const { profileChanges } = await import('../netlify/functions/me.mjs');
  assert.deepEqual(profileChanges({ city: '  Seattle ', instrument: 'Bass' }).changes, { city: 'Seattle', instrument: 'Bass' });
  assert.deepEqual(profileChanges({ state: '' }).changes, { state: null }, 'an empty field clears it');
  assert.equal(profileChanges({ name: '  ' }).field, 'name');
  assert.ok(profileChanges({}).error, 'nothing to update');
  assert.ok(profileChanges(null).error);
});

test('PATCH /api/me needs a signed-in user', async () => {
  const me = (await import('../netlify/functions/me.mjs')).default;
  const r = await me(req('PATCH', {}, { city: 'Seattle' }));
  assert.equal(r.status, 401);
});

// --- contributions input validation ----------------------------------------

test('contributions returns 400 when action is invalid', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const r = await contributions(
      req('POST', { authorization: 'Bearer sometoken' }, { action: 'delete_band' })
    );
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.field, 'action');
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

test('contributions returns 400 when metadata is not an object', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const r = await contributions(
      req(
        'POST',
        { authorization: 'Bearer sometoken' },
        { action: 'add_band', metadata: 'not-an-object' }
      )
    );
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.field, 'metadata');
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

test('contributions returns 400 when metadata is oversized', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const huge = { blob: 'x'.repeat(10 * 1024) };
    const r = await contributions(
      req(
        'POST',
        { authorization: 'Bearer sometoken' },
        { action: 'add_band', metadata: huge }
      )
    );
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.field, 'metadata');
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

test('contributions rejects when body is not JSON', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const r = await contributions(
      req('POST', { authorization: 'Bearer sometoken', 'content-type': 'application/json' }, 'garbage')
    );
    assert.equal(r.status, 400);
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

// --- email-first sign-in -----------------------------------------------------
//
// A returning visitor is found by email alone, so making them retype name, city,
// state, country and instrument was pure friction. { intent: 'signin' } looks the
// email up and never creates. These stay hermetic by only exercising branches
// that return before any SQL runs.

test('sign-in intent still requires a plausible email', async () => {
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    for (const body of [{ intent: 'signin' }, { intent: 'signin', email: 'nope' }]) {
      const r = await signup(req('POST', { 'content-type': 'application/json' }, body));
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const parsed = await r.json();
      assert.match(parsed.error, /email/);
    }
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

test('sign-in intent does not demand the profile fields', async () => {
  // The whole point: an email on its own must get PAST validation. Without a
  // reachable database it fails later, at the query, which is exactly what
  // proves it cleared the profile checks that a sign-up has to satisfy.
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
  try {
    const r = await signup(req('POST', { 'content-type': 'application/json' },
      { intent: 'signin', email: 'someone@example.com' }));
    assert.notEqual(r.status, 400, 'an email-only sign-in must not be rejected as invalid');
    const parsed = await r.json();
    if (parsed && parsed.error) {
      assert.doesNotMatch(parsed.error, /city|state|country|instrument|name is required/,
        'sign-in must not ask for profile fields');
    }
  } finally {
    delete process.env[DB_URL_ENV];
  }
});

test('the sign-in branch is a lookup, never an insert', () => {
  // Read the source rather than the behaviour: proving "it did not write" against
  // a live database is exactly the test that cannot be hermetic, and an accidental
  // insert here would create an account nobody asked for.
  const source = readFileSync(new URL('../netlify/functions/signup.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("if (body.intent === 'signin')");
  // End at the insert-or-return path, not at the first getSql() -- the sign-in
  // branch makes its own getSql() call, which truncated this slice to nothing and
  // made the assertions below pass vacuously.
  const branch = source.slice(start, source.indexOf('// Insert-or-return semantics', start));
  assert.ok(branch.length > 0, 'expected a sign-in branch before the insert-or-return path');
  assert.doesNotMatch(branch, /insert\s+into/i);
  assert.doesNotMatch(branch, /update\s+users/i);
  // "No account yet" is an answer, not an error: a 404 would log a failure on the
  // happy path of every new visitor.
  assert.match(branch, /ok\(\{ found: false, created: false, user: null \}\)/);
});
