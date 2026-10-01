// Regression tests for the compact game-modal pass and the /game/ hero
// font-flash fix.
//
// 1. Mode cards (.game-mode) stay compact on both the burger modal
//    (index.html) and the arena (game/index.html): the radio inputs have an
//    explicit size so oversized native radios can't stretch the cards, and
//    the action row wraps with no-wrap pills so "Set the matchup" can't
//    overflow its pill.
// 2. The /game/ hero 6° (.arena-degree) must never paint in the Georgia
//    fallback: Boska is preloaded and re-declared with font-display:block
//    in game/index.html (vendor/fonts.css itself uses swap and is vendored,
//    so it can't be edited).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const rootHtml = read('index.html');
const gameHtml = read('game/index.html');

test('mode-card radios have an explicit size in both pages', () => {
  for (const [name, html] of [['index.html', rootHtml], ['game/index.html', gameHtml]]) {
    const m = html.match(/\.game-mode input\{([^}]*)\}/);
    assert.ok(m, `${name}: .game-mode input rule exists`);
    assert.match(m[1], /width:\s*18px/, `${name}: radio width pinned`);
    assert.match(m[1], /height:\s*18px/, `${name}: radio height pinned`);
  }
});

test('game action row wraps and pills keep their text on one line', () => {
  for (const [name, html] of [['index.html', rootHtml], ['game/index.html', gameHtml]]) {
    const actions = html.match(/\.game-actions\{([^}]*)\}/);
    assert.ok(actions, `${name}: .game-actions rule exists`);
    assert.match(actions[1], /flex-wrap:\s*wrap/, `${name}: action row wraps`);
    assert.match(html, /\.game-run-btn\{[^}]*white-space:\s*nowrap/, `${name}: run button never wraps its label`);
    assert.match(html, /\.game-actions \.tool-chip\{[^}]*white-space:\s*nowrap/, `${name}: action chips never wrap`);
  }
});

test('mode cards use the compact padding in both pages', () => {
  for (const [name, html] of [['index.html', rootHtml], ['game/index.html', gameHtml]]) {
    const m = html.match(/\.game-mode\{([^}]*)\}/);
    assert.ok(m, `${name}: .game-mode rule exists`);
    assert.match(m[1], /padding:var\(--space-2\)/, `${name}: compact vertical padding`);
  }
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

test('mode-card text wrapper shrinks inside the flex row (iPhone Safari)', () => {
  // Paul's iPhone Safari report: blank mode cards + text spilling off the
  // right edge. The label is display:flex and the text <span> is a flex
  // item — with the default min-width:auto it refuses to shrink, so long
  // text blows the card out. min-width:0 lets it shrink; overflow-wrap
  // breaks long words instead of spilling.
  for (const [name, html] of [['index.html', rootHtml], ['game/index.html', gameHtml]]) {
    const m = html.match(/\.game-mode>span\{([^}]*)\}/);
    assert.ok(m, `${name}: .game-mode>span rule exists`);
    assert.match(m[1], /min-width:\s*0/, `${name}: text wrapper may shrink`);
    assert.match(m[1], /overflow-wrap:\s*anywhere/, `${name}: long words break instead of spilling`);
  }
});
