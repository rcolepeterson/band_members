// The /game front door (Cole, 2026-10-11): a Wordle-style start screen.
// Logo, one line, Play (+ Sign in when signed out), today's date and number,
// "By Six Degrees of Rock". See game/index.html and renderDailyPanel in
// scripts/six-degrees-game.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { frontDoorPlayLabel, dailyPuzzleNumber, DAILY_EPOCH } from '../scripts/six-degrees-game.mjs';

const page = readFileSync(new URL('../game/index.html', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../scripts/six-degrees-game.mjs', import.meta.url), 'utf8');
const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Runs the head script that decides whether the front door shows.
function doorShows(search, pending = {}) {
  const script = page.match(/<script>\s*\/\/ The front door[\s\S]*?<\/script>/)[0].replace(/<\/?script>/g, '');
  const classes = new Set();
  vm.runInNewContext(script, {
    location: { search },
    sessionStorage: { getItem: (k) => pending[k] || null },
    document: { documentElement: { classList: { add: (c) => classes.add(c) } } },
  });
  return classes.has('fd-on');
}

test('a plain visit and a share link get the front door', () => {
  assert.equal(doorShows(''), true);
  assert.equal(doorShows('?s=1'), true);
  assert.equal(doorShows('?internal=1'), true);
});

test('links that already mean "play" go straight in', () => {
  for (const q of ['?practice=1', '?invite=abc', '?match=xyz', '?game', '?game=1', '?s=1&invite=abc']) {
    assert.equal(doorShows(q), false, q);
  }
  assert.equal(doorShows('', { sdr_pending_daily: '1' }), false, 'back from sign-in');
  assert.equal(doorShows('', { sdr_pending_solo: '1' }), false);
});

test('the screen: logo, one line, Play, Sign in, date and number, credit', () => {
  const door = page.match(/<section class="front-door"[\s\S]*?<\/section>/)[0];
  // "6°" is the name (Aaron, 2026-10-11); "Daily Chain" is retired.
  assert.match(door, /<h1 class="fd-logo"[^>]*>6&deg;<\/h1>/);
  assert.doesNotMatch(door, /Daily Chain/);
  assert.match(door, /A daily rock puzzle\.<\/span> Connect two bands through the musicians they share\./);
  assert.match(door, /<button type="button" class="fd-play" data-fd-play>Play<\/button>/);
  assert.match(door, /<a class="fd-signin" data-fd-signin href="\/\?signin=game">Sign in<\/a>/);
  assert.match(door, /data-fd-date/);
  assert.match(door, /data-fd-number/);
  assert.match(door, /<a href="mailto:sixdegreesofrock@gmail\.com">By Six Degrees of Rock<\/a>/);
  assert.doesNotMatch(door, /<nav|role="tab"|<select/, 'no menus, tabs or decisions');
});

test('the puzzle number on the door counts from the same day one as the share text', () => {
  assert.equal(DAILY_EPOCH, '2026-09-30');
  assert.match(page, /Date\.UTC\(2026, 8, 30\)/);
  assert.equal(dailyPuzzleNumber('2026-10-11'), 12);
});

test('a returning player sees Continue or their result instead of Play', () => {
  assert.equal(frontDoorPlayLabel('none'), 'Play');
  assert.equal(frontDoorPlayLabel(undefined), 'Play');
  assert.equal(frontDoorPlayLabel('active'), 'Continue');
  assert.equal(frontDoorPlayLabel('complete'), 'See today’s result');
  assert.equal(frontDoorPlayLabel('given_up'), 'See today’s result');
});

test('nothing is dealt until Play: the daily waits for the door', () => {
  const panel = engine.match(/function renderDailyPanel\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(panel, /if \(frontDoorUp\(\)\)/);
  assert.match(panel, /addEventListener\('sdr-front-door-play'/);
  assert.match(page, /dispatchEvent\(new Event\('sdr-front-door-play'\)\)/);
  // A first visit asks the server nothing; only a returning player's status.
  const init = engine.match(/function initFrontDoor\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(init, /if \(!returning\) return;/);
});

test('sign-up from the game opens on the homepage and comes back', () => {
  assert.doesNotMatch(engine, /showSignInModal/, 'the dead Create free account button is gone');
  assert.match(engine, /if \(btn\) btn\.addEventListener\('click', requestDailySignup\);/);
  assert.doesNotMatch(engine, /sdr_pending_(daily|solo)', '1'\); \} catch \{\}\n\s*(if \(isArenaPage\(\)\) )?window\.location\.href = '\/';/);
  assert.match(page, /window\.openSignupPopover = function \(\) \{ window\.location\.href = '\/\?signin=game'; \};/);
  // The homepage opens its sign-in panel, then sends a signed-in player back.
  assert.match(home, /signin=game\(&\|\$\)\/\.test\(location\.search\) && !loadCurrentUser\(\)\) \{\n\s*setTimeout\(\(\) => \{ try \{ openSignInFlow\(\); \}/);
  assert.match(home, /sessionStorage\.setItem\('sdr_pending_daily', '1'\); \} catch \(_\) \{\}\n\s*window\.location\.replace\('\/game\/'\);/);
});

test('6° naming: share text, puzzle label, past days', async () => {
  const { dailyShareResultText } = await import('../scripts/six-degrees-game.mjs');
  const text = dailyShareResultText({ date: '2026-10-11', start: 'A', target: 'B', picks: [{ kind: 'optimal' }], won: true });
  assert.equal(text.split('\n')[0], '6\u00b0 Rock #12 🎸 Solved in 1 move');
  assert.doesNotMatch(engine, /Daily Chain<\/span>/);
  assert.match(engine, /<span class="game-hops">Today\\u2019s Puzzle<\/span>/);
  assert.match(engine, /textContent = `Puzzle #\$\{dailyPuzzleNumber\(date\)\}`;/);
});
