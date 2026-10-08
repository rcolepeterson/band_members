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
  assert.ok(src.includes('<details class="sd-drawer sd-stats" hidden>'), 'the credits drawer is gone');
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

test('the last move stays on the board in words until the next tap', () => {
  assert.ok(src.includes('<p class="sd-result" aria-live="polite" hidden></p>'), 'result line in the board');
  assert.match(src, /dailyLastMove = data\.completed \? null : \{ kind, name: pickedName, from: fromName, members, extra \}/);
  assert.ok(src.includes('is a dead end: no shared member with ${from}. −1 move.'));
  assert.match(src, /sdToastTimer = setTimeout\(\(\) => t\.classList\.remove\('is-on'\), 3000\)/, 'toast lasts 3s');
  assert.ok(src.includes("t.onclick = () => { clearTimeout(sdToastTimer); t.classList.remove('is-on'); };"), 'tap dismisses');
});

test('practice mode (?practice=1) runs on the Solo endpoint, for fun only', () => {
  assert.ok(src.includes("new URLSearchParams(window.location.search).get('practice') === '1'"));
  assert.ok(src.includes("return practiceMode ? '/api/game-solo/play' : dailyPath;"));
  assert.ok(src.includes("{ action: 'start', fresh: true, famous: true }"), 'fresh famous pair each start');
  // Daily calls still name the daily endpoint, so the daily is untouched without the flag.
  assert.equal((src.match(/dailyFetch\(practicePath\('\/api\/game-daily\/play'\)/g) || []).length, 6);
});

test('giving up is not a hint: separate link, one confirm, honest copy', () => {
  const paint = src.slice(src.indexOf('function paintDailyBoard('), src.indexOf('function confirmDailyGiveUp('));
  const hintsAt = paint.indexOf("q('.sd-hints > summary')");
  assert.ok(!paint.slice(hintsAt).includes("tools.appendChild(giveup)"), 'give-up is not in the hints drawer');
  assert.ok(src.includes('Give up &amp; reveal the chain'), 'quiet give-up link under the board');
  assert.ok(src.includes('<h2>Give up and reveal the chain?</h2>'), 'single confirm modal');
  assert.ok(!src.includes('Today ends and the tree reveals the path'), 'cryptic copy gone');
  assert.ok(src.includes('<div class="sd-reveal-chain"></div>'), 'answer drawn as a chain on the board');
});

test('practice is permanent, for fun: no hints in the UI, no "remove this" comments', () => {
  assert.ok(src.includes("q('.sd-hints').hidden = practiceMode || !run.hints_total;"));
  assert.ok(src.includes('Practice mode: a permanent product feature, not a test hook'));
  assert.ok(!src.includes('TEMPORARY test hook'));
});

test('hops count links, moves count taps: dead ends cost a move but are not a hop', async () => {
  const { dailyChainCounts } = await import('../scripts/six-degrees-game.mjs');
  // Ramones → 4 bands → Megadeth with one dead end along the way: 5 hops, 6 moves.
  const picks = [
    { kind: 'optimal' }, { kind: 'deadend' }, { kind: 'solid' }, { kind: 'optimal' }, { kind: 'optimal' }, { kind: 'optimal' },
  ];
  assert.deepEqual(dailyChainCounts(picks), { hops: 5, deadEnds: 1, moves: 6 });
  assert.deepEqual(dailyChainCounts([]), { hops: 0, deadEnds: 0, moves: 0 });
  assert.ok(src.includes(': `Chain completed in ${hopsWord}!`'), 'title uses hops, not moves');
});

test('results show your chain band by band; share text stays spoiler-free', () => {
  assert.ok(src.includes("${won ? 'Your chain' : 'Your attempt'}"));
  assert.ok(src.includes('c.appendChild(chainRowEl([start, ...mine], run.connections || {}));'));
});

test('Ask the tree is obvious: drawer closes, choices glow, cancellable, answer on the board', () => {
  assert.ok(src.includes("peek.addEventListener('click', () => armDailyAsk(card));"));
  assert.match(src, /function armDailyAsk\(card\) \{[\s\S]{0,400}drawer\.open = false;[\s\S]{0,200}classList\.add\('is-asking'\)/);
  assert.ok(src.includes('`The tree says ${data.hint.option.name} is on the shortest path.`'));
  assert.ok(src.includes("optsBox.classList.remove('is-busy', 'is-asking');"));
});

test('a new board clears a leftover toast', () => {
  assert.match(src, /async function renderDailyBoard[\s\S]{0,300}clearTimeout\(sdToastTimer\);\s*document\.querySelector\('\.sd-toast'\)\?\.classList\.remove\('is-on'\);/);
});

test('no credits anywhere on the daily board: free hints, streak in the header', () => {
  const board = src.slice(src.indexOf('function paintDailyBoard('), src.indexOf('function armDailyAsk('));
  assert.ok(!/credits/.test(board.replace(/\/\/.*$/gm, '')), 'no credit UI in the board painter');
  assert.ok(board.includes('`Get a hint (${hintsLeft} left today)`'));
  assert.ok(board.includes('elim.disabled = peek.disabled = hintsLeft === 0;'), 'gray out at zero');
  // (The old Solo board, unreachable while SHOW_MODE_SWITCHER is false, still has its own.)
  const daily = src.slice(src.indexOf('async function renderDailyBoard('), src.indexOf('function renderSoloBoard('));
  assert.ok(!daily.includes('Freeze my streak (100)') && !daily.includes('(−50)') && !daily.includes('Unlock (75)'));
  assert.ok(src.includes("`${run.streak}-day streak`") && src.includes("iconText(lineIcon('flame'), streak)"));
});

test("game over says Show's over, and the subtext matches how you lost", () => {
  assert.match(src, /function dailyGameOverText\(run\) \{[\s\S]{0,300}sub: ranOut \? 'You ran out of moves\.' : 'You gave up on this one\.'/);
  const daily = src.slice(src.indexOf('async function renderDailyBoard('), src.indexOf('function renderSoloBoard('));
  assert.ok(!daily.includes('The tree wins'), 'no "the tree wins" copy on the daily screens');
  assert.ok(src.includes('<div class="sd-gameover"><p class="sd-gameover-title"></p><p class="sd-gameover-sub"></p></div>'));
});

test('countdown to the next chain is measured to midnight Pacific, shown as HH:MM:SS', async () => {
  const { secondsToNextChain, fmtCountdown } = await import('../scripts/six-degrees-game.mjs');
  // 07:00Z on Oct 8 is exactly midnight PDT: a full day to the next chain.
  assert.equal(secondsToNextChain(new Date('2026-10-08T07:00:00Z')), 86400);
  assert.equal(secondsToNextChain(new Date('2026-10-08T06:59:59Z')), 1);
  // 3pm PDT → 9 hours left, wherever the player is.
  assert.equal(secondsToNextChain(new Date('2026-10-08T22:00:00Z')), 9 * 3600);
  assert.equal(fmtCountdown(3725), '01:02:05');
  assert.equal(fmtCountdown(-4), '00:00:00');
  assert.ok(!src.includes('A new chain drops at midnight Pacific.'));
});

test('plain English: "Shortest path", "Share score", full band names', () => {
  assert.ok(src.includes('`Shortest path: ${run.par} hops`'));
  assert.ok(src.includes("[par, 'Shortest'],"));
  assert.equal((src.match(/\$\{lineIcon\('share'\)\} Share score/g) || []).length, 2);
  assert.ok(!src.includes('>See results<'));
  assert.match(src, /\.sd-board \.game-chain-pill,\.sd-modal \.game-chain-pill\{white-space:normal;overflow:visible;text-overflow:clip/);
});

test('musician names: compact on the chain row, full in sentences', async () => {
  const { fmtMembersShort, fmtMembersLong } = await import('../scripts/six-degrees-game.mjs');
  assert.equal(fmtMembersShort(['Tom Morello']), 'Tom Morello');
  assert.equal(fmtMembersShort(['Tom Morello', 'Tim Commerford', 'Brad Wilk']), 'Tom Morello +2');
  assert.equal(fmtMembersShort([]), '');
  assert.equal(fmtMembersLong(['Chris Cornell']), 'Chris Cornell');
  assert.equal(fmtMembersLong(['Tom Morello', 'Tim Commerford', 'Brad Wilk']), 'Tom Morello, Tim Commerford and Brad Wilk');
  assert.equal(fmtMembersLong(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more');
});

test('long-way-round copy names the exact extra moves', () => {
  assert.ok(src.includes('`✓ Valid connection! But a shorter route exists${cost}.${via}`'));
  assert.ok(src.includes('const extra = distBefore != null && distAfter != null ? distAfter + 1 - distBefore : null;'));
});

test('rawk, not Wordle: guitar picks on screen, line icons instead of emoji', () => {
  // On-screen emoji are gone from the daily screens (share text keeps its emoji).
  const daily = src.slice(src.indexOf('async function renderDailyBoard('), src.indexOf('function renderSoloBoard('));
  for (const e of ['💡', '🔥', '🎉', '🏆', '💀', '🌳', '📤']) assert.ok(!daily.includes(e), `${e} removed from the daily screens`);
  // The results score line is drawn as picks, colored like the board.
  assert.ok(src.includes("w.innerHTML = pickSvg(pickColor(p.kind), 'sd-result-pick');"));
  assert.ok(src.includes("const DAILY_PICK_HEX = { gold: '#3fa36b', robin: '#c9a83a', black: '#c8584f' };"));
  // Icons are drawn like the main site's: no fill, currentColor stroke 1.8, round caps.
  assert.match(src, /class="sd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.8" stroke-linecap="round"/);
});
