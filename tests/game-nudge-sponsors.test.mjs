// Tests for the game signup nudge + sponsor API validation
// (scripts/six-degrees-game.mjs, netlify/functions/game_sponsors.mjs,
//  netlify/functions/migrate.mjs).
//
// The sponsor ribbon was removed 2026-09-29 (it read small with no sponsors);
// the /api/game-sponsors endpoint and table stay for a future rebuild, and
// the feedback form keeps its "Game sponsorship" inquiry type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  NUDGE_THRESHOLD,
  NUDGE_COPY,
  nudgeShouldShow,
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

// --- sponsor ribbon removal (2026-09-29) ---------------------------------------
// The ribbon read small with no sponsors, so it was deleted outright; the
// sponsor surface gets rebuilt later once real game usage is known. These
// assertions lock the removal in — the placeholder must not creep back.

test('game module has no sponsor ribbon or placeholder', () => {
  assert.ok(!GAME_SRC.includes('game-sponsor-ribbon'), 'no ribbon element');
  assert.ok(!GAME_SRC.includes('game-sponsor-placeholder'), 'no placeholder element');
  assert.ok(!GAME_SRC.includes('game-sponsor-contact-note'), 'no contact-note fallback');
  assert.ok(!GAME_SRC.includes("fetch('/api/game-sponsors'"), 'no sponsor endpoint fetch');
  assert.ok(!GAME_SRC.includes('SPONSOR_PLACEHOLDER'), 'no placeholder constant');
  assert.ok(!GAME_SRC.includes('SPONSOR_LABEL'), 'no ribbon label constant');
});

test('game card CSS has no sponsor ribbon rules', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(!html.includes('.game-sponsor-ribbon'), 'no ribbon CSS');
  assert.ok(!html.includes('.game-sponsor-placeholder'), 'no placeholder CSS');
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
