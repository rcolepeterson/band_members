// Endpoint-level tests for the PR 3b write path:
//   - POST /api/bands            (bands_create.mjs)
//   - PATCH /api/bands/:id       (bands_edit.mjs)
//   - PATCH /api/bands/:id/members (bands_edit_members.mjs)
//   - POST /.netlify/functions/bands (bands.mjs legacy, redirect bridge)
//
// Mirrors tests/bands-neon-endpoint.test.mjs's style: real DB calls are
// avoided by leaning on the auth-before-DB-check ordering (missing token ->
// 401 without ever touching Postgres) and the DB_URL_ENV guard (503 without
// a real connection). The success paths (actual Neon writes) are exercised
// manually against a deploy preview per the existing project convention —
// automating them here would require a live DB or a full mock of
// @neondatabase/serverless, which the codebase has consistently avoided
// (see bands-neon-endpoint.test.mjs's header comment for the same call).
//
// The legacy bands.mjs handler additionally needs a Netlify Blobs
// environment to even reach its method dispatch (getStore() is called
// unconditionally at the top of the handler and throws without one), so the
// legacy-anonymous-POST test below configures a fake Blobs context backed
// by a mocked global fetch. This keeps the test hermetic (no real network
// calls) while still exercising the real handler code path end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setEnvironmentContext } from '@netlify/blobs';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import bandsCreate from '../netlify/functions/bands_create.mjs';
import bandsEdit from '../netlify/functions/bands_edit.mjs';
import bandsEditMembers from '../netlify/functions/bands_edit_members.mjs';
import legacyBands from '../netlify/functions/bands.mjs';

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
// POST /api/bands (bands_create.mjs)
// ============================================================================

test('POST /api/bands returns 401 when no bearer token is provided',
  withoutDb(async () => {
    const r = await bandsCreate(req('POST', {}, { name: 'New Band' }));
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.ok, false);
  })
);

test('POST /api/bands checks auth before DB configuration',
  withoutDb(async () => {
    // No token AND no DB configured -> must be 401, not 503, proving auth
    // is checked first (same ordering discipline as contributions.mjs).
    const r = await bandsCreate(req('POST', {}, { name: 'New Band' }));
    assert.equal(r.status, 401);
  })
);

test('GET /api/bands (wrong method) is rejected with 405 by bands_create.mjs', async () => {
  const r = await bandsCreate(req('GET'));
  assert.equal(r.status, 405);
});

test('PUT /api/bands is rejected with 405 by bands_create.mjs', async () => {
  const r = await bandsCreate(req('PUT', { authorization: 'Bearer sometoken' }));
  assert.equal(r.status, 405);
});

