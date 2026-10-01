// Daily Chain archive — play missed days, repair the streak.
//
// GET /api/game-daily/archive (auth)
//   -> { ok, days: [{ date, band_a, band_b, optimal_hops, completed, unlocked }] }
//   Last 90 days of chains, newest first.
//
// POST /api/game-daily/archive (auth) — body { date }
//   Spends ARCHIVE_COST credits to unlock a past day. Playing it to
//   completion backfills the ledger and repairs the streak.
//   -> { ok, date, credits } | 403 { error, archive_cost }

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
import { pacificDate, validChainDate, ARCHIVE_COST, NO_REPEAT_DAYS } from './_daily.mjs';

export default async (req) => {
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to browse the archive');

  const budget = await consume({
    sql,
    bucket: `game-daily-archive:uid:${me.id}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many archive requests. Try again shortly.', budget.retryAfterSeconds);
  }

  const today = pacificDate();

  if (req.method === 'GET') {
    let rows;
    try {
      rows = await sql`
        select c.date, c.band_a, c.band_b, c.optimal_hops,
               ba.name as band_a_name, bb.name as band_b_name,
               (r.id is not null) as completed,
               (u.chain_date is not null) as unlocked
          from daily_chains c
          join bands ba on ba.id = c.band_a
          join bands bb on bb.id = c.band_b
          left join daily_runs r on r.user_id = ${me.id} and r.chain_date = c.date and r.status = 'complete'
          left join daily_unlocks u on u.user_id = ${me.id} and u.chain_date = c.date
         where c.date < ${today}
           and c.date >= ((${today})::date - (${NO_REPEAT_DAYS} || ' days')::interval)::text
         order by c.date desc`;
    } catch (error) {
      console.error('game-daily-archive: list failed', error && error.message);
      return serverError('could not load the archive');
    }
    return ok({
      days: (rows || []).map((r) => ({
        date: r.date,
        band_a: r.band_a_name,
        band_b: r.band_b_name,
        optimal_hops: r.optimal_hops,
        completed: !!r.completed,
        unlocked: !!r.unlocked || !!r.completed,
      })),
    });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    const date = validChainDate(body && body.date);
    if (!date) return badRequest('pick a day');
    if (date >= today) return badRequest('that day isn\u2019t in the archive yet');
    const chains = await sql`select date from daily_chains where date = ${date} limit 1`;
    if (!chains || !chains[0]) return notFound('no chain for that day');
    const done = await sql`select id from daily_runs where user_id = ${me.id} and chain_date = ${date} and status = 'complete' limit 1`;
    if (done && done[0]) return badRequest('you already played that day');
    const already = await sql`select chain_date from daily_unlocks where user_id = ${me.id} and chain_date = ${date} limit 1`;
    if (already && already[0]) {
      const fresh = await findUserByToken(sql, me.token).catch(() => me);
      return ok({ date, credits: fresh.credits ?? 50, already: true });
    }
    const paid = await sql`
      update users set credits = credits - ${ARCHIVE_COST}
       where id = ${me.id} and credits >= ${ARCHIVE_COST}
      returning credits`;
    if (!paid || !paid[0]) return forbidden('not enough credits', { archive_cost: ARCHIVE_COST });
    await sql`
      insert into daily_unlocks (user_id, chain_date) values (${me.id}, ${date})
      on conflict do nothing`;
    return ok({ date, credits: paid[0].credits });
  }

  return methodNotAllowed();
};

export const config = { path: '/api/game-daily/archive' };
