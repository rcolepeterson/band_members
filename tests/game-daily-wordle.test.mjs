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

test('a win names start and target, one square per move, no band spoilers', () => {
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
  // Wordle-style: score line, squares, link. No slogan.
  assert.equal(text, [
    'Six Degrees of Rock #9 🎸 4/4', // no timer
    'Nirvana ➡️ 🟩🟥🟨🟩 ➡️ Metallica', // one square per move
    'sixdegreesofrock.com/game',
  ].join('\n'));
  for (const spoiler of ['Foo Fighters', 'Pearl Jam', 'Probot']) assert.ok(!text.includes(spoiler));
});

test('a loss scores X, like Wordle', () => {
  const text = dailyShareResultText({
    date: '2026-10-08', start: 'Nirvana', target: 'Metallica',
    picks: [{ kind: 'deadend' }, { kind: 'solid' }], moves: 2, par: 4, won: false,
  });
  assert.equal(text, [
    'Six Degrees of Rock #9 🎸 X/4',
    'Nirvana ➡️ 🟥🟨 ➡️ Metallica',
    'sixdegreesofrock.com/game',
  ].join('\n'));
  assert.ok(!/Can you|beat my chain|crack it/.test(text), 'no slogan');
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
  assert.ok(src.includes('c.appendChild(chainListEl([start, ...mine], run.connections || {}));'));
});

test('Check a band (formerly Ask the tree) is obvious: drawer closes, choices glow, cancellable, answer on the board', () => {
  assert.ok(src.includes("peek.addEventListener('click', () => armDailyAsk(card));"));
  assert.match(src, /function armDailyAsk\(card\) \{[\s\S]{0,400}drawer\.open = false;[\s\S]{0,200}classList\.add\('is-asking'\)/);
  assert.ok(src.includes('`${data.hint.option.name} is on the shortest path.`'));
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
  // "Share score" became a one-tap "Share result" (Wordle-style, 2026-10-08).
  assert.equal((src.match(/\$\{lineIcon\('share'\)\} Share result/g) || []).length, 2);
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

test('results: vertical chain list, one pick per move, no duplicate hops stat', () => {
  assert.ok(src.includes('c.appendChild(chainListEl([start, ...mine], run.connections || {}));'));
  assert.match(src, /function chainListEl\(nodes, connections = \{\}\) \{[\s\S]{0,800}querySelector\('\.sd-chain-via-names'\)\.textContent = fmtMembersLong\(names\);/);
  assert.ok(src.includes('for (const p of picks) {'), 'every move gets a pick');
  const rows = src.slice(src.indexOf('const statRows = ['), src.indexOf('const statRows = [') + 200);
  assert.ok(!rows.includes("'Hops'"), 'hops stat dropped (the headline says it)');
  assert.ok(src.includes('.sd-modal-close:focus:not(:focus-visible){outline:none;box-shadow:none}'));
});

test('game-over board shows one chain, the answer, top to bottom', () => {
  const giveup = src.slice(src.indexOf('function paintDailyGiveUp('), src.indexOf('function paintDailyGiveUp(') + 1500);
  assert.ok(giveup.includes("card.querySelector('.game-chain-pills').style.display = 'none';"), 'your row is hidden on a loss');
  assert.ok(giveup.includes('finish.appendChild(chainListEl(run.reveal_path.map('), 'answer is the vertical list');
});

test('chain timeline: one rail, dots, names aligned; finished boards collapse empty areas', () => {
  assert.ok(src.includes('.sd-chain-list::before{'), 'continuous rail');
  assert.ok(src.includes('<span class="sd-chain-dot" aria-hidden="true"></span>'));
  assert.ok(src.includes('.sd-chain-via{padding-left:26px;'), 'via lines align with band names (12px dot + 14px gap)');
  assert.ok(src.includes("card.classList.toggle('is-over', !active);"));
  assert.ok(src.includes('.sd-board.is-over .sd-prompt:empty'));
});

test('one share action, like Wordle: text only, no share image', () => {
  assert.ok(!src.includes('Share image'), 'no share-image button');
  assert.ok(!src.includes('function drawDailyShareCard'), 'PNG card code removed');
  assert.ok(src.includes('shareDailyText(results, dailyResultShareText(true, c))'), 'board shares in one tap');
  assert.ok(src.includes('const text = dailyResultShareText(won, completed);'), 'modal uses the same text');
});

test('no "tree" jargon in game copy; the music map link comes after the game', () => {
  const strings = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const phrase of ['Ask the tree', 'The tree says', 'beat the tree in', 'The tree wins', 'the tree reveals', 'Could not load the tree', "isn't in the tree"]) {
    assert.ok(!strings.includes(phrase), `"${phrase}" removed`);
  }
  assert.ok(src.includes("a.href = '/?band=' + encodeURIComponent(run.start_band.name);"), 'map opens on today\'s start band');
  assert.equal((src.match(/finish\.appendChild\(musicMapLinkEl\(run\)\);/g) || []).length, 2, 'win and loss boards');
  assert.ok(src.includes('const mapLink = musicMapLinkEl(run);'), 'results modal');
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'game/index.html'), 'utf8');
  assert.ok(!html.includes('Back to the tree'), 'no exit button in the header');
  assert.match(html, /<a class="arena-wordmark" href="\/">/, 'the wordmark still links home');
});

test('feedback: out of the header, in the footer and on the results screen', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'game/index.html'), 'utf8');
  const header = html.slice(html.indexOf('<div class="arena-header-actions">'), html.indexOf('</header>'));
  assert.ok(!header.includes('send-feedback-btn'), 'not in the header');
  const footer = html.slice(html.indexOf('<footer class="arena-foot">'), html.indexOf('</footer>'));
  assert.ok(footer.includes('id="send-feedback-btn"'), 'in the footer, same id so the popover wiring is unchanged');
  assert.ok(src.includes('Something off? <button type="button" class="sd-linkbtn">Send feedback</button>'));
});

