// One reminder pipe for every 6* game: builders, signup, confirm, send,
// cap, schedules, unsubscribe. Mirrors tests/daily-reminder.test.mjs:
// the preview/email is the part nobody on the team sees while working on
// it, so its properties are checked here.
//
// What this locks in:
//   1. Each game's email: right subject, right play link, a per-game
//      unsubscribe — and Rawkle's number is epoch math only, so the
//      email can never name (or leak) the band.
//   2. Signup is single opt-in: submit confirms at once, the welcome
//      email goes out, and the row is immediately sendable; a confirmed
//      address isn't re-mailed, and a failed welcome send still leaves
//      the signup standing.
//   3. The send: one per address per game per day, never twice, capped,
//      dry runs send nothing, a failed send releases its claim.
//   4. The schedules: Rawkle 8:30, cards 9:00 Pacific, half an hour apart
//      and after Daily's 8:00 — nobody gets three emails at once.
//   5. Unsubscribe stops that game only and forgets the email.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GAMES,
  rawklePuzzleNumber,
  buildGameReminderEmail,
  buildGameReminderWelcomeEmail,
  gameReminderUnsubscribeUrl,
  validateGameReminderEmail,
  signUpForGameReminder,
  confirmGameReminder,
  runGameReminders,
  GAME_REMINDER_SEND_CAP,
  __resetGameReminderSchemaForTests,
} from '../netlify/functions/_game_reminders.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const pipeSrc = read('../netlify/functions/_game_reminders.mjs');

// A tagged-template stand-in for Neon: answers by query text, records writes.
function fakeSql({ recipients = [], rows = [], alreadyClaimed = [] } = {}) {
  const log = new Set(alreadyClaimed);
  const store = new Map(rows.map((r) => [`${r.email}|${r.game}`, { ...r }]));
  const sql = async (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('create table')) return [];
    if (q.includes('insert into game_reminder_log')) {
      const key = `${values[0]}|${values[1]}|${values[2]}`;
      if (log.has(key)) return [];
      log.add(key);
      return [{ email: values[0] }];
    }
    if (q.includes('delete from game_reminder_log')) {
      log.delete(`${values[0]}|${values[1]}|${values[2]}`);
      return [];
    }
    if (q.includes('update game_reminders set confirmed_at')) {
      for (const r of store.values()) {
        if (r.confirm_token === values[0]) {
          r.confirmed_at = r.confirmed_at || new Date().toISOString();
          return [{ email: r.email, game: r.game }];
        }
      }
      return [];
    }
    if (q.includes('insert into game_reminders')) {
      // The signup writes confirmed_at = now(): single opt-in, so the
      // stored row is immediately sendable.
      store.set(`${values[0]}|${values[1]}`, {
        email: values[0], game: values[1], confirm_token: values[2],
        unsubscribe_token: values[3], confirmed_at: new Date().toISOString(), confirm_sent_at: new Date().toISOString(),
      });
      return [];
    }
    if (q.includes('from game_reminders')) {
      if (q.includes('confirmed_at is not null')) return recipients;
      return store.has(`${values[0]}|${values[1]}`) ? [store.get(`${values[0]}|${values[1]}`)] : [];
    }
    return [];
  };
  return { sql, log, store };
}

test('Rawkle numbers count from launch day, exactly like the game', () => {
  assert.equal(rawklePuzzleNumber('2026-10-23'), 1);
  assert.equal(rawklePuzzleNumber('2026-10-24'), 2);
  assert.equal(rawklePuzzleNumber('2026-10-31'), 9); // matches the frozen schedule's #9
  assert.equal(rawklePuzzleNumber('bogus'), null);
});

