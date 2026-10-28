// Give-up recovery + share-without-giving-up (Aaron, 2026-10-28): running
// out of moves stranded the player on the out-of-moves board with the
// server's raw "that run is over" error and no way to share the loss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');

test('out-of-moves board has Share result next to Show me the chain', () => {
  const branch = src.slice(src.indexOf("if (run.hops_used >= dailyMoveLimit(run.par))"), src.indexOf("if (run.hops_used >= dailyMoveLimit(run.par))") + 1200);
  assert.ok(branch.includes('Show me the chain'), 'reveal button still there');
  assert.ok(branch.includes('Share result'), 'share button on the out-of-moves board');
  assert.ok(branch.includes('dailyResultShareText(false)'), 'share text is the loss text, no give-up needed');
  assert.ok(branch.includes('dailyResultShareLink(false)'), 'share link carries the loss pick row');
});

test('give-up has an in-flight guard so the auto give-up and a tap cannot race', () => {
  assert.ok(src.includes('let dailyGiveUpInFlight = false'), 'guard flag exists');
  assert.ok(src.includes('if (dailyGiveUpInFlight) return;'), 'second give-up returns early');
  assert.ok(src.includes('dailyGiveUpInFlight = false;'), 'guard resets');
});

test('give-up recovers from "that run is over" instead of printing the raw error', () => {
  assert.ok(src.includes("err.message === 'that run is over'"), 'recovery triggers on that exact server error');
  assert.ok(src.includes("body: JSON.stringify({ action: 'start'"), 'recovery re-fetches the run');
  assert.ok(src.includes("if (dailyRun.status === 'given_up') openDailyResults({ won: false })"), 'recovered given-up run opens the results modal with Share');
  assert.ok(src.includes('That run already ended. Reload the page to see the chain and share it.'), 'human fallback, not the raw server error');
});
