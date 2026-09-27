// Tests for the game signup nudge + sponsor ribbon
// (scripts/six-degrees-game.mjs, netlify/functions/game_sponsors.mjs,
//  netlify/functions/migrate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  NUDGE_THRESHOLD,
  NUDGE_COPY,
  nudgeShouldShow,
  SPONSOR_LABEL,
  SPONSOR_PLACEHOLDER,
  MAX_SPONSORS,
} from '../scripts/six-degrees-game.mjs';
import { validSponsor } from '../netlify/functions/game_sponsors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GAME_SRC = readFileSync(join(ROOT, 'scripts', 'six-degrees-game.mjs'), 'utf8');
const MIGRATE_SRC = readFileSync(join(ROOT, 'netlify', 'functions', 'migrate.mjs'), 'utf8');

// --- nudge logic ------------------------------------------------------------

test('nudge fires exactly at the threshold for logged-out players', () => {
  assert.equal(NUDGE_THRESHOLD, 3);
  assert.equal(nudgeShouldShow({ plays: 2, done: false, signedIn: false }), false);
  assert.equal(nudgeShouldShow({ plays: 3, done: false, signedIn: false }), true);
  assert.equal(nudgeShouldShow({ plays: 4, done: false, signedIn: false }), true);
});

test('nudge never shows once done or signed in', () => {
  assert.equal(nudgeShouldShow({ plays: 3, done: true, signedIn: false }), false);
  assert.equal(nudgeShouldShow({ plays: 3, done: false, signedIn: true }), false);
  assert.equal(nudgeShouldShow({ plays: 99, done: true, signedIn: true }), false);
});

test('nudge copy is exact, quiet, and never mentions the daily pair', () => {
  assert.equal(
    NUDGE_COPY,
    "That's the match — sign up to save your chains and challenge a friend."
  );
  assert.ok(!NUDGE_COPY.includes('!'), 'no hype punctuation');
  assert.ok(!/daily/i.test(NUDGE_COPY), 'daily-pair mode does not exist');
});

