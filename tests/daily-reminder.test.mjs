// 6° daily puzzle reminder (Cole, 2026-10-11): opt-in only, one email per
// user per day, never guests, skip anyone who already played, one-tap
// unsubscribe that stops reminders only. See netlify/functions/_daily_reminder.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDailyReminderEmail,
  buildReminderConfirmEmail,
  selectReminderRecipients,
  reminderUnsubscribeUrl,
  runDailyReminders,
  REMINDER_SEND_CAP,
  __resetReminderSchemaForTests,
} from '../netlify/functions/_daily_reminder.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const reminderSrc = read('../netlify/functions/_daily_reminder.mjs');

// A tagged-template stand-in for Neon: answers by query text, records writes.
function fakeSql({ recipients = [], alreadyClaimed = [] } = {}) {
  const log = new Set(alreadyClaimed);
  const calls = [];
  const sql = async (strings, ...values) => {
    const q = strings.join('?');
    calls.push(q);
    if (q.includes('information_schema.columns')) return [{ '?column?': 1 }];
    if (q.includes('create table')) return [];
    if (q.includes('from users u')) return recipients;
    if (q.includes('insert into daily_reminder_log')) {
      if (log.has(values[0])) return [];
      log.add(values[0]);
      return [{ user_id: values[0] }];
    }
    if (q.includes('delete from daily_reminder_log')) { log.delete(values[0]); return []; }
    return [];
  };
  return { sql, log, calls };
}

const user = (id, email = `${id}@example.com`) => ({ id, email, unsubscribe_token: `tok-${id}` });

test('the email: short, on brand, a Play link and a reminders-only unsubscribe', () => {
  const unsub = reminderUnsubscribeUrl('abc');
  assert.equal(unsub, 'https://sixdegreesofrock.com/api/unsubscribe?token=abc&list=daily');
  const { subject, text, html } = buildDailyReminderEmail({ date: '2026-10-12', unsubscribeUrl: unsub });
  assert.equal(subject, 'Today’s 6° puzzle is live');
  const [line1, line2] = text.split('\n');
  assert.equal(line1, '6° Rock #13 is up. Two bands, one chain to find.');
  assert.equal(line2, 'Play: https://sixdegreesofrock.com/game/');
  assert.ok(text.includes(unsub));
  assert.ok(html.includes('href="https://sixdegreesofrock.com/game/"'));
  assert.ok(html.includes('token=abc&amp;list=daily'));
  assert.doesNotMatch(subject + text + html, /Daily Chain/);
});

test('who gets it: opted in, not a guest, not reminded today, not already playing', () => {
  const q = reminderSrc.match(/export async function selectReminderRecipients[\s\S]*?\n\}\n/)[0];
  assert.match(q, /p\.email_daily_reminder = true/);
  assert.match(q, /u\.is_guest = false/);
  assert.match(q, /from daily_reminder_log l where l\.user_id = u\.id and l\.chain_date = \$\{date\}/);
  assert.match(q, /from daily_runs r where r\.user_id = u\.id and r\.chain_date = \$\{date\}/);
  assert.match(q, /isPlaceholderEmail\(r\.email\)\) return false;/);
  // Guests count only after confirming, with the same skip-if-played rule.
  assert.match(q, /from guest_reminders g\s+where g\.confirmed_at is not null/);
  assert.match(q, /from daily_runs r where r\.user_id = g\.user_id and r\.chain_date = \$\{date\}/);
});

test('the opt-in defaults to off', () => {
  for (const src of [reminderSrc, read('../netlify/functions/migrate.mjs')]) {
    assert.match(src, /add column if not exists email_daily_reminder boolean not null default false/);
  }
});

test('sends one each, never twice in a day, and skips Instagram placeholder addresses', async () => {
  __resetReminderSchemaForTests();
  const { sql } = fakeSql({
    recipients: [user('a'), user('b'), user('ig', 'x@instagram.local')],
    alreadyClaimed: ['b'],
  });
  const sent = [];
  const summary = await runDailyReminders(sql, {
    date: '2026-10-12',
    sendEmail: async (m) => { sent.push(m.to); return { ok: true }; },
  });
  assert.deepEqual(sent, ['a@example.com']);
  assert.equal(summary.sent, 1);
});

test('a failed send is not counted against the day', async () => {
  __resetReminderSchemaForTests();
  const { sql, log } = fakeSql({ recipients: [user('a')] });
  const summary = await runDailyReminders(sql, {
    date: '2026-10-12',
    sendEmail: async () => ({ ok: false, error: 'resend 500' }),
  });
  assert.equal(summary.failed, 1);
  assert.ok(!log.has('a'), 'the claim was released');
});

