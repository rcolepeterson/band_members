// Tests for netlify/functions/_notify.mjs:
//   - unsubscribeUrlFor shape
//   - ensureNotifyPrefs: lazy row creation, token backfill
//   - getTouchedRecipients: actor exclusion + source unions in the query
//   - notifyBandTouched: opt-outs honored, 24h cooldown, actor never
//     emailed, daily cap, send failures don't throw, mailer-unconfigured
//     short-circuit
//
// The Neon's sql tagged-template is faked: handlers match on the query
// text and return canned rows. No DB, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unsubscribeUrlFor,
  ensureNotifyPrefs,
  getTouchedRecipients,
  notifyBandTouched,
  DAILY_SEND_CAP,
} from '../netlify/functions/_notify.mjs';
import { SITE_URL } from '../netlify/functions/_mailer.mjs';

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

// Minimal fake for the neon sql`` tagged template. Handlers are
// [substring, rows-or-fn] pairs matched against the joined query text.
function fakeSql(handlers) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    for (const [match, result] of handlers) {
      if (text.includes(match)) {
        return Promise.resolve(typeof result === 'function' ? result(values, calls) : result);
      }
    }
    throw new Error('unexpected query: ' + text.slice(0, 160));
  };
  sql.calls = calls;
  return sql;
}

function silentMailer() {
  const sent = [];
  return {
    sent,
    async sendEmail({ to, subject, html, text }) {
      sent.push({ to, subject, html, text });
      return { ok: true, id: 'email_1' };
    },
  };
}

test('unsubscribeUrlFor points at /api/unsubscribe with the token', () => {
  const url = unsubscribeUrlFor('tok_abc-123');
  assert.equal(url, `${SITE_URL}/api/unsubscribe?token=tok_abc-123`);
});

test('ensureNotifyPrefs creates a row with a token when missing', async () => {
  const sql = fakeSql([
    ['from notification_prefs', []],
    ['insert into notification_prefs', (values) => [
      { user_id: values[0], email_enabled: true, unsubscribed_at: null, unsubscribe_token: values[1] },
    ]],
  ]);
  const prefs = await ensureNotifyPrefs(sql, 'user-1');
  assert.equal(prefs.email_enabled, true);
  assert.equal(prefs.unsubscribed_at, null);
  assert.ok(typeof prefs.unsubscribe_token === 'string' && prefs.unsubscribe_token.length > 20);
});

test('ensureNotifyPrefs returns the existing row untouched when present', async () => {
  const existing = { user_id: 'user-1', email_enabled: false, unsubscribed_at: '2026-01-01', unsubscribe_token: 'tok' };
  const sql = fakeSql([['from notification_prefs', [existing]]]);
  const prefs = await ensureNotifyPrefs(sql, 'user-1');
  assert.deepEqual(prefs, existing);
  assert.ok(!sql.calls.some((c) => c.text.includes('insert into notification_prefs')));
});

test('ensureNotifyPrefs backfills a missing token on an old row', async () => {
  const old = { user_id: 'user-1', email_enabled: true, unsubscribed_at: null, unsubscribe_token: null };
  const sql = fakeSql([
    ['from notification_prefs', [old]],
    ['update notification_prefs', (values) => [
      { ...old, unsubscribe_token: values[0] },
    ]],
  ]);
  const prefs = await ensureNotifyPrefs(sql, 'user-1');
  assert.ok(typeof prefs.unsubscribe_token === 'string' && prefs.unsubscribe_token.length > 20);
});

test('getTouchedRecipients excludes the actor and unions all touch sources', async () => {
  const sql = fakeSql([['from users u', [{ id: 'u2', email: 'b@x.com', name: 'B' }]]]);
  const rows = await getTouchedRecipients(sql, 'band-uuid-1', 'actor-uuid');
  assert.deepEqual(rows, [{ id: 'u2', email: 'b@x.com', name: 'B' }]);
  const q = sql.calls[0].text;
  assert.ok(q.includes('u.id <>'), 'actor exclusion');
  assert.ok(q.includes('added_by'), 'creator source');
  assert.ok(q.includes('edited_by'), 'editor source');
  assert.ok(q.includes('contributions'), 'contributions source');
  assert.ok(q.includes('band_follows'), 'follows source');
});

