// Fantasy Band Game — leaderboards.
//
// GET /api/fantasy-leaderboard?scope=daily|weekly&date=YYYY-MM-DD (public)
//   -> { ok, scope, date, weekStart?, weekEnd?, settledDays?, total,
//        entries: [{ rank, name, playDate, score, scoreType, connectionBonus,
//                    submittedAt, won }] }
//
// Ranking (spec §6): final score if that day is settled, else provisional;
// ties break on connection bonus desc, then earliest submission.
// A weekly board ranks the week's DRAFTS, not players: one user can appear
// once per day they played (each entry carries its playDate, so repeats
// are distinguishable). The spec says "the week's drafts" — if Aaron
// wants one row per player (best draft of the week) instead, that is a
// one-query change, not a rebuild.
// Week = Pacific Monday–Sunday (see weekContaining in _fantasy.mjs).
// Public on purpose, like GET /api/game-daily: the board is the lure, and
// it shows handles/names only — never emails, tokens, or user ids.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  serverError,
  dbUnavailable,
  methodNotAllowed,
} from './_db.mjs';
import { pacificDate, validChainDate } from './_daily.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { weekContaining } from './_fantasy.mjs';

const MAX_ENTRIES = 100;

// Shared by fantasy_play.mjs (GET today state embeds the daily board).
// Returns [entries, total] for the inclusive Pacific date range.
// scoreType is per entry: 'final' once its day settled, else 'provisional'.
export async function loadLeaderboardEntries(sql, { start, end }) {
  const rows = await sql`
    select l.play_date, l.connection_bonus, l.submitted_at,
           l.provisional_score, l.final_score, l.won,
           coalesce(nullif(u.handle, ''), u.name, 'Player') as name
      from fantasy_lineups l
      join users u on u.id = l.user_id
     where l.play_date >= ${start} and l.play_date <= ${end}
     order by coalesce(l.final_score, l.provisional_score) desc,
              l.connection_bonus desc,
              l.submitted_at asc
     limit ${MAX_ENTRIES}
  `;
  const totalRows = await sql`
    select count(*) as total from fantasy_lineups
     where play_date >= ${start} and play_date <= ${end}
  `.catch(() => []);
  const entries = (rows || []).map((r, i) => ({
    rank: i + 1,
    name: r.name,
    playDate: r.play_date,
    score: Number(r.final_score != null ? r.final_score : r.provisional_score),
    scoreType: r.final_score != null ? 'final' : 'provisional',
    connectionBonus: r.connection_bonus,
    submittedAt: r.submitted_at,
    won: r.won,
  }));
  return [entries, Number((totalRows && totalRows[0] && totalRows[0].total) || 0)];
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();

  const budget = await consume({
    sql,
    bucket: `fantasy-leaderboard:ip:${clientIp(req)}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many leaderboard requests. Try again shortly.', budget.retryAfterSeconds);
  }

  const params = new URL(req.url).searchParams;
  const scope = params.get('scope') === 'weekly' ? 'weekly' : 'daily';
  const date = validChainDate(params.get('date')) || pacificDate();
  if (date > pacificDate()) return badRequest('that day hasn\u2019t happened yet');

  let start = date;
  let end = date;
  let week = null;
  if (scope === 'weekly') {
    week = weekContaining(date);
    start = week.start;
    end = week.end;
  }

  let entries;
  let total;
  try {
    [entries, total] = await loadLeaderboardEntries(sql, { start, end });
  } catch (err) {
    console.error('fantasy-leaderboard: load failed', err && err.message);
    return serverError('could not load the leaderboard');
  }

  return ok({
    scope,
    date,
    ...(week ? { weekStart: week.start, weekEnd: week.end } : {}),
    total,
    entries,
  });
};

export const config = { path: '/api/fantasy-leaderboard' };