test('each game email: right subject, play link, per-game unsubscribe, no band data', () => {
  assert.ok(!pipeSrc.includes('SCHEDULE'), 'the pipe must never see the answer list');
  const unsub = gameReminderUnsubscribeUrl('rawkle', 'tok');
  assert.ok(unsub.startsWith('https://sixdegreesofrock.com/api/unsubscribe?token='), unsub);
  assert.ok(unsub.endsWith('&list=rawkle'), unsub);
  const r = buildGameReminderEmail('rawkle', { date: '2026-10-24', unsubscribeUrl: unsub });
  assert.equal(r.subject, "Today's Rawkle is live");
  assert.ok(r.text.startsWith('Rawkle #2 is up. One famous band, six tries.\nPlay: https://sixdegreesofrock.com/rawkle'));
  assert.ok(r.text.includes(unsub));
  const c = buildGameReminderEmail('cards', { date: '2026-10-24', unsubscribeUrl: gameReminderUnsubscribeUrl('cards', 'tok') });
  assert.equal(c.subject, 'The cards are on the table');
  assert.ok(c.text.startsWith('The Six Degrees card game is ready when you are. Deal a hand.\nPlay: https://sixdegreesofrock.com/cards'));
  assert.ok(c.text.includes('list=cards'));
  const welcome = buildGameReminderWelcomeEmail('rawkle', { confirmUrl: 'https://sixdegreesofrock.com/api/game-reminder-signup?confirm=abc', unsubscribeUrl: unsub });
  assert.equal(welcome.subject, 'Your daily Rawkle reminder is on');
  assert.ok(welcome.text.includes('One email each morning when the new Rawkle is live.'));
  assert.ok(welcome.text.includes('Play: https://sixdegreesofrock.com/rawkle'));
  assert.ok(welcome.text.includes('https://sixdegreesofrock.com/api/game-reminder-signup?confirm=abc'));
  assert.ok(welcome.html.includes('href="https://sixdegreesofrock.com/api/game-reminder-signup?confirm=abc"'));
  assert.ok(welcome.text.includes(unsub));
  assert.ok(welcome.text.includes("Didn't ask for this? Stop these emails."));
  assert.ok(welcome.html.includes("Didn’t ask for this?"));
  assert.ok(welcome.html.includes('Stop these emails'));
  const welcomeCards = buildGameReminderWelcomeEmail('cards', { confirmUrl: 'https://sixdegreesofrock.com/api/game-reminder-signup?confirm=abc', unsubscribeUrl: gameReminderUnsubscribeUrl('cards', 'tok') });
  assert.equal(welcomeCards.subject, 'Your daily card game reminder is on');
  assert.ok(welcomeCards.text.includes('One email each morning to deal a hand.'));
  assert.ok(welcomeCards.text.includes('list=cards'));
});

test('validation rejects what cannot be mailed', () => {
  for (const bad of ['nope', 'a@b', 'x@guest.local', 'x@instagram.local', '']) {
    assert.ok(validateGameReminderEmail(bad), JSON.stringify(bad));
  }
  assert.equal(validateGameReminderEmail('a@b.com'), null);
});

test('signup is single opt-in, never re-mails a confirmed address', async () => {
  __resetGameReminderSchemaForTests();
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true }; };
  const { sql, store } = fakeSql();
  const first = await signUpForGameReminder(sql, { email: 'a@b.com', game: 'rawkle', send });
  assert.equal(first.status, 'subscribed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Your daily Rawkle reminder is on');
  assert.ok(sent[0].text.includes('Play: https://sixdegreesofrock.com/rawkle'));
  assert.ok(sent[0].text.includes('/api/game-reminder-signup?confirm='), 'welcome keeps the optional confirm link');
  assert.ok(sent[0].text.includes('list=rawkle'), 'welcome carries the one-click unsubscribe');
  // The row is confirmed at once, so it is immediately sendable.
  const row = store.get('a@b.com|rawkle');
  assert.ok(row.confirmed_at, 'confirmed_at is set on submit');
  // Confirming via the old link still works, then signing up again
  // does not re-mail.
  const confirmed = await confirmGameReminder(sql, row.confirm_token);
  assert.equal(confirmed.email, 'a@b.com');
  const again = await signUpForGameReminder(sql, { email: 'a@b.com', game: 'rawkle', send });
  assert.equal(again.status, 'already_on');
  assert.equal(sent.length, 1);
  // A bad token confirms nothing.
  assert.equal(await confirmGameReminder(sql, 'nope'), null);
  // An old unconfirmed row re-submits into subscribed, not check_email.
  const { sql: sql2, store: store2 } = fakeSql({ rows: [{ email: 'c@d.com', game: 'cards', confirm_token: 'old', unsubscribe_token: 'old-u', confirmed_at: null, confirm_sent_at: new Date().toISOString() }] });
  const sent2 = [];
  const send2 = async (m) => { sent2.push(m); return { ok: true }; };
  const resub = await signUpForGameReminder(sql2, { email: 'c@d.com', game: 'cards', send: send2 });
  assert.equal(resub.status, 'subscribed');
  assert.equal(sent2.length, 1);
  assert.ok(store2.get('c@d.com|cards').confirmed_at, 're-submit confirms the old row');
  // A failed welcome send still leaves the signup standing.
  const { sql: sql3 } = fakeSql();
  const failed = await signUpForGameReminder(sql3, { email: 'e@f.com', game: 'rawkle', send: async () => ({ ok: false, error: 'resend 500' }) });
  assert.equal(failed.status, 'subscribed');
});