test('a dry run sends nothing; the cap stops a runaway', async () => {
  __resetReminderSchemaForTests();
  const many = Array.from({ length: REMINDER_SEND_CAP + 5 }, (_, i) => user(`u${i}`));
  let sends = 0;
  const dry = await runDailyReminders(fakeSql({ recipients: many }).sql, {
    date: '2026-10-12', dryRun: true, sendEmail: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(dry.considered, many.length);
  assert.equal(sends, 0);
  const real = await runDailyReminders(fakeSql({ recipients: many }).sql, {
    date: '2026-10-12', sendEmail: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(real.sent, REMINDER_SEND_CAP);
  assert.equal(real.capped, 5);
});

test('runs every morning Pacific, after the puzzle has turned over', () => {
  assert.match(read('../netlify/functions/cron_daily_reminder.mjs'), /schedule: '0 15 \* \* \*'/);
  assert.match(read('../netlify/functions/cron_daily_reminder_trigger.mjs'), /if \(!isAdminAuthorized\(req\)\) return unauthorized\(\);/);
});

test('the unsubscribe link in a reminder stops reminders only', () => {
  const src = read('../netlify/functions/unsubscribe.mjs');
  assert.match(src, /dailyOnly = params\.get\('list'\) === 'daily';/);
  const branch = src.match(/if \(dailyOnly\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(branch, /set email_daily_reminder = false/);
  assert.doesNotMatch(branch, /email_enabled/);
});

test('the account menu toggle reads and saves daily_reminder', () => {
  const prefs = read('../netlify/functions/notification_prefs.mjs');
  assert.match(prefs, /daily_reminder: prefs\.email_daily_reminder === true/);
  assert.match(prefs, /if \(typeof body\.daily_reminder === 'boolean'\) patch\.daily_reminder = body\.daily_reminder;/);
  const home = read('../index.html');
  assert.match(home, /<input type="checkbox" id="user-card-reminder-toggle" \/>\s*<span>Remind me daily<\/span>/);
  assert.match(home, /saveNotifyPref\(\{ daily_reminder: on \}\)/);
  assert.match(home, /reminder\.checked = prefs\.daily_reminder === true;/);
});

test('the game asks once, after a finished puzzle, signed-in players only', () => {
  const engine = read('../scripts/six-degrees-game.mjs');
  assert.match(engine, /\} else if \(!practiceMode && shouldAskForReminder\(\)\) \{/);
  assert.match(engine, /Want a reminder tomorrow\?/);
  const ask = engine.match(/function shouldAskForReminder\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(ask, /isSignedIn\(\) && !localStorage\.getItem\(REMINDER_PROMPT_KEY\)/);
  assert.match(engine, /body: JSON\.stringify\(\{ daily_reminder: true \}\)/);
});

test('under the countdown: "Email me when it\'s live" until they opt in', () => {
  const engine = read('../scripts/six-degrees-game.mjs');
  const link = engine.match(/function reminderLinkEl\(\) \{[\s\S]*?\n  \}\n/)[0];
  // Guests get an email box on tap instead (2026-10-15).
  assert.match(link, /if \(practiceMode \|\| guestReminderAsked\(\)\) return null;/);
  assert.match(link, /const form = guestReminderFormEl\(''\);/);
  assert.match(link, /Email me when it\\u2019s live/);
  assert.match(link, /hidden>/, 'hidden until the server says reminders are off');
  assert.match(link, /if \(on === false\) p\.hidden = false;/);
  // Both finished screens (won, and out of moves / gave up) carry it, daily only.
  const calls = engine.match(/finish\.appendChild\(nextChainCountdownEl\(\)\);\n\s*const remind = reminderLinkEl\(\);/g) || [];
  assert.equal(calls.length, 2);
});

// --- Guests (Cole, 2026-10-15): reminder with just an email, double opt-in.
import { signUp, confirmUrlFor, CONFIRM_RESEND_MS } from '../netlify/functions/reminder_signup.mjs';

function guestSql({ guest = { id: 'g1' }, existing = null } = {}) {
  const writes = [];
  const sql = async (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('from users where guest_session_id')) return guest ? [guest] : [];
    if (q.includes('insert into users')) { writes.push(['user', ...values]); return [{ id: 'made' }]; }
    if (q.includes('select * from guest_reminders')) return existing ? [existing] : [];
    if (q.includes('insert into guest_reminders')) { writes.push(values); return []; }
    return [];
  };
  return { sql, writes };
}

test('a guest gets a confirmation email first, nothing else', async () => {
  const { sql, writes } = guestSql();
  const sent = [];
  const r = await signUp(sql, { email: 'fan@example.com', guestSessionId: 'g_abc12345', send: async (m) => { sent.push(m); return { ok: true }; } });
  assert.equal(r.status, 'check_email');
  assert.equal(writes.length, 1, 'saved unconfirmed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'fan@example.com');
  assert.equal(sent[0].subject, 'Confirm your daily 6° reminder');
  assert.ok(sent[0].text.includes(confirmUrlFor(writes[0][2])), 'the link carries the saved confirm token');
});

test('signing up before ever playing (/remind/) makes the guest row first', async () => {
  const { sql, writes } = guestSql({ guest: null });
  const r = await signUp(sql, { email: 'a@b.co', guestSessionId: 'g_new12345', send: async () => ({ ok: true }) });
  assert.equal(r.status, 'check_email');
  assert.equal(writes[0][0], 'user', 'a guest row like the game makes');
  assert.equal(writes[0][1], 'g_new12345');
  assert.equal(writes[1][0], 'made', 'the reminder hangs off that row');
});

test('no repeat confirmation inside the hour', async () => {
  let sends = 0;
  const recent = { email: 'a@b.co', confirm_sent_at: new Date(Date.now() - 60_000).toISOString(), confirmed_at: null };
  assert.equal((await signUp(guestSql({ existing: recent }).sql, { email: 'a@b.co', guestSessionId: 'g_x', send: async () => { sends += 1; return { ok: true }; } })).status, 'check_email');
  const on = { email: 'a@b.co', confirmed_at: new Date().toISOString() };
  assert.equal((await signUp(guestSql({ existing: on }).sql, { email: 'a@b.co', guestSessionId: 'g_x', send: async () => { sends += 1; return { ok: true }; } })).status, 'already_on');
  assert.equal(sends, 0);
  assert.equal(CONFIRM_RESEND_MS, 3600000);
});

test('a confirmed guest is a recipient; an address is emailed once even if it is both', async () => {
  __resetReminderSchemaForTests();
  const sql = async (strings) => {
    const q = strings.join('?');
    if (q.includes('from users u')) return [user('a', 'fan@example.com')];
    if (q.includes('from guest_reminders g')) return [{ id: 'g1', email: 'FAN@example.com', unsubscribe_token: 't1' }, { id: 'g2', email: 'guest@example.com', unsubscribe_token: 't2' }];
    return [];
  };
  const rows = await selectReminderRecipients(sql, '2026-10-15');
  assert.deepEqual(rows.map((r) => r.id), ['a', 'g2']);
});

test('the confirm email and the unsubscribe that forgets a guest', () => {
  const { text, html } = buildReminderConfirmEmail({ confirmUrl: 'https://x/confirm' });
  assert.ok(text.includes('https://x/confirm') && html.includes('href="https://x/confirm"'));
  assert.match(text, /Didn't ask for this\? Ignore it/);
  const unsub = read('../netlify/functions/unsubscribe.mjs');
  assert.match(unsub, /if \(!rows\.length && dailyOnly\) \{[\s\S]*?delete from guest_reminders where unsubscribe_token = \$\{token\}/);
  const signup = read('../netlify/functions/reminder_signup.mjs');
  assert.match(signup, /bucket: `reminder-signup:ip:\$\{clientIp\(req\)\}`, limit: 5/);
  assert.match(signup, /domain\.endsWith\('\.local'\)/, 'never our own placeholder addresses');
  assert.match(read('../netlify/functions/migrate.mjs'), /create table if not exists guest_reminders/);
  assert.match(read('../privacy.html'), /Daily puzzle reminder\./);
});

test('the game offers guests the email box once, after a daily', () => {
  const engine = read('../scripts/six-degrees-game.mjs');
  assert.match(engine, /if \(!practiceMode && shouldAskGuestForReminder\(\)\) \{[\s\S]{0,120}guestReminderFormEl\('Or just get a reminder tomorrow:'\)/);
  assert.match(engine, /await dailyFetch\('\/api\/reminder-signup', \{ method: 'POST', body: JSON\.stringify\(\{ email \}\) \}\);/);
  assert.match(engine, /Check your email and tap the link to start your reminders\./);
});
