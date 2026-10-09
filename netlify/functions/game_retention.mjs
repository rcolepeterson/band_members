// GET /api/game-retention — do Daily Chain players come back? (Cole, 2026-10-09)
//
// Counts only, no player details, so it's a public read like /api/snapshots.
// It reads our own daily_runs table, which records every daily game (guests
// included) whether or not the player's browser blocks Google Analytics, so
// these numbers are the exact ones; GA's are an undercount.
//
//   -> { ok, as_of, last_7_days: { players, came_back_2_plus_days },
//        days: [{ date, players, finished, back_next_day }] }  (newest first, 30 days)
//
// back_next_day for the newest day is always 0: tomorrow hasn't happened.
// Practice games live in solo_runs and are not counted.
//
// Cached 5 minutes at Netlify's CDN so checking it never costs Neon much.

import { getSql, isDbConfigured } from './_db.mjs';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'netlify-cdn-cache-control': 'public, max-age=300, durable',
};

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!isDbConfigured()) {
    return Response.json({ ok: false, error: 'database not configured' }, { status: 503 });
  }
  try {
    const sql = getSql();
    const [days, week] = await Promise.all([
      sql`
        with played as (
          select user_id, chain_date::date as d, bool_or(status = 'complete') as finished
            from daily_runs
           where chain_date::date >= current_date - 31
           group by user_id, chain_date::date
        )
        select p.d::text as date,
               count(*)::int as players,
               count(*) filter (where p.finished)::int as finished,
               count(*) filter (where exists (
                 select 1 from played n where n.user_id = p.user_id and n.d = p.d + 1
               ))::int as back_next_day
          from played p
         group by p.d
         order by p.d desc
         limit 30
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
    return new Response(JSON.stringify({
      ok: true,
      as_of: new Date().toISOString(),
      last_7_days: week[0] || { players: 0, came_back_2_plus_days: 0 },
      days,
    }), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error('game_retention failed', err && err.message);
    return Response.json({ ok: false, error: 'could not load retention' }, { status: 500 });
  }
};

export const config = { path: '/api/game-retention' };
