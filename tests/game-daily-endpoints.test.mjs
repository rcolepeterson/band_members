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
// Credits were removed for launch (2026-10-08): hints are free within the
// per-run budget; the (now UI-less) escape still spends atomically.
test('hints are free; escape still deducts credits atomically', () => {
  const body = src('netlify/functions/game_daily_play.mjs');
  assert.ok(body.includes('where id = ${userId} and credits >= ${amount}'));
  const hint = body.slice(body.indexOf("if (action === 'hint') {"), body.indexOf("if (action === 'escape') {"));
  assert.ok(!hint.includes('spendCredits('), 'hints spend nothing');
  assert.ok(hint.includes('no hints left today'), 'the per-run budget still applies');
});

// Archive unlocks are atomic too.
test('past days are free to unlock (no credits for launch)', () => {
  const body = src('netlify/functions/game_daily_archive.mjs');
  assert.ok(!body.includes('credits = credits - ${ARCHIVE_COST}'));
  assert.ok(body.includes('insert into daily_unlocks'));
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
  // Reveals the shortest path (preferring a famous route when one is as short).
  assert.ok(body.includes('bfsPath(adj, chain.band_a, chain.band_b'));
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

test('start deals today\'s chain on demand instead of 404ing before the first GET', () => {
  const play = src('netlify/functions/game_daily_play.mjs');
  assert.match(play, /import \{ loadBandGraph, ensureChain \} from '\.\/game_daily\.mjs'/);
  assert.match(play, /date === pacificDate\(\)\s*\?\s*await ensureChain\(sql, date\)/);
  assert.match(src('netlify/functions/game_daily.mjs'), /export async function ensureChain\(sql, date\)/);
});

test('every in-run daily action names the run\'s day, not just start', () => {
  const client = src('scripts/six-degrees-game.mjs');
  for (const action of ["action: 'giveup'", "action: 'pick', option_id: optionId"]) {
    const daily = client.split('/api/game-daily/play').slice(1).some((chunk) =>
      chunk.slice(0, 200).includes(`{ ${action}, ...dailyDate() }`));
    assert.ok(daily, `${action} should send dailyDate()`);
  }
});

test('the slate never offers a step backwards (start band or bands already in the chain)', () => {
  const play = src('netlify/functions/game_daily_play.mjs');
  assert.match(play, /const visited = \[chain\.band_a, \.\.\.\(run\.picks \|\| \[\]\)\.filter\(\(p\) => p\.kind !== 'deadend'\)\.map\(\(p\) => p\.band_id\)\]/);
  assert.match(play, /excludeIds: new Set\(\[\.\.\.deadPicked, \.\.\.visited,/);
});

// Band data caching (2026-10-08): public data, so browsers and the CDN may
// reuse it briefly; editors bypass the cache after their own writes.
test('/api/bands is cached briefly, errors are not, and writes bypass it client-side', () => {
  const neon = src('netlify/functions/bands_neon.mjs');
  assert.match(neon, /BANDS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=3600'/);
  // Netlify's CDN keeps it an hour to spare Neon transfer (2026-10-10; Neon's
  // monthly transfer limit was hit).
  assert.match(neon, /BANDS_CDN_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=3600, durable'/);
  assert.match(neon, /'netlify-cdn-cache-control': BANDS_CDN_CACHE_CONTROL/);
  assert.match(neon, /return serverError\('could not load bands'/, 'errors still go through json() (no-store)');
  const html = src('index.html');
  assert.match(html, /const response = await fetch\(\.\.\.bandsFetchArgs\(\)\);/);
  assert.match(html, /return \['\/api\/bands\?v=' \+ changedAt, \{ cache: 'no-store' \}\];/);
  assert.match(html, /if \(method !== 'GET' && method !== 'HEAD' && BAND_WRITE_PATH\.test\(path\)\)/);
});
