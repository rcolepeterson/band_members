// Signup tracking for every 6* game + the graph (Aaron, 2026-10-29):
// "how did they get here?" for every email signup, ready no matter what
// the campaign goal ends up being.
//
// What this locks in:
//   1. Attribution rule (scripts/signup-attribution.mjs, pure function):
//      UTM on the URL wins, else the stored session touch, else a ?s=1
//      share link counts as share/social, else the referrer host.
//   2. The reminder pipes store the landing touch with the signup, so a
//      confirmation that lands days later (or on another device) still
//      traces back to the campaign. A sourceless re-ask keeps the old
//      touch (COALESCE), never wipes it.
//   3. Confirm pages fire reminder_signup_confirmed exactly once — only
//      on a FRESH confirmation, so a refresh never double-counts — with
//      the stored source as params, and < escaped so a hostile value
//      cannot break out of the <script> block.
//   4. Every signup surface fires its GA event with game + source:
//      Rawkle end card, Cards game-over, /remind/ guest + account,
//      Daily in-game prompt, graph signup panel (creation only) and
//      graph daily-reminder toggle (turning ON only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseSignupAttribution } from '../scripts/signup-attribution.mjs';
import {
  signUpForGameReminder,
  confirmGameReminder,
  reminderConfirmedGaScript,
  ensureGameReminderSchema,
  __resetGameReminderSchemaForTests,
} from '../netlify/functions/_game_reminders.mjs';
import {
  signUp as signUpDaily,
  reminderConfirmedGaScript as dailyConfirmedGaScript,
} from '../netlify/functions/reminder_signup.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ---------- 1. Attribution rule ----------
test('attribution: UTM wins, then stored touch, then share link, then referrer', () => {
  assert.deepEqual(
    parseSignupAttribution('?utm_source=facebook&utm_medium=cpc&utm_campaign=rawkle-jan', '', null),
    { source: 'facebook', medium: 'cpc', campaign: 'rawkle-jan' });
  assert.deepEqual(
    parseSignupAttribution('', '', JSON.stringify({ source: 'facebook', medium: 'cpc', campaign: 'rawkle-jan' })),
    { source: 'facebook', medium: 'cpc', campaign: 'rawkle-jan' });
  assert.deepEqual(parseSignupAttribution('?s=1', '', null),
    { source: 'share', medium: 'social', campaign: '' });
  assert.deepEqual(parseSignupAttribution('', 'https://www.facebook.com/post', null),
    { source: 'www.facebook.com', medium: '', campaign: '' });
  assert.deepEqual(parseSignupAttribution('', '', null),
    { source: '', medium: '', campaign: '' });
});

test('attribution: values are clamped and non-strings are safe', () => {
  const long = 'x'.repeat(300);
  const out = parseSignupAttribution(`?utm_source=${long}`, '', null);
  assert.equal(out.source.length, 128);
  assert.deepEqual(parseSignupAttribution('?utm_source=', 'not a url', '{bad json'),
    { source: '', medium: '', campaign: '' });
});

// ---------- 2. Server stores the touch ----------
function gameSql({ existing = null } = {}) {
  const queries = [];
  const sql = async (strings, ...values) => {
    const q = strings.join('?');
    queries.push({ q, values });
    if (q.includes('create table') || q.includes('alter table')) return [];
    if (q.includes('select * from game_reminders')) return existing ? [existing] : [];
    if (q.includes('insert into game_reminders')) return [];
    return [];
  };
  return { sql, queries };
}

test('game signup stores source; schema adds the columns', async () => {
  __resetGameReminderSchemaForTests();
  const { sql, queries } = gameSql();
  // The endpoint runs ensureGameReminderSchema before signUp; mirror that.
  await ensureGameReminderSchema(sql);
  await signUpForGameReminder(sql, {
    email: 'a@b.com', game: 'rawkle',
    source: { source: 'facebook', medium: 'cpc', campaign: 'rawkle-jan' },
    send: async () => ({ ok: true }),
  });
  const insert = queries.find(({ q }) => q.includes('insert into game_reminders'));
  assert.ok(insert, 'expected an insert into game_reminders');
  assert.deepEqual(insert.values.slice(-3), ['facebook', 'cpc', 'rawkle-jan']);
  const schema = queries.filter(({ q }) => q.includes('alter table'));
  assert.equal(schema.length, 3, 'three ADD COLUMN statements');
  const modSrc = read('../netlify/functions/_game_reminders.mjs');
  assert.match(modSrc, /coalesce\(nullif\(excluded\.signup_source, ''\), game_reminders\.signup_source\)/);
});

