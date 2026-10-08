// Daily Chain — today's deal.
//
// GET /api/game-daily — fetch today's chain (PUBLIC, same lure rationale as
// the challenge endpoints: the pair is visible before sign-in, playing
// needs auth).
//   -> { ok, date, band_a: {id, name}, band_b: {id, name}, optimal_hops,
//        you: null | { credits, freeze_count, streak, completed_today } }
//
// The first request of the day generates the pair (idempotent): the date
// seeds the lottery, pairs from the last 90 days are excluded, and
// INSERT ... ON CONFLICT DO NOTHING makes concurrent first-hits safe.

import {
  getSql,
  isDbConfigured,
  ok,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import {
  pacificDate,
  buildBandAdj,
  buildBandMembers,
  pickDailyPair,
  currentStreak,
  MIN_HOPS,
  MAX_HOPS,
  NO_REPEAT_DAYS,
} from './_daily.mjs';
import { famousIdsFrom, HEADLINER_BANDS } from './_famous.mjs';

// Famous dailies stay short: par 3 or 4.
const FAMOUS_MAX_HOPS = 4;

// Module-level graph cache (warm invocations reuse it; the band graph
// changes slowly and a slightly stale deal is harmless).
let graphCache = null;

export async function loadBandGraph(sql) {
  if (graphCache) return graphCache;
  const [memberships, bands, members] = await Promise.all([
    sql`select band_id, member_id from memberships where relation = 'member_of'`,
    sql`select id, name, genre, years_active from bands`,
    // Musician names, so the board can say WHO links two bands.
    sql`select id, name from band_members`,
  ]);
  const { adj, degree } = buildBandAdj(memberships);
  const bandMembers = buildBandMembers(memberships);
  const memberNames = new Map((members || []).map((m) => [m.id, m.name]));
  const meta = new Map(bands.map((b) => [b.id, { name: b.name, genre: b.genre, years_active: b.years_active }]));
  const bandIds = bands.map((b) => b.id).filter((id) => adj.has(id));
  const famous = famousIdsFrom(meta, adj);
  const headliners = famousIdsFrom(meta, adj, HEADLINER_BANDS);
  graphCache = { adj, degree, meta, bandIds, famous, headliners, bandMembers, memberNames };
  return graphCache;
}

export function clearGraphCache() {
  graphCache = null;
}

// Exported so `start` in game_daily_play can deal today's pair too: a
// signed-in player goes straight to `start` and never hits GET, so before
// the day's first public preview there was no row and the board read
// "no chain for that day".
export async function ensureChain(sql, date) {
  const existing = await sql`select date, band_a, band_b, optimal_hops from daily_chains where date = ${date} limit 1`;
  if (existing && existing[0]) return existing[0];

  const { adj, bandIds, famous, headliners } = await loadBandGraph(sql);
  const recent = await sql`
    select band_a, band_b from daily_chains
     where date >= ((${date})::date - (${NO_REPEAT_DAYS} || ' days')::interval)::text
  `;
  const exclude = new Set(
    (recent || []).map((r) => {
      const a = String(r.band_a);
      const b = String(r.band_b);
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    }),
  );
  // Famous first (Cole/Paul, 2026-10-08): both ends are headliners, 3–4
  // hops apart, with a shortest route through famous bands only. Falls back
  // to the whole graph if the lists can't produce a fresh pair.
  const pair = pickDailyPair({
    bandIds: [...headliners], adj, seed: date + ':famous',
    minHops: MIN_HOPS, maxHops: FAMOUS_MAX_HOPS, excludeKeys: exclude, requireWithin: famous,
  }) || pickDailyPair({ bandIds, adj, seed: date, minHops: MIN_HOPS, maxHops: MAX_HOPS, excludeKeys: exclude });
  if (!pair) {
    // Tiny or pathological graph: relax the quarantine before giving up.
    const loose = pickDailyPair({ bandIds, adj, seed: date + ':loose', minHops: 2, maxHops: 8 });
    if (!loose) return null;
    await sql`
      insert into daily_chains (date, band_a, band_b, optimal_hops)
      values (${date}, ${loose.a}, ${loose.b}, ${loose.hops})
      on conflict (date) do nothing
    `;
  } else {
    await sql`
      insert into daily_chains (date, band_a, band_b, optimal_hops)
      values (${date}, ${pair.a}, ${pair.b}, ${pair.hops})
      on conflict (date) do nothing
    `;
  }
  const rows = await sql`select date, band_a, band_b, optimal_hops from daily_chains where date = ${date} limit 1`;
  return (rows && rows[0]) || null;
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const date = pacificDate();

  const budget = await consume({
    sql,
    bucket: `game-daily:ip:${clientIp(req)}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many daily-chain requests. Try again shortly.', budget.retryAfterSeconds);
  }

  let chain;
  try {
    chain = await ensureChain(sql, date);
  } catch (error) {
    console.error('game-daily: chain generation failed', error && error.message);
    return serverError('could not deal today\u2019s chain');
  }
  if (!chain) return serverError('could not deal today\u2019s chain');

  let bandA = { id: chain.band_a, name: 'Band A' };
  let bandB = { id: chain.band_b, name: 'Band B' };
  try {
    const rows = await sql`select id, name from bands where id in (${chain.band_a}, ${chain.band_b})`;
    for (const r of rows || []) {
      if (String(r.id) === String(chain.band_a)) bandA = { id: r.id, name: r.name };
      if (String(r.id) === String(chain.band_b)) bandB = { id: r.id, name: r.name };
    }
  } catch (error) {
    console.error('game-daily: band lookup failed', error && error.message);
  }

  // Authenticated extras: credits, freezes, streak, today's completion.
  let you = null;
  const me = await findUserByToken(sql, extractBearerToken(req)).catch(() => null);
  if (me) {
    const [comps] = await Promise.all([
      sql`select chain_date from daily_completions where user_id = ${me.id}`,
    ]).catch(() => [[], []]);
    const dates = (comps || []).map((c) => c.chain_date);
    you = {
      credits: me.credits ?? 50,
      freeze_count: me.freeze_count ?? 0,
      streak: currentStreak(dates),
      completed_today: dates.includes(date),
    };
  }

  return ok({
    date: chain.date,
    band_a: bandA,
    band_b: bandB,
    optimal_hops: chain.optimal_hops,
    you,
  });
};

export const config = { path: '/api/game-daily' };
