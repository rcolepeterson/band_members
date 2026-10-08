// Regression tests for the /game/ arena UI.
//
// History: these began as compact game-modal tests covering both the burger
// modal (index.html) and the arena. The modal is gone — /game is the single
// game surface (branch game-single-surface) — so the mode-card rules are
// asserted on game/index.html only, plus the single-surface invariants:
// the burger 6* links to /game, the root page carries no modal markup or
// game engine, deep links redirect to /game, and the challenge queue sits
// above the game card (no-scroll: your move is the first thing you see).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const rootHtml = read('index.html');
const gameHtml = read('game/index.html');

test('mode-tab radios are visually hidden but accessible on the game page', () => {
  // Tabs (not cards): the radio is visually hidden, the label is the tab.
  const m = gameHtml.match(/\.game-mode input\{([^}]*)\}/);
  assert.ok(m, 'game/index.html: .game-mode input rule exists');
  assert.match(m[1], /position:\s*absolute/, 'radio taken out of flow');
  assert.match(m[1], /opacity:\s*0/, 'radio visually hidden');
});

test('game action row wraps and pills keep their text on one line', () => {
  const html = gameHtml;
  const actions = html.match(/\.game-actions\{([^}]*)\}/);
  assert.ok(actions, '.game-actions rule exists');
  assert.match(actions[1], /flex-wrap:\s*wrap/, 'action row wraps');
  assert.match(html, /\.game-run-btn\{[^}]*white-space:\s*nowrap/, 'run button never wraps its label');
  assert.match(html, /\.game-actions \.tool-chip\{[^}]*white-space:\s*nowrap/, 'action chips never wrap');
});

test('mode cards use the compact padding on the game page', () => {
  const m = gameHtml.match(/\.game-mode\{([^}]*)\}/);
  assert.ok(m, '.game-mode rule exists');
  assert.match(m[1], /padding:var\(--space-2\)/, 'compact vertical padding');
});

test('game page preloads the Boska 700 face the hero resolves to', () => {
  // .arena-degree declares font-weight:800; the vendored faces top out at
  // 700, so 800 matches the 700 face — that is the one to preload.
  assert.match(
    gameHtml,
    /<link rel="preload" href="\/vendor\/fonts\/boska-700\.woff2" as="font" type="font\/woff2" crossorigin/,
    'boska-700 preload present before the stylesheet'
  );
  const preloadAt = gameHtml.indexOf('rel="preload"');
  const cssAt = gameHtml.indexOf('href="/vendor/fonts.css"');
  assert.ok(preloadAt !== -1 && preloadAt < cssAt, 'preload comes before fonts.css');
});

test('game page re-declares Boska with font-display:block', () => {
  for (const weight of ['400', '500', '700']) {
    assert.match(
      gameHtml,
      new RegExp(
        `@font-face\\{font-family:'Boska';src:url\\('/vendor/fonts/boska-${weight}\\.woff2'\\) format\\('woff2'\\);\\s*font-weight:${weight};font-style:normal;font-display:block\\}`
      ),
      `Boska ${weight} re-declared with font-display:block`
    );
  }
  // The vendored file itself must stay on swap (it's rebuilt, not edited).
  assert.match(read('vendor/fonts.css'), /font-display:\s*swap/, 'vendored fonts.css untouched');
});

test('mode tabs never wrap their labels (pill row)', () => {
  // Tab bar: labels are short mode names that must stay on one line.
  const m = gameHtml.match(/\.game-mode\{([^}]*)\}/);
  assert.ok(m, '.game-mode rule exists');
  assert.match(m[1], /white-space:\s*nowrap/, 'tab labels never wrap');
});
test('mode-tab descriptions are hidden; the active one shows in .game-mode-desc', () => {
  // Descriptions live in the label markup for accessibility but are hidden
  // in tab mode; JS mirrors the active tab's description into #game-mode-desc.
  assert.match(gameHtml, /\.game-mode>span>span\{[^}]*display:\s*none/, 'per-tab description spans hidden');
  assert.ok(gameHtml.includes('id="game-mode-desc"'), '#game-mode-desc element exists');
});

// --- Single game surface (no burger-modal game) ---

test('burger 6* navigates to /game instead of opening a modal', () => {
  const tag = rootHtml.match(/<[^>]*id="mobile-game-open-btn"[^>]*>/);
  assert.ok(tag, '#mobile-game-open-btn exists');
  assert.ok(/^<a[\s>]/.test(tag[0]), '6* is an anchor, not a button');
  assert.match(tag[0], /href="\/game"/, '6* points at /game');
  assert.ok(!tag[0].includes('aria-haspopup="dialog"'), 'no dialog affordance');
});

test('root page carries no game modal and no game engine', () => {
  assert.ok(!rootHtml.includes('id="game-modal"'), 'no #game-modal markup on the main page');
  assert.ok(!rootHtml.includes('six-degrees-game.mjs'), 'game engine not loaded on the main page');
});

test('root deep links redirect to the game page', () => {
  // ?game=1 (old share-card QR codes), ?invite=<token>, ?match=<token>
  // all land on /game now that the modal is gone.
  assert.match(rootHtml, /q\.has\('game'\)/, '?game=1 handled');
  assert.match(rootHtml, /window\.location\.replace\('\/game\/'\)/, '?game=1 redirects to /game/');
  assert.match(rootHtml, /\/game\/\?invite='/, '?invite= redirects to /game/?invite=');
  assert.match(rootHtml, /\/game\/\?match='/, '?match= redirects to /game/?match=');
});

test('challenge queue sits above the game card (no-scroll)', () => {
  // Your move is the first thing you see: the queue renders before the
  // game card in DOM order, so nobody scrolls past modes and inputs to
  // find their challenges.
  const chalAt = gameHtml.indexOf('data-challenges-wrap');
  const matchAt = gameHtml.indexOf('data-matches-wrap');
  const cardAt = gameHtml.indexOf('id="game-modal"');
  assert.ok(chalAt !== -1 && matchAt !== -1 && cardAt !== -1, 'queue sections and game card present');
  assert.ok(chalAt < cardAt, 'Your challenges precedes the game card');
  assert.ok(matchAt < cardAt, 'Your matches precedes the game card');
});
