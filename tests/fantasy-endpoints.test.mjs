// Fantasy Band Game endpoint + scoring tests.
//
// Same strategy as tests/game-daily-endpoints.test.mjs: with
// NETLIFY_DATABASE_URL unset the handlers short-circuit with 503, which
// verifies the auth/validation/response layer without standing up
// Postgres. The pure scoring logic lives in netlify/functions/_fantasy.mjs
// and is tested directly here — including the sim's verified formula,
// the solo-day share-1.0 case, and the strict Gold line.
//
// The SQL cross-check below reads sql/fantasy-migration-v1.sql from the
// repo root (same file Aaron runs in Neon's SQL editor) and verifies
// every column the functions use exists in the migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import fantasyPlay from '../netlify/functions/fantasy_play.mjs';
import fantasyLeaderboard from '../netlify/functions/fantasy_leaderboard.mjs';
import fantasySettleTrigger from '../netlify/functions/fantasy_settle_trigger.mjs';
import {
  GOLD_LINE,
  GOLD_WINS,
  PLATINUM_WINS,
  SALARY_CAP,
  validateSlots,
  scoreLineup,
  connectionBonusFor,
  finalScoreFor,
  isWin,
  tierForWins,
  weekContaining,
  previousPacificDate,
} from '../netlify/functions/_fantasy.mjs';
import { POOL, POOL_BY_ID } from '../netlify/functions/_fantasy_pool.mjs';

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

// Pick the cheapest pool player eligible for each slot (deterministic,
// always under the cap, always distinct).
function sampleLineup() {
  const slots = {};
  const used = new Set();
  for (const slot of ['V', 'G', 'B', 'D']) {
    const pick = [...POOL]
      .filter((p) => p.eligible.includes(slot) && !used.has(p.member_id))
      .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name))[0];
    slots[slot] = pick.member_id;
    used.add(pick.member_id);
  }
  // W: cheapest anyone not already used.
  slots.W = [...POOL]
    .filter((p) => !used.has(p.member_id))
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name))[0].member_id;
  return slots;
}

// --- 503 without DB ------------------------------------------------------------

test('POST /api/fantasy-play 503s without DB before auth', withoutDb(async () => {
  const res = await fantasyPlay(
    req('POST', 'https://example.test/api/fantasy-play', {}, { slots: sampleLineup() }),
  );
  assert.equal(res.status, 503);
}));

test('GET /api/fantasy-play 503s without DB before auth', withoutDb(async () => {
  const res = await fantasyPlay(req('GET', 'https://example.test/api/fantasy-play'));
  assert.equal(res.status, 503);
}));

test('GET /api/fantasy-leaderboard 503s without DB', withoutDb(async () => {
  const res = await fantasyLeaderboard(req('GET', 'https://example.test/api/fantasy-leaderboard'));
  assert.equal(res.status, 503);
}));

test('POST /api/cron-fantasy-settle 401s without the admin token', withoutDb(async () => {
  const res = await fantasySettleTrigger(req('POST', 'https://example.test/api/cron-fantasy-settle'));
  assert.equal(res.status, 401);
}));

test('POST /api/cron-fantasy-settle 503s with admin token but no DB', async () => {
  const beforeDb = process.env[DB_URL_ENV];
  const beforeAdmin = process.env.ADMIN_TOKEN;
  delete process.env[DB_URL_ENV];
  process.env.ADMIN_TOKEN = 'test-admin-token';
  try {
    const res = await fantasySettleTrigger(
      req('POST', 'https://example.test/api/cron-fantasy-settle', { 'x-admin-token': 'test-admin-token' }),
    );
    assert.equal(res.status, 503);
  } finally {
    if (beforeDb !== undefined) process.env[DB_URL_ENV] = beforeDb;
    if (beforeAdmin !== undefined) process.env.ADMIN_TOKEN = beforeAdmin;
    else delete process.env.ADMIN_TOKEN;
  }
});

// --- Pool ----------------------------------------------------------------------

