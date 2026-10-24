// Tests for the onboarding email (thank-you from Aaron):
//   - copy variants (blast 200 credits / drip 100 credits), links, from-line
//   - recipient selection (drip 48–72h window, blast everyone; placeholders out)
//   - send → grant → log flow, prefs/opt-out honoring, never-throw contract
//
// Pure helpers are unit-tested directly. DB-touching paths use a fake `sql`
// template tag; the live-DB path is verified manually after deploy (same as
// the other endpoints).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOnboardingEmail,
  selectRecipients,
  sendOnboardingEmail,
  runOnboarding,
  BLAST_CREDITS,
  DRIP_CREDITS,
  FROM_LINE,
  PLAY_URL,
} from '../netlify/functions/_onboarding.mjs';

// --- copy ---

test('blast copy: 200 credits, founding framing, play + add links', () => {
  const { subject, text, html, credits } = buildOnboardingEmail({
    handle: 'aaron',
    kind: 'blast',
    unsubscribeUrl: 'https://example.test/unsub?token=abc',
  });
  assert.equal(credits, 200);
  assert.equal(BLAST_CREDITS, 200);
  assert.equal(subject, 'A thank-you from Aaron');
  assert.match(text, /first people in/, 'founding framing');
  assert.match(text, /200 bonus credits/, 'credit amount');
  assert.match(text, /20 Ask-the-tree lifelines/, 'concrete lifeline math');
  assert.ok(text.includes(PLAY_URL), 'play link');
  assert.ok(text.includes('https://sixdegreesofrock.com/'), 'add-band link');
  assert.ok(text.includes('https://example.test/unsub?token=abc'), 'unsubscribe');
  assert.match(text, /— Aaron/, 'signed');
  assert.ok(html.includes('200 bonus credits'), 'html carries the amount');
  assert.ok(html.includes(PLAY_URL), 'html carries the play link');
});

test('drip copy: 100 credits, no founding framing', () => {
  const { text, credits } = buildOnboardingEmail({
    handle: 'newfan',
    kind: 'drip',
    unsubscribeUrl: 'https://example.test/unsub?token=xyz',
  });
  assert.equal(credits, 100);
  assert.equal(DRIP_CREDITS, 100);
  assert.match(text, /100 bonus credits/);
  assert.match(text, /10 Ask-the-tree lifelines/);
  assert.ok(!text.includes('first people in'), 'no founding framing on the drip');
});

test('from-line is Aaron on the verified domain', () => {
  assert.ok(FROM_LINE.startsWith('Aaron'), 'display name is Aaron');
  assert.ok(FROM_LINE.includes('updates@sixdegreesofrock.com'), 'verified sender domain kept');
});

// --- selection ---

// Minimal fake for the neon `sql` template tag: records the query text and
// returns canned rows. ensureNotifyPrefs (called by sendOnboardingEmail)
// gets a healthy prefs row unless overridden.
function makeSql({ prefs = null, rows = [] } = {}) {
  const calls = [];
  const healthy = {
    user_id: 'u1',
    email_enabled: true,
    unsubscribed_at: null,
    unsubscribe_token: 'tok123',
    email_onboarding: true,
  };
  const sql = (strings, ...vals) => {
    const text = strings.join('?');
    calls.push({ text, vals });
    if (text.includes('from notification_prefs')) return Promise.resolve([prefs || healthy]);
    if (text.includes('from users')) return Promise.resolve(rows);
    return Promise.resolve([]);
  };
  return { sql, calls };
}

test('drip selection uses the 48–72h window; blast takes everyone unmailed', async () => {
  const { sql, calls } = makeSql({ rows: [] });
  await selectRecipients(sql, 'drip');
  const q = calls.find((c) => c.text.includes('from users')).text;
  assert.match(q, /72 hours/, 'drip looks back 72h');
  assert.match(q, /48 hours/, 'drip excludes the fresh 48h');
  assert.match(q, /onboarding_emails/, 'already-mailed excluded');

  const b = makeSql({ rows: [] });
  await selectRecipients(b.sql, 'blast');
  const bq = b.calls.find((c) => c.text.includes('from users')).text;
  assert.ok(!bq.includes('72 hours'), 'blast has no age window');
  assert.match(bq, /onboarding_emails/, 'already-mailed excluded');
});

