// Share parity + first-move GA events (Aaron, 2026-10-28). Two gaps found
// while reconciling Cole's Oct 27 GA email against the game database:
//  - the phone share path fired GA share_clicked, the desktop clipboard
//    path did not, so GA undercounted desktop shares;
//  - GA had no pick event at all, so "First moves" read 0 while the DB
//    showed 20 players moving that day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');

test('both share paths fire GA share_clicked and the server share event', () => {
  const fn = src.slice(src.indexOf('async function shareDailyText('), src.indexOf('async function shareDailyText(') + 4000);
  assert.ok(fn.includes("gaEvent('share_clicked'"), 'phone path fires GA share');
  assert.equal((fn.match(/gaEvent\('share_clicked'/g) || []).length, 2, 'desktop clipboard path fires it too');
  assert.equal((fn.match(/trackDailyShare\(\)/g) || []).length, 2, 'both paths fire the server event');
});

test('first pick of a run fires a once-per-run GA first_move event', () => {
  const pick = src.slice(src.indexOf('async function dailyPick('), src.indexOf('async function dailyPick(') + 6000);
  assert.ok(pick.includes("gaEvent('first_move'"), 'first_move event exists');
  assert.ok(pick.includes('analyticsMoveCount === 1'), 'only the first move fires it');
  assert.ok(pick.includes('gaCountsRun(dailyRun)'), 'first attempts only, like game_started');
  assert.ok(pick.includes("}, dailyRun.id);") || pick.includes("dailyRun.id)"), 'run id keys it once per run');
});

test('share-preview count covers the out-of-moves share button', () => {
  const t = readFileSync(join(root, 'tests/daily-share-preview.test.mjs'), 'utf8');
  assert.ok(t.includes("length, 3, 'win, loss, and out-of-moves boards"), 'CI count updated for the third share button');
});