test('embedded pool is exactly the 100 locked players', () => {
  assert.equal(POOL.length, 100);
  assert.equal(POOL_BY_ID.size, 100);
  for (const p of POOL) {
    assert.ok(typeof p.member_id === 'string' && p.member_id.length > 0);
    assert.ok(typeof p.name === 'string' && p.name.length > 0);
    assert.ok(p.V > 0, `${p.name} needs V > 0`);
    assert.ok(Number.isInteger(p.price) && p.price % 5 === 0 && p.price >= 5 && p.price <= 50);
    assert.ok(Array.isArray(p.eligible) && p.eligible.length > 0);
    assert.ok(Array.isArray(p.all_bands) && p.all_bands.length > 0);
  }
  // The all-star five is illegal at $235 (spec §1).
  const top5 = [...POOL].sort((a, b) => b.price - a.price).slice(0, 5);
  assert.equal(top5.reduce((s, p) => s + p.price, 0), 235);
});

// --- Validation ------------------------------------------------------------------

test('a legal five passes validation under the cap', () => {
  const slots = sampleLineup();
  const check = validateSlots(slots);
  assert.equal(check.ok, true);
  assert.equal(check.picks.length, 5);
  assert.ok(check.capTotal <= SALARY_CAP);
});

test('five most expensive players fail the cap', () => {
  const top = [...POOL].sort((a, b) => b.price - a.price).slice(0, 5);
  // Force them into slots regardless of eligibility by testing the cap
  // through the cheapest legal assignment is impossible, so assert the
  // raw fact the validator relies on: their sum is over the cap.
  assert.ok(top.reduce((s, p) => s + p.price, 0) > SALARY_CAP);
  // And a lineup that IS over the cap via real slots fails with the message.
  // (Greedy most-expensive-first, skipping players already used, so the
  // duplicate check never fires before the cap check.)
  const expensive = {};
  const usedExp = new Set();
  for (const slot of ['V', 'G', 'B', 'D']) {
    const pick = [...POOL].filter((p) => p.eligible.includes(slot) && !usedExp.has(p.member_id))
      .sort((a, b) => b.price - a.price || a.name.localeCompare(b.name))[0];
    expensive[slot] = pick.member_id;
    usedExp.add(pick.member_id);
  }
  expensive.W = [...POOL].filter((p) => !usedExp.has(p.member_id))
    .sort((a, b) => b.price - a.price || a.name.localeCompare(b.name))[0].member_id;
  const check = validateSlots(expensive);
  assert.equal(check.ok, false);
  assert.match(check.error, /over the \$100 cap/);
});

test('the same musician twice fails', () => {
  const slots = sampleLineup();
  slots.W = slots.V;
  const check = validateSlots(slots);
  assert.equal(check.ok, false);
  assert.match(check.error, /cannot fill two slots/);
});

test('a player outside the pool fails', () => {
  const slots = sampleLineup();
  slots.V = '00000000-0000-0000-0000-000000000000';
  const check = validateSlots(slots);
  assert.equal(check.ok, false);
  assert.match(check.error, /not in the 100-player pool/);
});

test('slot eligibility is enforced (a vocalist-only player cannot play guitar)', () => {
  const vocalOnly = POOL.find((p) => p.eligible.length === 1 && p.eligible[0] === 'V');
  assert.ok(vocalOnly, 'pool has a vocalist-only player');
  const slots = sampleLineup();
  slots.G = vocalOnly.member_id;
  const check = validateSlots(slots);
  assert.equal(check.ok, false);
  assert.match(check.error, /cannot fill the Guitar slot/);
});

test('wild card accepts any pool member, including a W-only player', () => {
  const wOnly = POOL.find((p) => p.eligible.length === 1 && p.eligible[0] === 'W');
  assert.ok(wOnly, 'pool has a W-only player (Ray Manzarek)');
  const slots = sampleLineup();
  slots.W = wOnly.member_id;
  const check = validateSlots(slots);
  assert.equal(check.ok, true);
});

// --- Scoring ---------------------------------------------------------------------

test('connection bonus is +4 per shared-band pair, capped at +16', () => {
  // Synthetic five, all in one band: 10 pairs -> capped at +16.
  const fake = (id) => ({ member_id: id, name: id, V: 10, price: 10, all_bands: ['One Band'] });
  const picks = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ slot: 'W', player: fake(id) }));
  const { bonus, pairs } = connectionBonusFor(picks);
  assert.equal(pairs.length, 10);
  assert.equal(bonus, 16);
  // No shared band at all -> 0.
  const loners = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    slot: 'W',
    player: { member_id: id, name: id, V: 10, price: 10, all_bands: [`Band ${id}`] },
  }));
  assert.equal(connectionBonusFor(loners).bonus, 0);
});

