// GET /api/game-retention — do Daily Chain players come back? (Cole, 2026-10-09)
//
// Counts only, no player details, so it's a public read like /api/snapshots.
// It reads our own daily_runs table, which records every daily game (guests
// included) whether or not the player's browser blocks Google Analytics, so
// these numbers are the exact ones; GA's are an undercount.
//
//   -> { ok, as_of,
//        last_7_days: { players, came_back_2_plus_days, played_to_end_pct, outcomes },
//        days: [{ date, players, back_next_day, played_to_end_pct, outcomes }] }
//   outcomes (each player's FIRST try at that day's puzzle; Cole, 2026-10-09):
//     played to the end:  won, out_of_moves
//     stopped early:      left_without_moving ("didn't get it"),
//                         left_partway (stuck or lost interest),
//                         gave_up (tapped Give up)
//   played_to_end_pct = (won + out_of_moves) / players, whole percent.
//
// Out of moves = given up with every move used (shortest path + 3, the
// game's DAILY_EXTRA_MOVES); the game ends the run itself at that point.
// back_next_day for the newest day is always 0: tomorrow hasn't happened.
// Today's "left" counts include people still mid-game; they settle tomorrow.
// Practice games live in solo_runs and are not counted.
//
// Cached 5 minutes at Netlify's CDN so checking it never costs Neon much.

import { getSql, isDbConfigured } from './_db.mjs';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'netlify-cdn-cache-control': 'public, max-age=300, durable',
};

const EXTRA_MOVES = 3; // DAILY_EXTRA_MOVES in scripts/six-degrees-game.mjs

const emptyOutcomes = () => ({ won: 0, out_of_moves: 0, left_without_moving: 0, left_partway: 0, gave_up: 0 });
const total = (o) => o.won + o.out_of_moves + o.left_without_moving + o.left_partway + o.gave_up;
const pctToEnd = (o) => (total(o) ? Math.round((100 * (o.won + o.out_of_moves)) / total(o)) : 0);

// How one first try ended. Exported for the tests.
export function outcomeOf({ status, hops_used, optimal_hops }) {
  const moves = Number(hops_used) || 0;
  if (status === 'complete') return 'won';
  if (status === 'given_up') return moves >= Number(optimal_hops) + EXTRA_MOVES ? 'out_of_moves' : 'gave_up';
  return moves === 0 ? 'left_without_moving' : 'left_partway';
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!isDbConfigured()) {
    return Response.json({ ok: false, error: 'database not configured' }, { status: 503 });
  }
  try {
    const sql = getSql();
    // One row per player per day: their first try, with that day's par.
    const firstTries = sql`
      select r.user_id, r.chain_date::date as d, r.status, r.hops_used, c.optimal_hops
        from daily_runs r
        join daily_chains c on c.date = r.chain_date
       where r.run_number = 1 and r.chain_date::date >= current_date - 31
    `;
    const [tries, back, week] = await Promise.all([
      firstTries,
      sql`
        with played as (
          select distinct user_id, chain_date::date as d
            from daily_runs
           where chain_date::date >= current_date - 31
        )
        select p.d::text as date,
               count(*) filter (where exists (
                 select 1 from played n where n.user_id = p.user_id and n.d = p.d + 1
               ))::int as back_next_day
          from played p
         group by p.d
      `,
      sql`
        with w as (
          select user_id, count(distinct chain_date) as days
            from daily_runs
           where chain_date::date > current_date - 7
           group by user_id
        )
        select count(*)::int as players,
               count(*) filter (where days >= 2)::int as came_back_2_plus_days
          from w
      `,
    ]);
    const backByDate = new Map(back.map((r) => [r.date, r.back_next_day]));
    const byDate = new Map();
    const weekStart = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const weekOutcomes = emptyOutcomes();
    for (const t of tries) {
      const date = t.d instanceof Date ? t.d.toISOString().slice(0, 10) : String(t.d).slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, emptyOutcomes());
      const kind = outcomeOf(t);
      byDate.get(date)[kind] += 1;
      if (date >= weekStart) weekOutcomes[kind] += 1;
    }
    const days = [...byDate.keys()].sort().reverse().slice(0, 30).map((date) => {
      const outcomes = byDate.get(date);
      return { date, players: total(outcomes), back_next_day: backByDate.get(date) || 0, played_to_end_pct: pctToEnd(outcomes), outcomes };
    });
    return new Response(JSON.stringify({
      ok: true,
      as_of: new Date().toISOString(),
      last_7_days: {
        ...(week[0] || { players: 0, came_back_2_plus_days: 0 }),
        played_to_end_pct: pctToEnd(weekOutcomes),
        outcomes: weekOutcomes,
      },
      days,
    }), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error('game_retention failed', err && err.message);
    return Response.json({ ok: false, error: 'could not load retention' }, { status: 500 });
  }
};

export const config = { path: '/api/game-retention' };