test('game module wires the nudge: counter key, signup funnel, dismiss', () => {
  assert.ok(GAME_SRC.includes('sdr_chains_played'), 'plays counted in localStorage');
  assert.ok(GAME_SRC.includes('sdr_nudge_done'), 'dismissal persisted');
  assert.ok(GAME_SRC.includes('maybeShowNudge()'), 'reveal path triggers the nudge check');
  // Routes through the existing signup funnel, not a parallel gate.
  assert.ok(
    GAME_SRC.includes('window.openSignupPopover'),
    'nudge signup button uses the shared openSignupPopover funnel'
  );
  // Logged-in players are excluded via the same session key the page uses.
  assert.ok(GAME_SRC.includes("localStorage.getItem('bmft-user')"), 'signed-in check reads the session key');
  // Not a blocking popup: a dismissable card under the result.
  assert.ok(GAME_SRC.includes('game-nudge-close'), 'nudge is dismissable');
  assert.ok(!/window\.alert|confirm\(/.test(GAME_SRC), 'no blocking dialogs');
});

// --- sponsor ribbon copy -----------------------------------------------------

test('sponsor ribbon copy is exact and capped at seven', () => {
  assert.equal(SPONSOR_LABEL, "This week's game is brought to you by");
  assert.equal(SPONSOR_PLACEHOLDER, 'your brand here');
  assert.equal(MAX_SPONSORS, 7);
});

test('game module fetches sponsors and degrades to the placeholder', () => {
  assert.ok(GAME_SRC.includes("fetch('/api/game-sponsors'"), 'ribbon loads from the endpoint');
  assert.ok(GAME_SRC.includes('game-sponsor-ribbon'), 'ribbon element exists');
  assert.ok(GAME_SRC.includes('game-sponsor-placeholder'), 'placeholder path exists');
  // Placeholder opens the feedback form directly through the page's own
  // openFeedbackPopover routine — never by proxy-clicking the toolbar
  // button (that handoff missed on a real device).
  assert.ok(GAME_SRC.includes('window.openFeedbackPopover'), 'placeholder uses the page open routine');
  assert.ok(!GAME_SRC.includes('send-feedback-btn'), 'no toolbar-button proxy-click remains');
  // The '/' fallback is gone: nothing in the game module navigates away.
  assert.ok(!/location\.href\s*=/.test(GAME_SRC), 'no navigation fallback anywhere in the module');
  assert.ok(!/location\s*=\s*['"]\//.test(GAME_SRC), 'no bare location assignment to a path');
  // The inquiry is routed: the feedback type is preselected to the new
  // "Game sponsorship" option; the visitor still writes their own message.
  assert.ok(GAME_SRC.includes("typeSel.value = 'Game sponsorship'"), 'type preset targets Game sponsorship');
  assert.ok(!/feedback-message['"]?\)?\.value\s*=/.test(GAME_SRC), 'message textarea is never prefilled');
  // Last resort keeps the game open and says so inline in the ribbon.
  assert.ok(GAME_SRC.includes('game-sponsor-contact-note'), 'inline fallback note exists');
  assert.ok(GAME_SRC.includes("Couldn't open the contact form"), 'fallback note copy is exact');
});

test('feedback form offers a Game sponsorship type', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(
    html.includes('<option value="Game sponsorship">Game sponsorship</option>'),
    'Game sponsorship option exists in #feedback-type'
  );
  assert.ok(html.includes('window.openFeedbackPopover = openFeedbackPopover'), 'open routine is exposed');
});

// --- sponsor payload validation ----------------------------------------------

test('validSponsor accepts a complete sponsor', () => {
  const s = validSponsor({
    name: 'Momma Hot Lips',
    icon_url: 'https://example.com/logo.png',
    link_url: 'https://example.com',
    sort_order: 2,
  });
  assert.deepEqual(s, {
    name: 'Momma Hot Lips',
    icon_url: 'https://example.com/logo.png',
    link_url: 'https://example.com',
    sort_order: 2,
  });
});

test('validSponsor requires a name and an https icon', () => {
  assert.equal(validSponsor({ icon_url: 'https://example.com/l.png' }), null);
  assert.equal(validSponsor({ name: 'X' }), null);
  assert.equal(validSponsor({ name: 'X', icon_url: 'javascript:alert(1)' }), null);
  assert.equal(validSponsor({ name: 'X', icon_url: '/relative/path.png' }), null);
  assert.equal(validSponsor({ name: 'X', icon_url: 'data:image/png;base64,xx' }), null);
});

test('validSponsor allows an empty link and clamps sort order', () => {
  const s = validSponsor({ name: 'X', icon_url: 'https://example.com/l.png' });
  assert.equal(s.link_url, null);
  assert.equal(s.sort_order, 0);
  assert.equal(validSponsor({ name: 'X', icon_url: 'https://example.com/l.png', link_url: 'not a url' }), null);
  const big = validSponsor({ name: 'X', icon_url: 'https://example.com/l.png', sort_order: 99999 });
  assert.equal(big.sort_order, 1000);
});

// --- migration ----------------------------------------------------------------

test('migrate.mjs creates the game_sponsors table idempotently', () => {
  assert.ok(
    MIGRATE_SRC.includes('create table if not exists game_sponsors'),
    'game_sponsors table step present'
  );
  assert.ok(MIGRATE_SRC.includes('table game_sponsors ready'), 'step output follows the house style');
  assert.ok(MIGRATE_SRC.includes('game_sponsors_sort_order_idx'), 'sort-order index present');
  for (const col of ['id', 'name', 'icon_url', 'link_url', 'sort_order', 'created_at']) {
    assert.ok(MIGRATE_SRC.includes(col), `column ${col} present`);
  }
});