test('/game has its own link-preview image', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'game/index.html'), 'utf8');
  assert.match(html, /<meta property="og:image" content="https:\/\/sixdegreesofrock\.com\/game-og\.png\?v=2" \/>/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/sixdegreesofrock\.com\/game-og\.png\?v=2" \/>/);
  const png = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'game-og.png'));
  assert.equal(png.readUInt32BE(16), 1200, 'width');
  assert.equal(png.readUInt32BE(20), 630, 'height');
});

test('SEO: /game canonical is the served URL, structured data on both pages, both in the sitemap', () => {
  const read = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
  const game = read('game/index.html');
  // /game 301s to /game/; a canonical pointing at a redirect is a crawl error.
  assert.match(game, /<link rel="canonical" href="https:\/\/sixdegreesofrock\.com\/game\/" \/>/);
  assert.match(game, /<meta property="og:url" content="https:\/\/sixdegreesofrock\.com\/game\/" \/>/);
  for (const [file, html] of [['game', game], ['home', read('index.html')]]) {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(m, `${file} has JSON-LD`);
    JSON.parse(m[1]); // must be valid JSON
  }
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /<loc>https:\/\/sixdegreesofrock\.com\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/sixdegreesofrock\.com\/game\/<\/loc>/);
});

test('stats screen: header button, block in the daily results, not in practice', () => {
  assert.ok(src.includes('<button type="button" class="sd-icon" data-stats aria-label="Your stats">'));
  assert.ok(src.includes("if (practiceMode) statsBtn.style.display = 'none';"), 'hidden for real in practice');
  assert.ok(!src.includes('touch received'), 'temporary diagnostic removed');
  assert.ok(src.includes("body: JSON.stringify({ action: 'stats' }),"));
  // Labels short enough to stay on one line on a phone.
  assert.match(src, /function statsBlockEl\(st, highlight, \{ label = true \} = \{\}\) \{[\s\S]{0,800}'Played'\], \[st\.win_pct, 'Win %'\], \[st\.current_streak, 'Streak'\], \[st\.max_streak, 'Best streak'\]/);
});
