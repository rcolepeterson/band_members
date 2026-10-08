// Wordle-simple Daily Chain (Cole, 2026-10-08): the pure rules behind the
// redesigned board. Share text is spoiler-free (start and target only, the
// bands in between are squares), the puzzle number counts from day one, and
// you get par + DAILY_EXTRA_MOVES moves before the tree wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DAILY_EXTRA_MOVES,
  dailyMoveLimit,
  dailyPuzzleNumber,
  dailyPickSquare,
  fmtElapsed,
  dailyShareResultText,
} from '../scripts/six-degrees-game.mjs';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/six-degrees-game.mjs'), 'utf8');

test('move limit is par plus the extra allowance', () => {
  assert.equal(dailyMoveLimit(4), 4 + DAILY_EXTRA_MOVES);
  assert.equal(dailyMoveLimit(undefined), 3 + DAILY_EXTRA_MOVES);
});

test('puzzle number counts from the first Daily Chain', () => {
  assert.equal(dailyPuzzleNumber('2026-09-30'), 1);
  assert.equal(dailyPuzzleNumber('2026-10-08'), 9);
  assert.equal(dailyPuzzleNumber('2026-09-01'), null);
  assert.equal(dailyPuzzleNumber('garbage'), null);
});

test('pick kinds map to Wordle squares', () => {
  assert.equal(dailyPickSquare('optimal'), '🟩');
  assert.equal(dailyPickSquare('solid'), '🟨');
  assert.equal(dailyPickSquare('obscure'), '🟨');
  assert.equal(dailyPickSquare('deadend'), '🟥');
});

test('elapsed time reads like 28s or 2m 05s', () => {
  assert.equal(fmtElapsed(28.4), '28s');
  assert.equal(fmtElapsed(125), '2m 05s');
  assert.equal(fmtElapsed(null), null);
  assert.equal(fmtElapsed(-3), null);
});

test('a win names start and target, squares in between, no band spoilers', () => {
  const text = dailyShareResultText({
    date: '2026-10-08',
    start: 'Nirvana',
    target: 'Metallica',
    picks: [
      { name: 'Foo Fighters', kind: 'optimal' },
      { name: 'Pearl Jam', kind: 'deadend' },
      { name: 'Probot', kind: 'solid' },
      { name: 'Metallica', kind: 'optimal' },
    ],
    par: 4,
    won: true,
    seconds: 28,
  });
  assert.equal(text, [
    'Six Degrees of Rock 🎸 #9',
    'Nirvana ➡️ 🟩 ➡️ 🟥 ➡️ 🟨 ➡️ Metallica',
    'Moves: 4/4 ⏱️ 28s',
    'Can you beat my chain? https://sixdegreesofrock.com/game',
  ].join('\n'));
  for (const spoiler of ['Foo Fighters', 'Pearl Jam', 'Probot']) assert.ok(!text.includes(spoiler));
});

test('a loss marks the target missed and leaves the time off when unknown', () => {
  const text = dailyShareResultText({
    date: '2026-10-08', start: 'Nirvana', target: 'Metallica',
    picks: [{ kind: 'deadend' }, { kind: 'solid' }], moves: 2, par: 4, won: false,
  });
  assert.match(text, /^Nirvana ➡️ 🟥 ➡️ 🟨 ➡️ ❌ Metallica$/m);
  assert.match(text, /^Moves: 2\/4$/m);
  assert.match(text, /Can you crack it\?/);
});

test('board keeps the server authoritative: running out of moves calls giveup', () => {
  assert.match(src, /hops_used >= dailyMoveLimit\(dailyRun\.par\)[\s\S]{0,200}dailyGiveUp\(card, \{ outOfMoves: true \}\)/);
});

test('board feedback: green/yellow/red buttons, shake on dead end, toast', () => {
  for (const cls of ['.game-daily-option.is-good{', '.game-daily-option.is-ok{', '.game-daily-option.is-bad{']) {
    assert.ok(src.includes(cls), `${cls} rule exists`);
  }
  assert.match(src, /\.game-daily-option\.is-bad\{[^}]*animation:sd-shake/);
  assert.ok(src.includes('function showToast('));
  assert.match(src, /prefers-reduced-motion:reduce/);
});

test('hints, streak and credits live in drawers, not on the board', () => {
  assert.ok(src.includes('<details class="sd-drawer sd-hints">'));
  assert.ok(src.includes('<details class="sd-drawer sd-stats">'));
});

test('results modal offers a share and a non-blocking guest sign-up nudge', () => {
  assert.ok(src.includes('Share result'));
  assert.ok(src.includes('to save your streak and stats!'));
  assert.match(src, /if \(!isSignedIn\(\)\) \{\s*const nudge/);
});

test('mode switcher sits behind SHOW_MODE_SWITCHER (off for launch), logic kept', async () => {
  const mod = await import('../scripts/six-degrees-game.mjs');
  assert.equal(mod.SHOW_MODE_SWITCHER, false);
  assert.ok(src.includes('function openModesSheet()'), 'sheet still exists');
  assert.match(src, /btn\.style\.display = v && SHOW_MODE_SWITCHER \? '' : 'none'/, 'picker visibility respects the flag');
});

test('out of moves: the board paints no choices, only the reveal', () => {
  const at = src.indexOf('if (run.hops_used >= dailyMoveLimit(run.par)) {');
  const options = src.indexOf('for (const o of dailyOptions) {', src.indexOf('function paintDailyBoard('));
  assert.ok(at !== -1, 'out-of-moves branch exists in paintDailyBoard');
  assert.ok(at < options, 'and it returns before the choice buttons are drawn');
  assert.match(src.slice(at, at + 700), /return;/);
});
