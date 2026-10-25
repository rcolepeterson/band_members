// Path verification (Aaron, 2026-10-25): the post-pick popup toast is gone,
// the static .sd-result bar is the only verification, in solid pick colors
// with two or three words, band pills match the picks, and the clock starts
// on the first pick (not on first paint) and pauses while hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');

test('no popup toast for a pick or a peek', () => {
  assert.ok(!src.includes("'✓ Connected. Shortest path!'"), 'no pick toast text');
  assert.ok(!src.includes("'✓ Connected, but the long way round'"), 'no loose-pick toast text');
  assert.ok(!src.includes("'✗ Dead end. No shared member. −1 move'"), 'no dead-end toast text');
  assert.ok(!src.includes('showToast(answer,'), 'no peek toast');
  // The toast itself stays for non-path uses: share, copy, out of moves.
  assert.ok(src.includes('function showToast('), 'showToast still exists');
  assert.ok(src.includes("showToast('Copied results to clipboard'"), 'copy toast kept');
  assert.ok(src.includes("showToast('Show\\u2019s over! You ran out of moves.'"), 'out-of-moves toast kept');
});

test('static bar is solid pick colors, not pale tints', () => {
  assert.ok(src.includes('.sd-result.is-good{border-color:var(--sd-good);background:var(--sd-good);color:#fff}'), 'gold bar');
  assert.ok(src.includes('.sd-result.is-ok{border-color:var(--sd-ok);background:var(--sd-ok);color:#16130a}'), 'robin-blue bar');
  assert.ok(src.includes('.sd-result.is-bad{border-color:var(--sd-dead);background:var(--sd-dead);color:#fff}'), 'black bar');
});

test('static bar text is two or three words', () => {
  assert.ok(src.includes("return '✗ Dead end'"), 'dead end, 2 words');
  assert.ok(src.includes("return '✓ Shortest path'"), 'shortest path, 2 words');
  assert.ok(src.includes("return '✓ Long way round'"), 'long way round, 3 words');
  assert.ok(src.includes("const answer = yes ? 'Shortest path' : 'Not shortest path'"), 'peek, 2-3 words');
  assert.ok(!src.includes('is a dead end: no shared member'), 'old long dead-end sentence gone');
  assert.ok(!src.includes('Valid connection! But a shorter route exists'), 'old long loose sentence gone');
});

test('band pills and rail dots use solid pick colors', () => {
  assert.ok(src.includes('.game-chain-good{border-color:var(--sd-good);background:var(--sd-good);color:#fff}'), 'gold pill');
  assert.ok(src.includes('.game-chain-ok{border-color:var(--sd-ok);background:var(--sd-ok);color:#16130a}'), 'robin-blue pill');
  assert.ok(src.includes('.sd-chain-node.is-good .sd-chain-dot{border-color:var(--sd-good);background:var(--sd-good)}'), 'gold dot');
  assert.ok(src.includes('.sd-chain-node.is-ok .sd-chain-dot{border-color:var(--sd-ok);background:var(--sd-ok)}'), 'robin-blue dot');
  assert.ok(src.includes('.sd-chain-node.is-bad .sd-chain-dot{border-color:var(--sd-dead);background:var(--sd-dead)}'), 'black dot');
  assert.ok(src.includes('const dotKind ='), 'results chain assigns a dot kind');
  assert.ok(src.includes('Gold: shares a member'), 'how-to says gold, not green');
  assert.ok(src.includes('Robin blue: shares a member'), 'how-to says robin blue, not silver');
  assert.ok(src.includes('Black: no shared member'), 'how-to says black, not blue');
});

test('clock starts on first pick, pauses while hidden, never on paint', () => {
  assert.ok(!src.includes('dailyClockMark'), 'paint-based clock mark gone');
  assert.ok(src.includes('function dailyClockStart(run)'), 'first-pick start exists');
  assert.ok(src.includes('dailyClockStart(dailyRun);'), 'pick calls start');
  assert.ok(src.includes('function dailyClockPause(run)'), 'pause exists');
  assert.ok(src.includes('function dailyClockResume(run)'), 'resume exists');
  assert.ok(src.includes("document.visibilityState === 'hidden') dailyClockPause(run)"), 'hidden pauses');
  assert.ok(src.includes('dailyClockResume(run)'), 'visible resumes');
  assert.ok(src.includes("':active-ms'"), 'accumulated active time stored');
  assert.ok(src.includes("':final-s'"), 'final time frozen at results');
});

// Locked pick hexes: robin blue for long-way, black for dead end (server PICK_HEX).
test('pick hexes match the locked scheme', () => {
  assert.ok(src.includes("robin: '#9adbe8'"), 'robin hex is server robin blue');
  assert.ok(src.includes("black: '#151515'"), 'black hex is server black');
  assert.ok(src.includes('--sd-ok:#9adbe8'), 'sd-ok is robin blue');
  assert.ok(src.includes('--sd-dead:#151515'), 'sd-dead is black');
});
