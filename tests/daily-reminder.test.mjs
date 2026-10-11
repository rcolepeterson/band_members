// 6° daily puzzle reminder (Cole, 2026-10-11): opt-in only, one email per
// user per day, never guests, skip anyone who already played, one-tap
// unsubscribe that stops reminders only. See netlify/functions/_daily_reminder.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDailyReminderEmail,
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
  assert.match(q, /!isPlaceholderEmail\(r\.email\)/);
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
  assert.match(link, /if \(!isSignedIn\(\)\) return null;/, 'never for guests');
  assert.match(link, /Email me when it\\u2019s live/);
  assert.match(link, /hidden>/, 'hidden until the server says reminders are off');
  assert.match(link, /if \(on === false\) p\.hidden = false;/);
  // Both finished screens (won, and out of moves / gave up) carry it, daily only.
  const calls = engine.match(/finish\.appendChild\(nextChainCountdownEl\(\)\);\n\s*const remind = reminderLinkEl\(\);/g) || [];
  assert.equal(calls.length, 2);
});