test('game signup without a source keeps the old touch', async () => {
  __resetGameReminderSchemaForTests();
  const { sql, queries } = gameSql({ existing: { confirmed_at: null, confirm_sent_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() } });
  await signUpForGameReminder(sql, {
    email: 'a@b.com', game: 'rawkle', source: {},
    send: async () => ({ ok: true }),
  });
  const upsert = queries.find(({ q }) => q.includes('insert into game_reminders'));
  assert.ok(upsert);
  assert.deepEqual(upsert.values.slice(-3), ['', '', '']);
  // The COALESCE in the upsert text is what preserves the stored touch.
  const modSrc = read('../netlify/functions/_game_reminders.mjs');
  assert.match(modSrc, /signup_campaign = coalesce\(nullif\(excluded\.signup_campaign, ''\), game_reminders\.signup_campaign\)/);
});

function confirmSql({ before, row }) {
  const sql = async (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('select confirmed_at from game_reminders')) return before ? [before] : [];
    if (q.includes('update game_reminders set confirmed_at')) return row ? [row] : [];
    return [];
  };
  return sql;
}

test('game confirm: fresh click returns source + fresh, repeat does not', async () => {
  __resetGameReminderSchemaForTests();
  const row = { email: 'a@b.com', game: 'rawkle', signup_source: 'facebook', signup_medium: 'cpc', signup_campaign: 'rawkle-jan' };
  const fresh = await confirmGameReminder(confirmSql({ before: { confirmed_at: null }, row }), 'tok');
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.signup_source, 'facebook');
  const repeat = await confirmGameReminder(confirmSql({ before: { confirmed_at: '2026-10-29T00:00:00Z' }, row }), 'tok');
  assert.equal(repeat.fresh, false);
});

// ---------- 3. Confirm-page GA script ----------
test('confirm script fires the event with source, and cannot break out', () => {
  const html = reminderConfirmedGaScript('rawkle', { source: 'facebook', medium: 'cpc', campaign: 'rawkle-jan' });
  assert.match(html, /gtag\('event', 'reminder_signup_confirmed'/);
  assert.match(html, /"game":"rawkle"/);
  assert.match(html, /"signup_campaign":"rawkle-jan"/);
  const hostile = reminderConfirmedGaScript('cards', { source: '"></script><script>alert(1)', medium: '', campaign: '' });
  const inner = hostile.split('reminder_signup_confirmed')[1];
  assert.doesNotMatch(inner, /<\/script><script>alert/);
  assert.match(hostile, /\\u003c\/script>/);
  const daily = dailyConfirmedGaScript('daily', { source: 'instagram', medium: '', campaign: '' });
  assert.match(daily, /"game":"daily"/);
  assert.match(daily, /"signup_source":"instagram"/);
});

// ---------- 4. Daily pipe stores the touch ----------
test('daily guest signup stores source', async () => {
  const queries = [];
  const sql = async (strings, ...values) => {
    const q = strings.join('?');
    queries.push({ q, values });
    if (q.includes('create table') || q.includes('alter table')) return [];
    if (q.includes('select id from users')) return [{ id: 'user-1' }];
    if (q.includes('select * from guest_reminders')) return [];
    if (q.includes('insert into guest_reminders')) return [];
    return [];
  };
  await signUpDaily(sql, {
    email: 'a@b.com', guestSessionId: 'g_12345678',
    source: { source: 'facebook', medium: 'cpc', campaign: 'daily-jan' },
    send: async () => ({ ok: true }),
  });
  const insert = queries.find(({ q }) => q.includes('insert into guest_reminders'));
  assert.ok(insert, 'expected an insert into guest_reminders');
  assert.deepEqual(insert.values.slice(-3), ['facebook', 'cpc', 'daily-jan']);
});

// ---------- 5. Page wiring (same style as sigma-explorer-wiring) ----------
test('every signup surface fires its event with game + source', () => {
  const rawkle = read('../rawkle/index.html');
  assert.match(rawkle, /rawkleGa\("reminder_signup", \{ game: "rawkle", method: "end_card"/);
  assert.match(rawkle, /source: src \}/);
  assert.match(rawkle, /signup-attribution\.mjs/);
  const cards = read('../cards/index.html');
  assert.match(cards, /cardsGa\('reminder_signup', \{ game: 'cards', method: 'game_over'/);
  assert.match(cards, /already_on/);
  const remind = read('../remind/index.html');
  assert.match(remind, /reminder_signup', \{ game: 'daily', method: method, where: 'remind_page'/);
  const daily = read('../scripts/six-degrees-game.mjs');
  assert.match(daily, /gaEvent\('reminder_signup', \{ game: 'daily', method: 'account', where: 'game'/);
  const graph = read('../graph/index.html');
  assert.match(graph, /gtag\('event', 'account_signup', \{ method: 'graph_signup'/);
  assert.match(graph, /gtag\('event', 'reminder_signup', \{ game: 'daily', method: 'graph_toggle'/);
  assert.match(graph, /signup-attribution\.mjs/);
});
