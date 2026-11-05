// Focus/glow + graph directions popover (2026-11-04).
//
// Short press focuses a node in place (glow + card, no travel);
// long-press travels; empty-space tap releases the glow and closes the
// card. The directions popover explains the gestures, games-style, until
// "Don't show this again" is checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'graph', 'index.html'), 'utf8');
const EXPLORER = readFileSync(join(__dirname, '..', 'scripts', 'sigma-explorer.mjs'), 'utf8');

test('directions popover markup, copy, and persistence key exist', () => {
  assert.match(INDEX_HTML, /id="graph-howto-popover"/);
  assert.match(INDEX_HTML, /id="graph-howto-dismiss"/);
  assert.match(INDEX_HTML, /id="graph-howto-close"/);
  assert.match(INDEX_HTML, /Don't show this again/);
  assert.match(INDEX_HTML, /const KEY = 'sdr-graph-howto-seen'/);
  assert.match(INDEX_HTML, /localStorage\.getItem\(KEY\)/);
  assert.match(INDEX_HTML, /localStorage\.setItem\(KEY, '1'\)/);
});

test('popover copy covers the nav moves in short sentences', () => {
  assert.match(INDEX_HTML, /Search for another band or musician\./);
  assert.match(INDEX_HTML, /Short press a node to light up its threads and open its card\./);
  assert.match(INDEX_HTML, /Threads light up gold for bands, blue for members\./);
  assert.match(INDEX_HTML, /Long-press a node to travel to its constellation\./);
  assert.match(INDEX_HTML, /Tap empty space to release the glow and close the card\./);
  assert.match(INDEX_HTML, /Show next members: more of this band's members, without leaving this view\./);
  assert.match(INDEX_HTML, /Expand: go one degree deeper\./);
  assert.match(INDEX_HTML, /Show next group: jump to another part of the graph\./);
});

test('popover text stays at or above the 12px legibility floor', () => {
  const cardRule = INDEX_HTML.slice(
    INDEX_HTML.indexOf('.graph-howto-card ul'),
    INDEX_HTML.indexOf('}', INDEX_HTML.indexOf('.graph-howto-card ul')),
  );
  assert.match(cardRule, /font-size:14px/);
});

test('popover is reopenable from every chrome that shows the graph', () => {
  // Page footer (SVG path, where the site footer survives).
  assert.match(INDEX_HTML, /id="graph-howto-footer-link"/);
  // Mobile sheet chip (thumb reach on phones).
  assert.match(INDEX_HTML, /id="mobile-howto-btn"/);
  // Stage footer (Sigma path, where the site footer is hidden).
  assert.match(EXPLORER, /class="sigma-howto-link"/);
  assert.match(INDEX_HTML, /sigma-howto-link/);
});

test('empty-space tap closes the card on the page side', () => {
  assert.match(INDEX_HTML, /rbft:sigma-stage-tap/);
  const listener = INDEX_HTML.slice(
    INDEX_HTML.indexOf("rbft:sigma-stage-tap"),
    INDEX_HTML.indexOf("rbft:sigma-stage-tap") + 200,
  );
  assert.match(listener, /closeNodeCard\(\)/);
});