test('the send: one each, never twice, capped, dry runs send nothing', async () => {
  __resetGameReminderSchemaForTests();
  const mk = (email) => ({ email, unsubscribe_token: 't-' + email });
  const { sql } = fakeSql({
    recipients: [mk('a@b.com'), mk('b@c.com'), mk('x@instagram.local')],
    alreadyClaimed: ['b@c.com|rawkle|2026-10-24'],
  });
  const sent = [];
  const summary = await runGameReminders(sql, 'rawkle', {
    date: '2026-10-24',
    sendEmail: async (m) => { sent.push(m.to); return { ok: true }; },
  });
  assert.deepEqual(sent, ['a@b.com']);
  assert.equal(summary.sent, 1);

  assert.equal(GAME_REMINDER_SEND_CAP, 200);
  __resetGameReminderSchemaForTests();
  const many = Array.from({ length: GAME_REMINDER_SEND_CAP + 5 }, (_, i) => mk(`u${i}@b.com`));
  let sends = 0;
  const dry = await runGameReminders(fakeSql({ recipients: many }).sql, 'cards', {
    date: '2026-10-24', dryRun: true, sendEmail: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(dry.considered, many.length);
  assert.equal(sends, 0);
  const real = await runGameReminders(fakeSql({ recipients: many }).sql, 'cards', {
    date: '2026-10-24', sendEmail: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(real.sent, GAME_REMINDER_SEND_CAP);
  assert.equal(real.capped, 5);
});

test('a failed send is not counted against the day', async () => {
  __resetGameReminderSchemaForTests();
  const { sql, log } = fakeSql({ recipients: [{ email: 'a@b.com', unsubscribe_token: 't' }] });
  const summary = await runGameReminders(sql, 'rawkle', {
    date: '2026-10-24', sendEmail: async () => ({ ok: false, error: 'resend 500' }),
  });
  assert.equal(summary.failed, 1);
  assert.ok(!log.has('a@b.com|rawkle|2026-10-24'), 'the claim was released');
});

test('schedules stagger the three morning reminders; unsubscribe stops one game only', () => {
  assert.match(read('../netlify/functions/cron_rawkle_reminder.mjs'), /schedule: '30 15 \* \* \*'/);
  assert.match(read('../netlify/functions/cron_cards_reminder.mjs'), /schedule: '0 16 \* \* \*'/);
  const unsub = read('../netlify/functions/unsubscribe.mjs');
  assert.match(unsub, /gameList = \(list === 'rawkle' \|\| list === 'cards'\)/);
  assert.match(unsub, /delete from game_reminders where unsubscribe_token/);
  assert.match(unsub, /No more Rawkle reminders\./);
  assert.match(unsub, /No more card game reminders\./);
  assert.ok(GAMES.rawkle && GAMES.cards, 'both games are rows in one pipe');
});
