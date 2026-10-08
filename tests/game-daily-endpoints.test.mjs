// Endpoint tests for the Daily Chain:
//
//   GET  /api/game-daily            (today's chain; public lure)
//   POST /api/game-daily/play       (start/pick/hint/escape/status; auth)
//   GET/POST /api/game-daily/archive (auth)
//   GET/POST /api/game-credits      (auth)
//   POST /api/game-credits/purchase (stub; auth)
//
// Same strategy as tests/game-handles.test.mjs: with NETLIFY_DATABASE_URL
// unset the handlers short-circuit with 503, which verifies the
// auth/validation/response layer without standing up Postgres. The pure
// economy logic lives in netlify/functions/_daily.mjs (see
// tests/game-daily.test.mjs); the credit/SQL guards here are pinned by
// exact-source assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import gameDaily from '../netlify/functions/game_daily.mjs';
import gameDailyPlay from '../netlify/functions/game_daily_play.mjs';
import gameDailyArchive from '../netlify/functions/game_daily_archive.mjs';
import gameCredits from '../netlify/functions/game_credits.mjs';
import gameCreditsPurchase from '../netlify/functions/game_credits_purchase.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

function req(method, url, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request(url, init);
}

// Temporarily unset DB URL so handlers return 503 (the "no DB" path).
function withoutDb(fn) {
  return async () => {
    const before = process.env[DB_URL_ENV];
    delete process.env[DB_URL_ENV];
    try {
      await fn();
    } finally {
      if (before !== undefined) process.env[DB_URL_ENV] = before;
    }
  };
}

// --- 503 without DB ------------------------------------------------------------

test('GET /api/game-daily 503s without DB (public: auth not checked first)', withoutDb(async () => {
  const res = await gameDaily(req('GET', 'https://example.test/api/game-daily'));
  assert.equal(res.status, 503);
}));

test('POST /api/game-daily/play 503s without DB before auth', withoutDb(async () => {
  const res = await gameDailyPlay(
    req('POST', 'https://example.test/api/game-daily/play', {}, { action: 'status' }),
  );
  assert.equal(res.status, 503);
}));

test('GET /api/game-daily/archive 503s without DB before auth', withoutDb(async () => {
  const res = await gameDailyArchive(req('GET', 'https://example.test/api/game-daily/archive'));
  assert.equal(res.status, 503);
}));

test('GET /api/game-credits 503s without DB before auth', withoutDb(async () => {
  const res = await gameCredits(req('GET', 'https://example.test/api/game-credits'));
  assert.equal(res.status, 503);
}));

// --- purchase stub ---------------------------------------------------------------

test('POST /api/game-credits/purchase 503s without DB', withoutDb(async () => {
  const res = await gameCreditsPurchase(
    req('POST', 'https://example.test/api/game-credits/purchase', {}, { pack: 'small' }),
  );
  assert.equal(res.status, 503);
}));

test('purchase stub returns "Credit packs are coming soon." verbatim', () => {
  const body = src('netlify/functions/game_credits_purchase.mjs');
  assert.ok(body.includes("Credit packs are coming soon."));
});

// --- economy wiring (exact-source pins) --------------------------------------------

// New users must start with 50 credits so the first hint is free to try.
test('migrate gives new users 50 credits by default', () => {
  const body = src('netlify/functions/migrate.mjs');
  assert.ok(body.includes('alter table users add column if not exists credits'));
  assert.ok(body.includes('credits      integer not null default 50'));
  assert.ok(body.includes('freeze_count integer not null default 0'));
});

// The run table carries option kinds server-side; the client never sees them.
test('play strips option kinds before sending the slate to the client', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes("return (stored || []).map((o) => ({ id: o.band_id, name: o.name }))"));
});

// Credit spends are atomic: deduct only when the balance covers it.
test('hint and escape deduct credits atomically', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes('where id = ${userId} and credits >= ${amount}'));
});

// Archive unlocks are atomic too.
test('archive unlock deducts atomically', () => {
  const body = src('netlify/functions/game_daily_archive.mjs');
  assert.ok(body.includes('where id = ${me.id} and credits >= ${ARCHIVE_COST}'));
});

// Freeze purchase is atomic and increments the freeze count.
test('buy_freeze deducts and increments atomically', () => {
  const body = src('netlify/functions/game_credits.mjs');
  assert.ok(body.includes('freeze_count = freeze_count + 1'));
  assert.ok(body.includes('where id = ${me.id} and credits >= ${FREEZE_COST}'));
});

// Completing a run scores through the replay-aware scorer (first completion,
// beat-your-best replays, beat-the-tree bounty).
test('completing a run pays the completion reward and the par bonus', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes('scoreRun({ isFirst, hopsUsed, par: oldPar, prevBest })'));
  const econ = src('netlify/functions/_daily.mjs');
  assert.ok(econ.includes('COMPLETION_REWARD'));
  assert.ok(econ.includes('OPTIMAL_BONUS'));
  assert.ok(econ.includes('REPLAY_IMPROVEMENT_PER_HOP'));
  assert.ok(econ.includes('BEAT_TREE_BOUNTY'));
});

// Match wins pay out of the same economy.
test('a completed match pays the winner', () => {
  const body = src('netlify/functions/game_match_play.mjs');
  assert.ok(body.includes('credits = credits + ${MATCH_WIN_REWARD}'));
});

// Archive days gate behind the unlock row (or a finished run).
test('past days need an unlock row or a finished run', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes('select chain_date from daily_unlocks'));
});

// Hints are budgeted per run; the budget is floor(optimal/2).
test('hint budget comes from hintsFor', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes('const total = hintsFor(chain.optimal_hops)'));
});

// Eliminating never burns the optimal pick.
test('eliminate never removes the optimal option', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes("if (!victim || victim.kind === 'optimal') return badRequest('nothing to eliminate')"));
});

// Give-up reveals the par path, ends the day, and pays nothing.
test('giveup marks the run given_up with no credit payout', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes("action === 'giveup'"));
  assert.ok(body.includes("status = 'given_up'"));
  assert.ok(body.includes('bfsPath(adj, chain.band_a, chain.band_b)'));
  // The giveup block must not award credits.
  const giveupBlock = body.slice(body.indexOf("action === 'giveup'"));
  const nextAction = giveupBlock.indexOf("return badRequest('unknown action')");
  assert.ok(!giveupBlock.slice(0, nextAction).includes('credits = credits +'));
});

// The client shows the chain as pills (Aaron: the text trail was confusing)
// and offers the reveal, plus a persistent player/credits line.
test('client renders chain pills, a player line, and a show-me-the-chain button', () => {
  const body = src('scripts/six-degrees-game.mjs');
  assert.ok(body.includes('game-chain-pills'));
  assert.ok(body.includes('game-player-line'));
  assert.ok(!body.includes('game-daily-trail'));
  assert.ok(body.includes('Show me the chain'));
  assert.ok(body.includes("action: 'giveup'"));
});