test('placeholder (IG OAuth) emails are filtered from recipients', async () => {
  const rows = [
    { id: 'u1', email: 'real@example.com', handle: 'aaron' },
    { id: 'u2', email: 'ig-28297232353237029@instagram.local', handle: '@vimana17' },
  ];
  const { sql } = makeSql({ rows });
  const out = await selectRecipients(sql, 'blast');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'u1');
});

// --- send → grant → log ---

const USER = { id: 'u1', email: 'real@example.com', handle: 'aaron' };

test('send grants credits, logs, and uses the from-line', async () => {
  const { sql, calls } = makeSql();
  const sent = [];
  const r = await sendOnboardingEmail(sql, USER, 'blast', {
    sendEmail: async (args) => {
      sent.push(args);
      return { ok: true };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.credits, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'real@example.com');
  assert.equal(sent[0].from, FROM_LINE);
  const grant = calls.find((c) => c.text.includes('update users set credits'));
  assert.ok(grant, 'credits granted');
  assert.equal(grant.vals[0], 200, 'blast grants 200');
  const log = calls.find((c) => c.text.includes('into onboarding_emails'));
  assert.ok(log, 'send logged');
  assert.deepEqual([log.vals[1], log.vals[2]], ['blast', 200], 'kind + amount logged');
});

test('drip grants 100', async () => {
  const { sql, calls } = makeSql();
  const r = await sendOnboardingEmail(sql, USER, 'drip', {
    sendEmail: async () => ({ ok: true }),
  });
  assert.equal(r.ok, true);
  const grant = calls.find((c) => c.text.includes('update users set credits'));
  assert.equal(grant.vals[0], 100, 'drip grants 100');
});

test('unsubscribed and opted-out users are skipped, never mailed', async () => {
  for (const prefs of [
    { email_enabled: false, unsubscribed_at: null, unsubscribe_token: 't', email_onboarding: true },
    { email_enabled: true, unsubscribed_at: '2026-01-01', unsubscribe_token: 't', email_onboarding: true },
    { email_enabled: true, unsubscribed_at: null, unsubscribe_token: 't', email_onboarding: false },
  ]) {
    const { sql } = makeSql({ prefs });
    let mailed = false;
    const r = await sendOnboardingEmail(sql, USER, 'blast', {
      sendEmail: async () => {
        mailed = true;
        return { ok: true };
      },
    });
    assert.equal(r.ok, false);
    assert.ok(r.skipped, 'marked skipped');
    assert.equal(mailed, false, 'no mail sent');
  }
});

test('a mail failure skips the grant and never throws', async () => {
  const { sql, calls } = makeSql();
  const r = await sendOnboardingEmail(sql, USER, 'blast', {
    sendEmail: async () => ({ ok: false, error: 'resend 500' }),
  });
  assert.equal(r.ok, false);
  assert.ok(!calls.some((c) => c.text.includes('update users set credits')), 'no grant on failure');
  assert.ok(!calls.some((c) => c.text.includes('into onboarding_emails')), 'no log on failure');
});

test('a throwing db never escapes sendOnboardingEmail', async () => {
  const sql = () => Promise.reject(new Error('db down'));
  const r = await sendOnboardingEmail(sql, USER, 'blast', {
    sendEmail: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /db down/);
});

test('runOnboarding refuses without a mailer and touches nothing', async () => {
  const before = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    let touched = false;
    const sql = () => {
      touched = true;
      return Promise.resolve([]);
    };
    const r = await runOnboarding(sql, 'blast');
    assert.equal(r.ok, false);
    assert.equal(touched, false, 'no db access without a mailer');
  } finally {
    if (before !== undefined) process.env.RESEND_API_KEY = before;
  }
});
