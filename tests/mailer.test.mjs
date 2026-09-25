// Tests for netlify/functions/_mailer.mjs:
//   - buildBandUpdateEmail: teaser copy contract (name + "was recently
//     updated", no edit details, unsubscribe link present, HTML-escaped)
//   - sendEmail: request shape to Resend, failure contract (never throws)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBandUpdateEmail,
  sendEmail,
  isMailerConfigured,
  MAIL_FROM,
  SITE_URL,
  __setFetchForTests,
  __resetFetchForTests,
} from '../netlify/functions/_mailer.mjs';

const RESEND_KEY = 'RESEND_API_KEY';

function withApiKey(fn) {
  return async () => {
    const before = process.env[RESEND_KEY];
    process.env[RESEND_KEY] = 're_test_key_123';
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env[RESEND_KEY];
      else process.env[RESEND_KEY] = before;
    }
  };
}

function withoutApiKey(fn) {
  return async () => {
    const before = process.env[RESEND_KEY];
    delete process.env[RESEND_KEY];
    try {
      await fn();
    } finally {
      if (before !== undefined) process.env[RESEND_KEY] = before;
    }
  };
}

function okFetch(payload = { id: 'email_123' }) {
  return async () => new Response(JSON.stringify(payload), { status: 200 });
}

test('buildBandUpdateEmail: teaser copy names the band and nothing else', () => {
  const { subject, html, text } = buildBandUpdateEmail({
    bandName: 'Metallica',
    unsubscribeUrl: 'https://sixdegreesofrock.com/api/unsubscribe?token=abc',
  });
  assert.equal(subject, 'Metallica was recently updated');
  assert.match(text, /Metallica was recently updated\./);
  assert.match(html, /Metallica was recently updated\./);
  // No edit details leak into the teaser.
  assert.doesNotMatch(text, /genre|members|label/i);
  // Unsubscribe link present in both bodies.
  assert.ok(text.includes('https://sixdegreesofrock.com/api/unsubscribe?token=abc'));
  assert.ok(html.includes('https://sixdegreesofrock.com/api/unsubscribe?token=abc'));
  // Site link present.
  assert.ok(text.includes(SITE_URL));
});

test('buildBandUpdateEmail: band name is HTML-escaped', () => {
  const { html } = buildBandUpdateEmail({
    bandName: '<script>alert(1)</script>',
    unsubscribeUrl: 'https://example.test/u',
  });
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('isMailerConfigured reflects RESEND_API_KEY presence', async () => {
  await withApiKey(async () => {
    assert.equal(isMailerConfigured(), true);
  })();
  await withoutApiKey(async () => {
    assert.equal(isMailerConfigured(), false);
  })();
});

test('sendEmail: posts the right shape to Resend', withApiKey(async () => {
  let seenUrl, seenInit;
  __setFetchForTests(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(JSON.stringify({ id: 'email_abc' }), { status: 200 });
  });
  try {
    const result = await sendEmail({
      to: 'fan@example.com',
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    });
    assert.equal(result.ok, true);
    assert.equal(result.id, 'email_abc');
    assert.equal(seenUrl, 'https://api.resend.com/emails');
    assert.equal(seenInit.method, 'POST');
    assert.equal(seenInit.headers.Authorization, 'Bearer re_test_key_123');
    const body = JSON.parse(seenInit.body);
    assert.equal(body.from, MAIL_FROM);
    assert.deepEqual(body.to, ['fan@example.com']);
    assert.equal(body.subject, 'S');
  } finally {
    __resetFetchForTests();
  }
}));

test('sendEmail: Resend API error becomes { ok: false } (never throws)', withApiKey(async () => {
  __setFetchForTests(async () => new Response('{"error":"bad"}', { status: 422 }));
  try {
    const result = await sendEmail({ to: 'fan@example.com', subject: 'S', html: 'H', text: 'T' });
    assert.equal(result.ok, false);
    assert.match(result.error, /resend 422/);
  } finally {
    __resetFetchForTests();
  }
}));

test('sendEmail: network failure becomes { ok: false } (never throws)', withApiKey(async () => {
  __setFetchForTests(async () => { throw new Error('socket hang up'); });
  try {
    const result = await sendEmail({ to: 'fan@example.com', subject: 'S', html: 'H', text: 'T' });
    assert.equal(result.ok, false);
    assert.match(result.error, /socket hang up/);
  } finally {
    __resetFetchForTests();
  }
}));

test('sendEmail: missing API key short-circuits without fetching', withoutApiKey(async () => {
  let called = false;
  __setFetchForTests(async () => {
    called = true;
    return okFetch()();
  });
  try {
    const result = await sendEmail({ to: 'fan@example.com', subject: 'S', html: 'H', text: 'T' });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  } finally {
    __resetFetchForTests();
  }
}));

test('sendEmail: invalid recipient is rejected without fetching', withApiKey(async () => {
  let called = false;
  __setFetchForTests(async () => {
    called = true;
    return new Response('{}', { status: 200 });
  });
  try {
    const result = await sendEmail({ to: 'not-an-email', subject: 'S', html: 'H', text: 'T' });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  } finally {
    __resetFetchForTests();
  }
}));
