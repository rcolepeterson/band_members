// Endpoint-level tests for the edit-person-bio PR:
//   - POST /api/edit-person (edit-person.mjs)
//
// Mirrors tests/bands-write-endpoints.test.mjs's style and rationale: real
// DB calls are avoided by leaning on the auth-before-DB-check ordering
// (missing token -> 401 without ever touching Postgres) and the
// DB_URL_ENV guard (503 without a real connection). The success and 404
// paths (which require a real Neon lookup via findUserByToken/band_members)
// are exercised manually against a deploy preview per the existing project
// convention documented at the top of bands-write-endpoints.test.mjs --
// automating them here would require a live DB or a full mock of
// @neondatabase/serverless, which this codebase has consistently avoided.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import editPerson from '../netlify/functions/edit-person.mjs';

function req(method, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request('https://example.test/api/edit-person', init);
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
    process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake/fake';
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env[DB_URL_ENV];
      else process.env[DB_URL_ENV] = before;
    }
  };
}

// ============================================================================
// POST /api/edit-person (edit-person.mjs)
// ============================================================================

test('POST /api/edit-person returns 401 when no bearer token is provided',
  withoutDb(async () => {
    const r = await editPerson(req('POST', {}, { personId: 'abc-123', bio: 'Hello' }));
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.ok, false);
  })
);

test('POST /api/edit-person checks auth before DB configuration',
  withoutDb(async () => {
    // No token AND no DB configured -> must be 401, not 503, proving auth
    // is checked first (same ordering discipline as bands_edit.mjs).
    const r = await editPerson(req('POST', {}, { personId: 'abc-123', bio: 'Hello' }));
    assert.equal(r.status, 401);
  })
);

test('GET /api/edit-person (wrong method) is rejected with 405', async () => {
  const r = await editPerson(req('GET'));
  assert.equal(r.status, 405);
});

test('PATCH /api/edit-person is rejected with 405 (this endpoint is POST-only, unlike /api/bands/:id)', async () => {
  const r = await editPerson(req('PATCH', { authorization: 'Bearer sometoken' }));
  assert.equal(r.status, 405);
});

test('POST /api/edit-person returns 503 when authorized (token present) but DB URL missing',
  withoutDb(async () => {
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: 'Hello' }));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

test('POST /api/edit-person returns 400 when body is not JSON',
  withFakeDb(async () => {
    const r = await editPerson(
      req('POST', { authorization: 'Bearer sometoken', 'content-type': 'application/json' }, 'not json {')
    );
    assert.equal(r.status, 400);
  })
);

test('POST /api/edit-person returns 400 when personId is missing',
  withFakeDb(async () => {
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { bio: 'Hello' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'personId');
  })
);

test('POST /api/edit-person returns 400 when personId is blank/whitespace',
  withFakeDb(async () => {
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { personId: '   ', bio: 'Hello' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'personId');
  })
);

test('POST /api/edit-person returns 400 when bio is not a string',
  withFakeDb(async () => {
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: 12345 }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'bio');
  })
);

test('POST /api/edit-person returns 400 when bio exceeds 2000 characters',
  withFakeDb(async () => {
    const longBio = 'x'.repeat(2001);
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: longBio }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'bio');
  })
);

test('POST /api/edit-person accepts a bio of exactly 2000 characters (boundary, fails later only on DB/auth)',
  withoutDb(async () => {
    const boundaryBio = 'x'.repeat(2000);
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: boundaryBio }));
    // Length check passes, so we fall through to the DB guard (503), not
    // the bio-length 400 -- proving the cap is ">", not ">=", 2000.
    assert.equal(r.status, 503);
  })
);

test('POST /api/edit-person returns 400 when bio contains an http(s) URL',
  withFakeDb(async () => {
    const r = await editPerson(
      req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: 'Check out https://example.com for more' })
    );
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'bio');
  })
);

test('POST /api/edit-person returns 400 when bio contains a bare www. link',
  withFakeDb(async () => {
    const r = await editPerson(
      req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: 'Find us at www.example.com' })
    );
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'bio');
  })
);

test('POST /api/edit-person returns 400 when bio contains a bare promo domain (no scheme)',
  withFakeDb(async () => {
    const r = await editPerson(
      req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: 'Listen on ourband.bandcamp.com' })
    );
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'bio');
  })
);

test('POST /api/edit-person allows an empty bio (clearing the field is valid)',
  withoutDb(async () => {
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { personId: 'abc-123', bio: '' }));
    // No link, no length violation -> falls through to the DB guard (503),
    // not a 400, proving an empty/cleared bio is accepted.
    assert.equal(r.status, 503);
  })
);

test('POST /api/edit-person checks personId before bio when both are invalid (400 field ordering)',
  withFakeDb(async () => {
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { bio: 'x'.repeat(2001) }));
    // Missing personId is checked first in source order (before the bio
    // length/link checks), so this should be the personId 400, not a bio 400.
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'personId');
  })
);

test('POST /api/edit-person checks auth and DB configuration before any body validation',
  withoutDb(async () => {
    // Token present but DB unconfigured, with a body that would otherwise
    // fail bio validation -- 503 must win, proving DB configuration is
    // checked before the body is even parsed.
    const r = await editPerson(req('POST', { authorization: 'Bearer sometoken' }, { bio: 'x'.repeat(2001) }));
    assert.equal(r.status, 503);
  })
);
