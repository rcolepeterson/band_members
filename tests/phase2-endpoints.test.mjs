// Endpoint-level tests for the Phase 2 per-user endpoints:
//   - GET/PATCH /api/notification-prefs (notification_prefs.mjs)
//   - GET/POST/DELETE /api/bands/:id/follow (follows.mjs)
//
// Mirrors tests/bands-write-endpoints.test.mjs's style: real DB calls are
// avoided by leaning on the auth-before-DB-check ordering (missing token ->
// 401 without ever touching Postgres) and the DB_URL_ENV guard (503 without
// a real connection). The success paths are exercised manually against a
// deploy preview per the existing project convention.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import notificationPrefs from '../netlify/functions/notification_prefs.mjs';
import follows from '../netlify/functions/follows.mjs';
import memberFollows from '../netlify/functions/member-follows.mjs';
import unsubscribe from '../netlify/functions/unsubscribe.mjs';
import resendWebhook from '../netlify/functions/resend_webhook.mjs';

function req(method, path, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers.set('content-type', 'application/json');
  }
  return new Request(`https://example.test${path}`, init);
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

const ctx = (id) => ({ params: { id } });

// --- notification-prefs -------------------------------------------------

test('notification-prefs: GET without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await notificationPrefs(req('GET', '/api/notification-prefs'));
  assert.equal(res.status, 401);
}));

test('notification-prefs: PATCH without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await notificationPrefs(req('PATCH', '/api/notification-prefs', {}, { email_enabled: false }));
  assert.equal(res.status, 401);
}));

test('notification-prefs: PUT -> 405', withoutDb(async () => {
  const res = await notificationPrefs(
    req('PUT', '/api/notification-prefs', { authorization: 'Bearer tok' })
  );
  assert.equal(res.status, 405);
}));

test('notification-prefs: GET with token but no DB -> 503', withoutDb(async () => {
  const res = await notificationPrefs(
    req('GET', '/api/notification-prefs', { authorization: 'Bearer tok' })
  );
  assert.equal(res.status, 503);
}));

test('notification-prefs: PATCH with token but no DB -> 503', withoutDb(async () => {
  const res = await notificationPrefs(
    req('PATCH', '/api/notification-prefs', { authorization: 'Bearer tok' }, { email_enabled: true })
  );
  assert.equal(res.status, 503);
}));

// --- follows ------------------------------------------------------------

test('follows: GET without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await follows(req('GET', '/api/bands/abc/follow'), ctx('abc'));
  assert.equal(res.status, 401);
}));

test('follows: POST without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await follows(req('POST', '/api/bands/abc/follow'), ctx('abc'));
  assert.equal(res.status, 401);
}));

test('follows: DELETE without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await follows(req('DELETE', '/api/bands/abc/follow'), ctx('abc'));
  assert.equal(res.status, 401);
}));

test('follows: PUT -> 405', withoutDb(async () => {
  const res = await follows(
    req('PUT', '/api/bands/abc/follow', { authorization: 'Bearer tok' }),
    ctx('abc')
  );
  assert.equal(res.status, 405);
}));

test('follows: GET with token but no DB -> 503', withoutDb(async () => {
  const res = await follows(
    req('GET', '/api/bands/abc/follow', { authorization: 'Bearer tok' }),
    ctx('abc')
  );
  assert.equal(res.status, 503);
}));

test('follows: missing band id -> 400', withoutDb(async () => {
  const res = await follows(
    req('GET', '/api/bands//follow', { authorization: 'Bearer tok' }),
    { params: {} }
  );
  assert.equal(res.status, 400);
}));

test('follows: band id extracted from URL when context.params is absent', withoutDb(async () => {
  // Auth passes, id parses from the path, then the DB guard fires 503 —
  // proving extraction didn't 400.
  const res = await follows(
    req('GET', '/api/bands/some-uuid/follow', { authorization: 'Bearer tok' }),
    {}
  );
  assert.equal(res.status, 503);
}));

// --- unsubscribe ------------------------------------------------------

test('unsubscribe: POST -> 405', async () => {
  const res = await unsubscribe(req('POST', '/api/unsubscribe?token=abc'));
  assert.equal(res.status, 405);
});

test('unsubscribe: missing token renders the "doesn\'t look right" page, not an error', async () => {
  const res = await unsubscribe(req('GET', '/api/unsubscribe'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('doesn\u2019t look right'));
  assert.doesNotMatch(html, /stack|Error:/);
});

test('unsubscribe: bad token renders the not-found page without enumerating users', withoutDb(async () => {
  // No DB configured -> the "give us a moment" page (still 200, still no
  // leak about whether the token ever existed).
  const res = await unsubscribe(req('GET', '/api/unsubscribe?token=nope'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('You\u2019re unsubscribed.'));
}));

// --- resend-webhook ---------------------------------------------------

test('resend-webhook: GET -> 405', async () => {
  const res = await resendWebhook(req('GET', '/api/resend-webhook'));
  assert.equal(res.status, 405);
});

test('resend-webhook: without the secret configured it is inert (200, skipped)', async () => {
  const before = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    const res = await resendWebhook(req('POST', '/api/resend-webhook', {}, { type: 'email.complained' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.skipped, 'webhook secret not configured');
  } finally {
    if (before !== undefined) process.env.RESEND_WEBHOOK_SECRET = before;
  }
});

test('resend-webhook: bad signature -> 401', async () => {
  const before = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('test-secret-1234567890').toString('base64');
  try {
    const res = await resendWebhook(
      req('POST', '/api/resend-webhook', {
        'svix-id': 'msg_1',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,badsignature',
      }, { type: 'email.complained' })
    );
    assert.equal(res.status, 401);
  } finally {
    if (before === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = before;
  }
});

// --- member follows -----------------------------------------------------

test('member-follows: GET without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await memberFollows(req('GET', '/api/members/abc/follow'), ctx('abc'));
  assert.equal(res.status, 401);
}));

test('member-follows: POST without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await memberFollows(req('POST', '/api/members/abc/follow'), ctx('abc'));
  assert.equal(res.status, 401);
}));

test('member-follows: DELETE without token -> 401 (auth before DB)', withoutDb(async () => {
  const res = await memberFollows(req('DELETE', '/api/members/abc/follow'), ctx('abc'));
  assert.equal(res.status, 401);
}));

test('member-follows: PUT -> 405', withoutDb(async () => {
  const res = await memberFollows(
    req('PUT', '/api/members/abc/follow', { authorization: 'Bearer tok' }),
    ctx('abc')
  );
  assert.equal(res.status, 405);
}));

test('member-follows: GET with token but no DB -> 503', withoutDb(async () => {
  const res = await memberFollows(
    req('GET', '/api/members/abc/follow', { authorization: 'Bearer tok' }),
    ctx('abc')
  );
  assert.equal(res.status, 503);
}));

test('member-follows: missing member id -> 400', withoutDb(async () => {
  const res = await memberFollows(
    req('GET', '/api/members//follow', { authorization: 'Bearer tok' }),
    { params: {} }
  );
  assert.equal(res.status, 400);
}));

test('member-follows: member id extracted from URL when context.params is absent', withoutDb(async () => {
  const res = await memberFollows(
    req('GET', '/api/members/some-uuid/follow', { authorization: 'Bearer tok' }),
    {}
  );
  assert.equal(res.status, 503);
}));