test('notifyBandTouched: happy path emails opted-in touchers, honors cooldown + opt-out', withApiKey(async () => {
  const mailer = silentMailer();
  const logInserts = [];
  const sql = fakeSql([
    ['select count(*)', [{ n: 0 }]],
    ['from users u', [
      { id: 'u-in', email: 'in@x.com', name: 'In' },
      { id: 'u-out', email: 'out@x.com', name: 'Out' },
      { id: 'u-cool', email: 'cool@x.com', name: 'Cool' },
    ]],
    // ensureNotifyPrefs per user
    ['from notification_prefs', (values) => {
      const uid = values[0];
      if (uid === 'u-out') return [{ user_id: uid, email_enabled: false, unsubscribed_at: '2026-01-01', unsubscribe_token: 't-out' }];
      return [{ user_id: uid, email_enabled: true, unsubscribed_at: null, unsubscribe_token: 't-' + uid }];
    }],
    // cooldown check: u-cool was emailed recently
    ['band_notification_log\n    where band_id', (values) => (values[1] === 'u-cool' ? [{ '1': 1 }] : [])],
    ['insert into band_notification_log', (values) => { logInserts.push(values); return []; }],
  ]);
  const result = await notifyBandTouched(sql, {
    bandId: 'band-1',
    bandName: 'Soundgarden',
    actorUserId: 'actor-1',
    mailer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.deepEqual(mailer.sent.map((s) => s.to), ['in@x.com']);
  assert.equal(mailer.sent[0].subject, 'Soundgarden was recently updated');
  assert.ok(mailer.sent[0].text.includes('/api/unsubscribe?token=t-u-in'));
  assert.equal(logInserts.length, 1);
  assert.equal(logInserts[0][1], 'u-in');
}));

test('notifyBandTouched: mailer unconfigured short-circuits with no sends', withoutApiKey(async () => {
  const mailer = silentMailer();
  const sql = fakeSql([]);
  const result = await notifyBandTouched(sql, {
    bandId: 'band-1',
    bandName: 'Nirvana',
    actorUserId: 'actor-1',
    mailer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 'mailer not configured');
  assert.equal(mailer.sent.length, 0);
  assert.equal(sql.calls.length, 0);
}));

test('notifyBandTouched: daily cap reached skips everything', withApiKey(async () => {
  const mailer = silentMailer();
  const sql = fakeSql([['select count(*)', [{ n: DAILY_SEND_CAP }]]]);
  const result = await notifyBandTouched(sql, {
    bandId: 'band-1',
    bandName: 'Pearl Jam',
    actorUserId: 'actor-1',
    mailer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 'daily cap');
  assert.equal(mailer.sent.length, 0);
}));

test('notifyBandTouched: send failure is logged, not thrown, and not counted', withApiKey(async () => {
  const logInserts = [];
  const mailer = { sent: [], async sendEmail({ to }) { this.sent.push(to); return { ok: false, error: 'resend 500' }; } };
  const sql = fakeSql([
    ['select count(*)', [{ n: 0 }]],
    ['from users u', [{ id: 'u1', email: 'a@x.com', name: 'A' }]],
    ['from notification_prefs', [{ user_id: 'u1', email_enabled: true, unsubscribed_at: null, unsubscribe_token: 't1' }]],
    ['band_notification_log\n    where band_id', []],
    ['insert into band_notification_log', (values) => { logInserts.push(values); return []; }],
  ]);
  const result = await notifyBandTouched(sql, {
    bandId: 'band-1',
    bandName: 'Alice in Chains',
    actorUserId: 'actor-1',
    mailer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(logInserts.length, 0, 'failed sends are not logged (retry on next edit)');
}));

test('notifyBandTouched: DB explosion still resolves (never throws)', withApiKey(async () => {
  const sql = () => Promise.reject(new Error('db is on fire'));
  const result = await notifyBandTouched(sql, {
    bandId: 'band-1',
    bandName: 'Bauhaus',
    actorUserId: 'actor-1',
    mailer: silentMailer(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
}));
