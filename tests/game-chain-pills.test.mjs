// Chain pills + player line (ops/chain-pills-v1).
// Aaron: the text trail ("A → B → C") was confusing. The chain is now a row
// of pills — [start][?][?]...[target] — that fill in as you pick, and grow a
// blank pill for every non-optimal pick (visibly over par). The player line
// ("Playing as X · N credits") stays persistently visible in the card.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');

test('paintChainPills exists and is shared by daily + solo', () => {
  assert.ok(src.includes('function paintChainPills(card, run)'), 'painter defined');
  const calls = src.match(/paintChainPills\(card, run\)/g) || [];
  assert.ok(calls.length >= 2, `called from both boards (found ${calls.length})`);
});

test('pill row grows a blank pill per non-optimal pick', () => {
  assert.ok(src.includes("p.kind !== 'optimal' && p.kind !== 'deadend'"), 'extra-blank rule');
  assert.ok(src.includes('Math.max(par - 1 + extra, picks.length)'), 'never fewer slots than picks');
});

test('pill CSS classes exist with accent styling', () => {
  for (const cls of ['game-chain-pills', 'game-chain-pill', 'game-chain-anchor',
                     'game-chain-filled', 'game-chain-deadend', 'game-chain-blank']) {
    assert.ok(src.includes('.' + cls + '{'), `.${cls} rule exists`);
  }
  assert.ok(src.includes('82,174,182'), 'teal accent used');
});

test('blank pills are dashed with a ? placeholder', () => {
  assert.ok(src.includes("mkPill('?', 'game-chain-blank'"), 'blank pill renders ?');
  assert.match(src, /\.game-chain-blank\{[^}]*dashed/, 'dashed border');
});

test('both card templates carry pills + player line divs', () => {
  const pills = src.match(/<div class="game-chain-pills"><\/div>/g) || [];
  const plines = src.match(/<div class="game-player-line"><\/div>/g) || [];
  assert.equal(pills.length, 2, `pills div in daily + solo (found ${pills.length})`);
  assert.equal(plines.length, 2, `player line in daily + solo (found ${plines.length})`);
});

test('old text trail is gone', () => {
  assert.ok(!src.includes('game-daily-trail'), 'no trail references remain');
});

test('paintPlayerLine shows handle + credits, updates async safely', () => {
  assert.ok(src.includes('function paintPlayerLine(card, run)'), 'painter defined');
  assert.ok(src.includes('loadMyHandle()'), 'uses cached handle loader');
  assert.ok(src.includes('Playing as '), 'handle format');
  assert.ok(src.includes('dataset.seq'), 'stale-async guard');
});