test('POST /api/bands returns 503 when authorized (token present) but DB URL missing',
  withoutDb(async () => {
    const r = await bandsCreate(req('POST', { authorization: 'Bearer sometoken' }, { name: 'New Band' }));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

test('POST /api/bands returns 400 when body is not JSON',
  withFakeDb(async () => {
    const r = await bandsCreate(
      req('POST', { authorization: 'Bearer sometoken', 'content-type': 'application/json' }, 'not json {')
    );
    assert.equal(r.status, 400);
  })
);

test('POST /api/bands returns 400 when band name is empty',
  withFakeDb(async () => {
    const r = await bandsCreate(req('POST', { authorization: 'Bearer sometoken' }, { name: '   ' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'name');
  })
);

test('POST /api/bands returns 400 when name is missing entirely',
  withFakeDb(async () => {
    const r = await bandsCreate(req('POST', { authorization: 'Bearer sometoken' }, {}));
    assert.equal(r.status, 400);
  })
);

// ============================================================================
// PATCH /api/bands/:id (bands_edit.mjs)
// ============================================================================

test('PATCH /api/bands/:id returns 401 when no bearer token is provided',
  withoutDb(async () => {
    const r = await bandsEdit(req('PATCH', {}, { name: 'New Name' }), { params: { id: 'abc-123' } });
    assert.equal(r.status, 401);
  })
);

test('GET /api/bands/:id (wrong method) is rejected with 405 by bands_edit.mjs', async () => {
  const r = await bandsEdit(req('GET'), { params: { id: 'abc-123' } });
  assert.equal(r.status, 405);
});

test('POST /api/bands/:id is rejected with 405 by bands_edit.mjs', async () => {
  const r = await bandsEdit(req('POST', { authorization: 'Bearer sometoken' }), { params: { id: 'abc-123' } });
  assert.equal(r.status, 405);
});

test('PATCH /api/bands/:id returns 400 when no id is present (no context.params, unparseable URL)',
  withoutDb(async () => {
    // Auth passes (token present) so we reach the id check; DB is unset but
    // the id check must trip BEFORE the DB guard, matching this codebase's
    // "cheapest, most caller-visible checks first" convention.
    const r = await bandsEdit(req('PATCH', { authorization: 'Bearer sometoken' }, { name: 'x' }), {});
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'id');
  })
);

test('PATCH /api/bands/:id returns 400 when body is not JSON',
  withFakeDb(async () => {
    const r = await bandsEdit(
      req('PATCH', { authorization: 'Bearer sometoken', 'content-type': 'application/json' }, 'not json {'),
      { params: { id: 'abc-123' } }
    );
    assert.equal(r.status, 400);
  })
);

test('PATCH /api/bands/:id returns 503 when authorized but DB URL missing',
  withoutDb(async () => {
    const r = await bandsEdit(req('PATCH', { authorization: 'Bearer sometoken' }, { name: 'x' }), {
      params: { id: 'abc-123' },
    });
    assert.equal(r.status, 503);
  })
);

test('PATCH /api/bands/:id extracts id from the URL path when context.params is absent',
  withoutDb(async () => {
    const r = await bandsEdit(
      new Request('https://example.test/api/bands/abc-123', {
        method: 'PATCH',
        headers: new Headers({ authorization: 'Bearer sometoken', 'content-type': 'application/json' }),
        body: JSON.stringify({ name: 'x' }),
      }),
      {}
    );
    // No DB configured -> 503, NOT 400 -- proving the id was successfully
    // extracted from the URL path (a 400 "id required" would mean the
    // fallback parser failed).
    assert.equal(r.status, 503);
  })
);

// ============================================================================
// PATCH /api/bands/:id/members (bands_edit_members.mjs)
// ============================================================================

test('PATCH /api/bands/:id/members returns 401 when no bearer token is provided',
  withoutDb(async () => {
    const r = await bandsEditMembers(req('PATCH', {}, { add: [] }), { params: { id: 'abc-123' } });
    assert.equal(r.status, 401);
  })
);

test('GET /api/bands/:id/members (wrong method) is rejected with 405', async () => {
  const r = await bandsEditMembers(req('GET'), { params: { id: 'abc-123' } });
  assert.equal(r.status, 405);
});

test('PATCH /api/bands/:id/members returns 400 when body is not JSON',
  withFakeDb(async () => {
    const r = await bandsEditMembers(
      req('PATCH', { authorization: 'Bearer sometoken', 'content-type': 'application/json' }, 'not json {'),
      { params: { id: 'abc-123' } }
    );
    assert.equal(r.status, 400);
  })
);

test('PATCH /api/bands/:id/members returns 400 when body has no recognized operation arrays',
  withFakeDb(async () => {
    const r = await bandsEditMembers(req('PATCH', { authorization: 'Bearer sometoken' }, {}), {
      params: { id: 'abc-123' },
    });
    assert.equal(r.status, 400);
  })
);

test('PATCH /api/bands/:id/members returns 400 when id is missing',
  withoutDb(async () => {
    const r = await bandsEditMembers(req('PATCH', { authorization: 'Bearer sometoken' }, { add: [{ name: 'x' }] }), {});
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.field, 'id');
  })
);

test('PATCH /api/bands/:id/members returns 503 when authorized with a body but DB URL missing',
  withoutDb(async () => {
    const r = await bandsEditMembers(
      req('PATCH', { authorization: 'Bearer sometoken' }, { add: [{ name: 'New Person' }] }),
      { params: { id: 'abc-123' } }
    );
    assert.equal(r.status, 503);
  })
);

// ============================================================================
// Legacy POST /.netlify/functions/bands (bands.mjs) — migration bridge
// ============================================================================
//
// The legacy handler calls getStore() unconditionally, which throws unless
// a Netlify Blobs environment is configured. We fake one backed by a direct
// edge URL (skipping the signed-URL round trip) and a mocked global fetch,
// so these tests never make a real network call.

function installFakeBlobsEnvironment() {
  setEnvironmentContext({
    siteID: 'test-site',
    token: 'test-token',
    edgeURL: 'https://edge.test',
    uncachedEdgeURL: 'https://edge.test',
  });
}

function mockFetch(existingSubmissions = []) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = (options?.method || 'get').toLowerCase();
    calls.push({ url: String(url), method });
    if (method === 'get') {
      return new Response(JSON.stringify(existingSubmissions), { status: 200 });
    }
    return new Response('', { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('legacy POST /.netlify/functions/bands still works anonymously with the old submission shape', async () => {
  installFakeBlobsEnvironment();
  const before = process.env[DB_URL_ENV];
  delete process.env[DB_URL_ENV]; // anonymous + no DB -> must use the blob path
  const { calls, restore } = mockFetch([]);
  try {
    const r = await legacyBands(
      req('POST', {}, { band: 'Test Band', member: 'Alice', instrument: 'Guitar' })
    );
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.submission.band, 'Test Band');
    assert.equal(body.submission.members[0].member, 'Alice');
    // Confirm it actually went through the blob read-modify-write path (a
    // GET followed by a PUT to the submissions store), not just returned a
    // canned response.
    const putCalls = calls.filter(c => c.method === 'put');
    assert.ok(putCalls.length >= 1, 'expected at least one blob PUT (submissions + audit)');
  } finally {
    restore();
    if (before !== undefined) process.env[DB_URL_ENV] = before;
  }
});

test('legacy POST /.netlify/functions/bands falls back to the blob path when DB is unconfigured even with a token', async () => {
  installFakeBlobsEnvironment();
  const before = process.env[DB_URL_ENV];
  delete process.env[DB_URL_ENV];
  const { calls, restore } = mockFetch([]);
  try {
    const r = await legacyBands(
      req('POST', { authorization: 'Bearer sometoken' }, { band: 'Another Band', member: 'Bob', instrument: 'Bass' })
    );
    // isDbConfigured() is false, so the signed-in Neon branch is skipped
    // entirely and the blob path is used — this must still succeed with a
    // 201, matching the pre-PR-3b response shape.
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.submission.band, 'Another Band');
    const putCalls = calls.filter(c => c.method === 'put');
    assert.ok(putCalls.length >= 1);
  } finally {
    restore();
    if (before !== undefined) process.env[DB_URL_ENV] = before;
  }
});

test('legacy POST /.netlify/functions/bands rejects invalid JSON with 400 regardless of auth', async () => {
  installFakeBlobsEnvironment();
  const { restore } = mockFetch([]);
  try {
    const r = await legacyBands(
      req('POST', { 'content-type': 'application/json' }, 'not json {')
    );
    assert.equal(r.status, 400);
  } finally {
    restore();
  }
});

test('legacy POST /.netlify/functions/bands rejects a missing band name with 400', async () => {
  installFakeBlobsEnvironment();
  const { restore } = mockFetch([]);
  try {
    const r = await legacyBands(req('POST', {}, { band: '   ' }));
    assert.equal(r.status, 400);
  } finally {
    restore();
  }
});

test('legacy GET /.netlify/functions/bands is unaffected by the PR 3b write-path change', async () => {
  installFakeBlobsEnvironment();
  const { restore } = mockFetch([{ id: 'x', band: 'Existing Band', members: [] }]);
  try {
    const r = await legacyBands(req('GET'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.submissions));
  } finally {
    restore();
  }
});

test('legacy POST branches to Neon when signed in, and gracefully falls back to the blob path if the Neon call itself fails', async () => {
  installFakeBlobsEnvironment();
  const before = process.env[DB_URL_ENV];
  // A syntactically valid but unreachable connection string: findUserByToken()
  // will attempt a real HTTP-tunnel call, which our fetch mock intercepts and
  // fails for any non-Blobs-edge URL, simulating "no live DB in this test
  // environment" without actually reaching a network. This proves the
  // signed-in branch is entered (mock sees a call to the Neon API URL) AND
  // that a Neon-side failure still degrades gracefully to a 201 via the blob
  // path, rather than surfacing a 500 to the submitter.
  process.env[DB_URL_ENV] = 'postgresql://fake:fake@fake.neon.tech/fake';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    calls.push({ url: u, method: options?.method });
    if (u.startsWith('https://edge.test')) {
      if ((options?.method || 'get').toLowerCase() === 'get') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('', { status: 200 });
    }
    throw new Error('simulated network failure to Neon (no live DB in this test environment)');
  };
  try {
    const r = await legacyBands(
      req(
        'POST',
        { authorization: 'Bearer sometoken', 'content-type': 'application/json' },
        { band: 'Signed In Band', member: 'Carol', instrument: 'Drums' }
      )
    );
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.submission.band, 'Signed In Band');
    const neonCalls = calls.filter(c => c.url.includes('neon.tech'));
    assert.ok(neonCalls.length >= 1, 'expected the signed-in branch to attempt a Neon call');
    const blobPutCalls = calls.filter(c => c.url.startsWith('https://edge.test') && c.method === 'put');
    assert.ok(blobPutCalls.length >= 1, 'expected fallback to the blob write path after the Neon call failed');
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env[DB_URL_ENV];
    else process.env[DB_URL_ENV] = before;
  }
});
