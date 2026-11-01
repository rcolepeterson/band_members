// Pick-path recovery (Aaron, 2026-11-01): a completing pick landed
// server-side, but a second request hit the just-ended run and its raw
// "that run is over" overwrote the completion flow, stranding the player
// on a stuck board (Tool → Slipknot, won in 3 hops, board frozen until
// refresh). The pick catch must recover the way the give-up catch does:
// re-fetch the run and paint its real state instead of leaking the
// server's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');
const pick = src.slice(src.indexOf('async function dailyPick('), src.indexOf('async function dailyHint('));
const recovery = pick.slice(pick.indexOf('Recovery (Aaron, 2026-11-01)'));

test('pick catch recovers on "that run is over" instead of leaking it', () => {
  assert.ok(recovery.includes("err.message === 'that run is over'"), 'exact server error matched');
  assert.ok(recovery.includes("action: 'start'"), 'run re-fetched via start');
  assert.ok(recovery.includes("dailyRun.status === 'complete'"), 'completed run detected');
  assert.ok(recovery.includes('openDailyResults({ won: true })'), 'win opens results');
  assert.ok(recovery.includes("dailyRun.status === 'given_up'"), 'given-up run detected');
  assert.ok(recovery.includes('openDailyResults({ won: false })'), 'loss opens results');
  assert.ok(recovery.includes('paintDailyBoard(card);'), 'active run repaints with fresh options');
});

test('pick recovery is display-only and practice-safe', () => {
  assert.ok(recovery.includes('!practiceMode'), 'practice runs never re-deal on recovery');
  assert.ok(!recovery.includes("gaEvent('game_completed'"), 'no GA completion event from recovery');
  assert.ok(!recovery.includes("result: 'win'"), 'no server completion event from recovery');
  assert.ok(recovery.includes('That run already ended. Reload the page to see the chain and share it.'), 'plain-words fallback when re-fetch fails');
});
