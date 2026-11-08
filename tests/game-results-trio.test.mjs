// Results trio (Aaron, 2026-11-07): (1) the last move stared at a
// spinner for the whole POST + 800ms, so a second tap felt needed —
// now the completing move paints first, then only a 350ms beat before
// the modal; (2) closing the results left no way back to the chain,
// stats and bars — the finished boards get a reopen chip; (3) the two
// end pills shrink a little more for no-scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');
const pick = src.slice(src.indexOf('async function dailyPick('), src.indexOf('async function dailyHint('));

test('completing move paints first, then a short beat, then results', () => {
  assert.ok(pick.includes('await pause(350);'), 'short beat before the modal');
  assert.ok(
    pick.indexOf('paintDailyBoard(card, data.completed)') < pick.indexOf('await pause(350);'),
    'final pick lands visibly before the beat',
  );
  assert.ok(
    pick.indexOf('await pause(350);') < pick.indexOf('openDailyResults({ won: true, completed: data.completed })'),
    'beat runs before the modal opens',
  );
  assert.ok(pick.includes("await pause(kind === 'deadend' ? 1000 : 800);"), 'other moves keep the full pause');
  assert.ok(!pick.slice(0, pick.indexOf('if (data.completed) {')).includes('await pause('), 'no pause runs before the completed branch anymore');
});

test('finished boards get a See-your-chain chip that reopens the modal', () => {
  assert.ok(src.includes("const view = el('<button type=\"button\" class=\"tool-chip\">See your chain</button>');"), 'chip exists');
  assert.ok(src.includes('openDailyResults({ won: true, completed: c })'), 'win board reopens with the fresh finish');
  assert.ok(src.includes('openDailyResults({ won: false })'), 'give-up board reopens too');
  assert.ok(!src.includes('>See results<'), 'label respects the wordle copy guard against that exact string');
});

test('end pills and results card shrink a little more', () => {
  assert.ok(src.includes('min-height:40px;font-size:.9rem;'), 'pills 44px -> 40px');
  assert.ok(src.includes('.sd-modal-card--results{padding:18px 14px 12px}'), 'card padding tightens');
  assert.ok(src.includes('.sd-modal-card--results h2{font-size:1.25rem}'), 'title tightens');
  assert.ok(src.includes('.sd-end-actions{display:flex;gap:8px;'), 'row gap tightens');
  assert.ok(src.includes('Share result'), 'Share keeps its label');
  assert.ok(src.includes('Create a free account'), 'Create keeps its label');
});