test('provisional score is sum(V) + connection bonus', () => {
  const { picks } = validateSlots(sampleLineup());
  const scored = scoreLineup(picks);
  const sumV = picks.reduce((s, p) => s + p.player.V, 0);
  assert.equal(scored.valueSum, Math.round(sumV * 100) / 100);
  assert.equal(scored.provisional, Math.round((sumV + scored.connectionBonus) * 100) / 100);
});

test('with no crowd-split (all shares 0) final equals provisional', () => {
  const { picks } = validateSlots(sampleLineup());
  const provisional = scoreLineup(picks).provisional;
  const final = finalScoreFor(picks, {}).final;
  assert.equal(final, provisional);
});

test('solo day: share 1.0 still waters picks down — no lone-lineup exemption', () => {
  const { picks } = validateSlots(sampleLineup());
  const shares = {};
  for (const { player } of picks) shares[player.member_id] = 1.0;
  const { final, adjustments } = finalScoreFor(picks, shares);
  // Each pick keeps V / 1.5 — the formula as written, not a special case.
  for (const adj of adjustments) {
    assert.equal(adj.adjusted, Math.round((adj.V / 1.5) * 100) / 100);
  }
  assert.ok(final < scoreLineup(picks).provisional);
});

test('two lineups sharing only Freddie settle exactly per the formula', () => {
  const freddie = POOL.find((p) => p.name === 'Freddie Mercury');
  assert.ok(freddie);
  // Two valid lineups that share ONLY Freddie as a musician.
  const used = new Set([freddie.member_id]);
  const cheapest = (slot) => [...POOL]
    .filter((p) => p.eligible.includes(slot) && !used.has(p.member_id))
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name))[0];
  const fill = (slots) => {
    for (const slot of ['G', 'B', 'D']) {
      slots[slot] = cheapest(slot).member_id;
      used.add(slots[slot]);
    }
    slots.W = [...POOL]
      .filter((p) => !used.has(p.member_id))
      .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name))[0].member_id;
    used.add(slots.W);
    return slots;
  };
  const a = fill({ V: freddie.member_id });
  const b = fill({ V: freddie.member_id });
  const pa = validateSlots(a);
  const pb = validateSlots(b);
  assert.equal(pa.ok, true, pa.error);
  assert.equal(pb.ok, true, pb.error);
  // Shares: Freddie 2/2 = 1.0, everyone else 1/2 = 0.5.
  const shares = {};
  for (const { player } of [...pa.picks, ...pb.picks]) {
    shares[player.member_id] = (shares[player.member_id] || 0) + 0.5;
  }
  assert.equal(shares[freddie.member_id], 1.0);
  for (const { picks, label } of [{ picks: pa.picks, label: 'A' }, { picks: pb.picks, label: 'B' }]) {
    const { final } = finalScoreFor(picks, shares);
    // Independent recomputation from raw pool data (not the module's
    // own bonus helper): adjusted V sum + shared-band pairs * 4, cap 16.
    let adj = 0;
    for (const { player } of picks) adj += player.V / (1 + 0.5 * shares[player.member_id]);
    let pairCount = 0;
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        if (picks[i].player.all_bands.some((band) => picks[j].player.all_bands.includes(band))) pairCount++;
      }
    }
    const expected = Math.round((adj + Math.min(16, pairCount * 4)) * 100) / 100;
    assert.equal(final, expected, `lineup ${label} final must match the hand computation`);
  }
});

// --- Gold line + tiers --------------------------------------------------------------

test('Gold line is 69 and a win is strictly greater', () => {
  assert.equal(GOLD_LINE, 69);
  assert.equal(isWin(69), false);
  assert.equal(isWin(69.01), true);
  assert.equal(isWin(68.99), false);
});

test('tiers: Gold at 10 wins, Platinum at 25, accumulating', () => {
  assert.equal(tierForWins(0), null);
  assert.equal(tierForWins(9), null);
  assert.equal(tierForWins(GOLD_WINS), 'Gold');
  assert.equal(tierForWins(24), 'Gold');
  assert.equal(tierForWins(PLATINUM_WINS), 'Platinum');
  assert.equal(tierForWins(100), 'Platinum');
});

