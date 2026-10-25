// Shared 6* grammar (Aaron, 2026-10-25): the three games share how their
// rules card behaves and looks, and every end-card/footer carries exactly
// one splash link + a plain "Feedback" control. Rules CONTENT stays per game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const daily = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');
const cards = readFileSync(join(root, 'cards/index.html'), 'utf8');
const rawkle = readFileSync(join(root, 'rawkle/index.html'), 'utf8');

test('Daily rules card: opt-out checkbox, show until opted out', () => {
  assert.ok(daily.includes('Don’t show this again'), 'Daily how-to has the opt-out label');
  assert.ok(daily.includes("localStorage.setItem('sdr-howto-seen', '1')"), 'checkbox persists the opt-out');
  assert.ok(daily.includes("localStorage.removeItem('sdr-howto-seen')"), 'unchecking clears it');
  // First-visit paint must NOT set the flag itself (that was the old once-ever behavior).
  const firstVisit = daily.slice(daily.indexOf('First visit: show the rules once'), daily.indexOf('First visit: show the rules once') + 400);
  assert.ok(!firstVisit.includes('setItem'), 'first-visit paint does not set the flag');
});

test('Daily end-card footer: splash link + plain Feedback, no "Something off?"', () => {
  assert.ok(!daily.includes('Something off?'), 'no "Something off?" prefix');
  assert.ok(daily.includes('<a href="/">sixdegreesofrock.com</a>'), 'Daily results modal links to splash');
  assert.ok(daily.includes('>Feedback</button>'), 'Daily feedback control is just "Feedback"');
});

test('Cards: game-over footer is splash + Feedback, page footer has no other-game links', () => {
  assert.ok(cards.includes('class="gameover-foot"'), 'game-over card has the shared footer');
  assert.ok(!cards.includes('<a href="/">More games</a>'), 'Cards footer drops "More games"');
  assert.ok(cards.includes('>Feedback</a>'), 'Cards feedback control is just "Feedback"');
});

test('Rawkle: help, footer, and end-card carry only the splash link + Feedback', () => {
  assert.ok(rawkle.includes('<p class="links"><a href="/">sixdegreesofrock.com</a></p>'), 'help links are just splash');
  assert.ok(!rawkle.includes('href="/game"'), 'no stale /game link');
  assert.ok(!rawkle.includes('href="/cards"'), 'no other-game link in Rawkle');
  assert.ok(!rawkle.includes('href="/play"'), 'no stale /play link');
  assert.ok(rawkle.includes('class="sheet-foot"'), 'end-card has the shared footer');
  assert.ok(rawkle.includes('>Feedback</a>'), 'Rawkle feedback control is just "Feedback"');
});

test('Rules cards already shared elsewhere stay shared: checkbox + Play + reopen, no state loss', () => {
  assert.ok(cards.includes('id="rules-noshow"'), 'Cards rules has the opt-out checkbox');
  assert.ok(cards.includes('id="rules-play"'), 'Cards rules has Play');
  assert.ok(rawkle.includes('id="help-dontshow"'), 'Rawkle help has the opt-out checkbox');
  assert.ok(rawkle.includes('id="help-play"'), 'Rawkle help has Play');
  assert.ok(rawkle.includes('id="help-btn"'), 'Rawkle help reopens from a pill');
});
