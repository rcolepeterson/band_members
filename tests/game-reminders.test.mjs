// One reminder pipe for every 6* game: builders, signup, confirm, send,
// cap, schedules, unsubscribe. Mirrors tests/daily-reminder.test.mjs:
// the preview/email is the part nobody on the team sees while working on
// it, so its properties are checked here.
//
// What this locks in:
//   1. Each game's email: right subject, right play link, a per-game
//      unsubscribe — and Rawkle's number is epoch math only, so the
//      email can never name (or leak) the band.
//   2. Signup is double opt-in: nothing sends until the link is clicked;
//      a confirmed address isn't re-mailed; a recent unconfirmed one
//      isn't spammed with a second confirmation.
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
  buildGameReminderConfirmEmail,
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
      store.set(`${values[0]}|${values[1]}`, {
        email: values[0], game: values[1], confirm_token: values[2],
        unsubscribe_token: values[3], confirmed_at: null, confirm_sent_at: new Date().toISOString(),
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
  const conf = buildGameReminderConfirmEmail('rawkle', { confirmUrl: 'https://sixdegreesofrock.com/api/game-reminder-signup?confirm=abc' });
  assert.equal(conf.subject, 'Confirm your daily Rawkle reminder');
  assert.ok(conf.text.includes("Didn't ask for this?"));
});

test('validation rejects what cannot be mailed', () => {
  for (const bad of ['nope', 'a@b', 'x@guest.local', 'x@instagram.local', '']) {
    assert.ok(validateGameReminderEmail(bad), JSON.stringify(bad));
  }
  assert.equal(validateGameReminderEmail('a@b.com'), null);
});

test('signup is double opt-in, never re-mails a confirmed address', async () => {
  __resetGameReminderSchemaForTests();
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true }; };
  const { sql, store } = fakeSql();
  const first = await signUpForGameReminder(sql, { email: 'a@b.com', game: 'rawkle', send });
  assert.equal(first.status, 'check_email');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].subject.includes('Confirm'));
  assert.ok(sent[0].text.includes('/api/game-reminder-signup?confirm='));
  // Confirming, then signing up again, does not re-mail.
  const row = store.get('a@b.com|rawkle');
  const confirmed = await confirmGameReminder(sql, row.confirm_token);
  assert.equal(confirmed.email, 'a@b.com');
  const again = await signUpForGameReminder(sql, { email: 'a@b.com', game: 'rawkle', send });
  assert.equal(again.status, 'already_on');
  assert.equal(sent.length, 1);
  // A bad token confirms nothing.
  assert.equal(await confirmGameReminder(sql, 'nope'), null);
  // A recent unconfirmed signup is not re-mailed either.
  const { sql: sql2 } = fakeSql();
  const sent2 = [];
  const send2 = async (m) => { sent2.push(m); return { ok: true }; };
  await signUpForGameReminder(sql2, { email: 'c@d.com', game: 'cards', send: send2 });
  await signUpForGameReminder(sql2, { email: 'c@d.com', game: 'cards', send: send2 });
  assert.equal(sent2.length, 1);
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
