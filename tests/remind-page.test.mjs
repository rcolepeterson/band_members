// /remind/ (Cole, 2026-10-15): a shareable page that sells the game and
// takes an email for the daily reminder, no puzzle or account first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const page = read('../remind/index.html');

test('it previews as an ad for the game when posted', () => {
  assert.match(page, /<meta property="og:title" content="6° — a new rock puzzle every morning" \/>/);
  assert.match(page, /<meta property="og:url" content="https:\/\/sixdegreesofrock\.com\/remind\/" \/>/);
  assert.match(page, /<meta property="og:image" content="https:\/\/sixdegreesofrock\.com\/game-og\.png\?v=3" \/>/);
  assert.match(page, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(page, /<title>6° Daily Reminder \| Six Degrees of Rock<\/title>/);
});

test('guests sign up with an email, on the same guest id the game uses', () => {
  assert.match(page, /<input type="email" id="email"/);
  assert.match(page, /fetch\('\/api\/reminder-signup', \{/);
  assert.match(page, /localStorage\.getItem\('sdr-guest-session'\)/);
  assert.match(page, /body: JSON\.stringify\(\{ email: email, guest_session_id: guestSessionId\(\) \}\)/);
  assert.match(page, /Check your email and tap the link to start your reminders\./);
});

test('signed-in visitors get one tap, no email box', () => {
  assert.match(page, /localStorage\.getItem\('bmft-user'\)/);
  assert.match(page, /form\.hidden = true;\s*signedInBox\.hidden = false;/);
  assert.match(page, /body: JSON\.stringify\(\{ daily_reminder: true \}\)/);
});

test('it says what you get, links to the game, and counts signups', () => {
  assert.match(page, /skipped on days you&rsquo;ve played\. Free, no account\. Unsubscribe in one tap\./);
  assert.match(page, /<a class="play" href="\/game\/">Play today&rsquo;s puzzle<\/a>/);
  assert.match(page, /gtag\('event', 'reminder_signup', \{ method: method, where: 'remind_page' \}\)/);
  assert.match(page, /googletagmanager\.com\/gtag\/js\?id=G-E2SNSPFHGB/);
  const engine = read('../scripts/six-degrees-game.mjs');
  assert.match(engine, /gaEvent\('reminder_signup', \{ method: 'guest', where: 'game' \}\)/);
  assert.match(engine, /gaEvent\('reminder_signup', \{ method: 'account', where: 'game' \}\)/);
});

test('it works on a phone: no fixed widths wider than the screen', () => {
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/);
  assert.match(page, /width:min\(100%,300px\)/);
});
