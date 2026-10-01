// Daily Chain post-mortem — par path in gold vs your route in blue.
//
// GET /api/game-daily/postmortem?date=YYYY-MM-DD (auth)
//   -> { ok, date, par, par_path: [names], your_path: [names],
//        your_hops, outcome: 'complete' | 'given_up' }
//
// Rules, all enforced server-side:
// - Only for days at least TWO days old (Pacific). Yesterday's and today's
//   par paths are never revealed — that's the answer while it's live.
// - Only for days you actually played (any run: complete or given_up).
//   Unplayed days show nothing, so the archive's 75-credit unlock stays blind
//   and the reveal can never be farmed into improvement credits.
// - Replays are today-only (see game_daily_play.mjs), so a revealed par path
//   can't be walked for credits afterward.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  notFound,
  forbidden,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { pacificDate, validChainDate, dayDiff, bfsPath } from './_daily.mjs';
import { loadBandGraph } from './game_daily.mjs';

// The archive's post-mortem rule, exported for tests: a day's answer opens
// only when that day is at least two full days behind today (Pacific), so
// the par route can't leak across timezones or into an active replay.
export function postmortemOpen(requestedDate, todayDate) {
  return dayDiff(requestedDate, todayDate) >= 2;
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to see the post-mortem');

  const budget = await consume({
    sql,
    bucket: `game-daily-postmortem:uid:${me.id}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many post-mortems. Try again shortly.', budget.retryAfterSeconds);
  }

  const url = new URL(req.url);
  const date = validChainDate(url.searchParams.get('date'));
  if (!date) return badRequest('pick a day');
  const today = pacificDate();
  if (!postmortemOpen(date, today)) {
    return forbidden('the post-mortem opens two days out');
  }
  let chains;
  try {
    chains = await sql`select date, band_a, band_b, optimal_hops from daily_chains where date = ${date} limit 1`;
  } catch (error) {
    console.error('game-daily-postmortem: chain lookup failed', error && error.message);
    return serverError('could not load that day');
  }
  const chain = chains && chains[0];
  if (!chain) return notFound('no chain for that day');

  let runs;
  try {
    runs = await sql`
      select id, status, hops_used, picks, current_band_id
        from daily_runs
       where user_id = ${me.id} and chain_date = ${date}
       order by run_number asc`;
  } catch (error) {
    console.error('game-daily-postmortem: runs lookup failed', error && error.message);
    return serverError('could not load that day');
  }
  if (!runs || !runs.length) {
    return forbidden('the post-mortem is only for days you played');
  }

  // Your route: the best complete run's trail. Replays show the best, not the
  // latest. Give-up days show the partial trail — the most interesting case.
  const complete = runs.filter((r) => r.status === 'complete');
  let run = null;
  let outcome = 'given_up';
  if (complete.length) {
    run = complete.reduce((a, b) => (a.hops_used <= b.hops_used ? a : b));
    outcome = 'complete';
  } else {
    run = runs[runs.length - 1];
  }

  let adj;
  let meta;
  try {
    ({ adj, meta } = await loadBandGraph(sql));
  } catch (error) {
    console.error('game-daily-postmortem: graph load failed', error && error.message);
    return serverError('could not load that day');
  }
  const startName = (meta.get(chain.band_a) || {}).name || 'Band';
  const parIds = bfsPath(adj, chain.band_a, chain.band_b) || [];
  const par_path = parIds.map((id) => (meta.get(id) || {}).name || 'Band');
  const your_path = [startName, ...((run.picks || []).map((p) => p.name || 'Band'))];

  return ok({
    date,
    par: chain.optimal_hops,
    par_path,
    your_path,
    your_hops: run.hops_used,
    outcome,
  });
};

export const config = { path: '/api/game-daily/postmortem' };