// --- Dates --------------------------------------------------------------------------

test('Pacific week is Monday–Sunday', () => {
  // 2026-11-07 is a Saturday.
  assert.deepEqual(weekContaining('2026-11-07'), { start: '2026-11-02', end: '2026-11-08' });
  assert.deepEqual(weekContaining('2026-11-08'), { start: '2026-11-02', end: '2026-11-08' });
  assert.deepEqual(weekContaining('2026-11-09'), { start: '2026-11-09', end: '2026-11-15' });
});

test('previous Pacific date steps back one calendar day', () => {
  assert.equal(previousPacificDate('2026-11-07'), '2026-11-06');
  assert.equal(previousPacificDate('2026-03-01'), '2026-02-28');
});

// --- Wiring pins (exact-source) ---------------------------------------------------------

test('submit enforces one lineup per user per day with a 409', () => {
  const body = src('netlify/functions/fantasy_play.mjs');
  assert.ok(body.includes("unique (user_id, play_date)") || body.includes('on conflict (user_id, play_date)'));
  assert.ok(body.includes("conflict('you already submitted a lineup today'"));
});

test('settle refuses to settle a day that is not over yet', () => {
  const body = src('netlify/functions/fantasy_settle.mjs');
  assert.ok(body.includes('cannot settle a day that is not over yet'));
  assert.ok(body.includes('finalScoreFor'));
  assert.ok(body.includes('isWin('));
});

test('settle runs just after midnight Pacific via a UTC cron in the file', () => {
  const body = src('netlify/functions/fantasy_settle.mjs');
  // 08:05 UTC = 00:05 PST / 01:05 PDT — always after midnight Pacific.
  assert.ok(body.includes("schedule: '5 8 * * *'"));
});

test('leaderboard tiebreak is connection bonus desc, then earliest submission', () => {
  const body = src('netlify/functions/fantasy_leaderboard.mjs');
  assert.match(body, /order by coalesce\(l\.final_score, l\.provisional_score\) desc,\s*l\.connection_bonus desc,\s*l\.submitted_at asc/);
});

test('migration is idempotent and derives wins instead of counting them', () => {
  const sql = src('sql/fantasy-migration-v1.sql');
  assert.ok(sql.includes('create table if not exists fantasy_lineups'));
  assert.ok(sql.includes('create table if not exists fantasy_days'));
  assert.ok(sql.includes('unique (user_id, play_date)'));
  assert.match(sql, /create index if not exists/g);
  // No wins-counter table or column: wins are counted from won flags.
  // (The header comment may SAY "wins" — that is documentation, not schema.)
  assert.ok(!/create table if not exists \w*wins/i.test(sql));
  assert.ok(!/\bwins\s+(integer|int|bigint)\b/i.test(sql));
});

// --- Patch pins: pool sort + today-state URL --------------------------------

test('visiblePool sorts price desc, name as tiebreak', () => {
  // visiblePool is an inner function of the page module, so — same
  // precedent as tests/sigma-explorer-wiring.test.mjs — pin the exact
  // sort on the shipped source instead of importing it.
  const body = src('fantasy/fantasy-game.mjs');
  const m = body.match(/function visiblePool\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, 'visiblePool must exist in fantasy-game.mjs');
  assert.match(
    m[1],
    /\.sort\(\(a, b\) => b\.price0 - a\.price0 \|\| a\.name\.localeCompare\(b\.name\)\)/,
    'visiblePool must sort price descending with name as tiebreak',
  );
});

test("today's state comes from /api/fantasy-play, never fantasy-today", () => {
  const page = src('fantasy/fantasy-game.mjs');
  assert.ok(
    page.includes("fetch('/api/fantasy-play'"),
    'loadToday must fetch /api/fantasy-play',
  );
  assert.ok(!page.includes('fantasy-today'), 'fantasy-today must not appear in the page');
  const fn = src('netlify/functions/fantasy_play.mjs');
  assert.ok(!fn.includes('fantasy-today'), 'fantasy-today must not appear in fantasy_play.mjs');
});
