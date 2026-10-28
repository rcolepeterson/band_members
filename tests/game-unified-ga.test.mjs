// Unified GA events (Aaron, 2026-10-28): every game reports the same
// actions to GA under the same event names, tagged with its game, so GA
// can split by game or total them. Daily already did this; Rawkle and
// Cards sent game events only to the own-server table, which is why
// Cole's GA view showed zero Rawkle/Cards plays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawkle = readFileSync(join(root, 'rawkle/index.html'), 'utf8');
const cards = readFileSync(join(root, 'cards/index.html'), 'utf8');

for (const [name, src, game, helper] of [['Rawkle', rawkle, 'rawkle', 'rawkleGa("'], ['Cards', cards, 'cards', "cardsGa('"]]) {
  test(`${name} fires all four shared GA events tagged with its game`, () => {
    for (const ev of ['game_started', 'first_move', 'game_completed', 'share_clicked']) {
      assert.ok(src.includes(`${helper}${ev}`), `${name} fires ${ev}`);
    }
    assert.ok(src.includes(`game: '${game}'`) || src.includes(`game: "${game}"`), `${name} tags events with its game`);
    assert.ok(src.includes('gtag('), `${name} calls gtag`);
  });
}

test('Rawkle first move is the first guess, completion carries win/loss + moves', () => {
  assert.ok(rawkle.includes('guesses.length === 1'), 'first guess gates first_move');
  assert.ok(rawkle.includes(`result: status === "won" ? "win" : "loss", moves_count: guesses.length`), 'completion carries result + moves');
});

test('Cards first move is the human first PLAY only, not CPU turns', () => {
  assert.ok(cards.includes(`if (seat === 0) cardsGa('first_move'`), 'seat 0 gates first_move');
  assert.ok(!cards.includes(`cardsEvent('move_made'`), 'no server per-turn move events (turns include CPU turns)');
});

test('Rawkle server events stay daily-only; GA fires for practice too', () => {
  assert.ok(rawkle.includes('if (mode !== "daily") return;'), 'server events still daily-only');
  assert.ok(rawkle.includes(`mode: "practice"`), 'GA fires practice with mode param');
});

test('both pages already carry the GA tag, so the events have somewhere to go', () => {
  assert.ok(rawkle.includes('G-E2SNSPFHGB'), 'Rawkle GA tag present');
  assert.ok(cards.includes('G-E2SNSPFHGB'), 'Cards GA tag present');
});
