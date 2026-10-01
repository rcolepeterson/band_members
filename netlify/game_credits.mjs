// Credit economy.
//
// GET /api/game-credits (auth) -> { ok, credits, freeze_count, streak }
//
// POST /api/game-credits (auth) — body { action }:
//   buy_freeze — spend FREEZE_COST credits for a Seattle Freeze
//     -> { ok, credits, freeze_count }
//
// POST /api/game-credits/purchase (auth) — body { pack }
//   Real-money packs are STUBBED: Google Play Billing lands with the TWA.
//   -> { ok: false, error: 'Credit packs are coming soon.' }
//
// Earn paths live where the play happens: daily completion (+bonus for
// par) in game_daily_play.mjs, structured match wins in game_match_play.mjs.
// New users start with STARTING_CREDITS so the first hint is free to try.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  forbidden,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { currentStreak, FREEZE_COST } from './_daily.mjs';

async function balance(sql, me) {
  const comps = await sql`select chain_date from daily_completions where user_id = ${me.id}`;
  const dates = (comps || []).map((c) => c.chain_date);
  const fresh = await findUserByToken(sql, me.token).catch(() => me);
  return {
    credits: fresh.credits ?? 50,
    freeze_count: fresh.freeze_count ?? 0,
    streak: currentStreak(dates),
  };
}

async function creditsHandler(req) {
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to check your credits');

  const budget = await consume({
    sql,
    bucket: `game-credits:uid:${me.id}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many requests. Try again shortly.', budget.retryAfterSeconds);
  }

  if (req.method === 'GET') return ok(await balance(sql, me));

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    if (!body || body.action !== 'buy_freeze') return badRequest('unknown action');
    const paid = await sql`
      update users set credits = credits - ${FREEZE_COST}, freeze_count = freeze_count + 1
       where id = ${me.id} and credits >= ${FREEZE_COST}
      returning credits, freeze_count`;
    if (!paid || !paid[0]) return forbidden('not enough credits', { freeze_cost: FREEZE_COST });
    const b = await balance(sql, me);
    return ok({ ...b, bought: 'seattle_freeze' });
  }

  return methodNotAllowed();
}

export default creditsHandler;

export const config = { path: '/api/game-credits' };
