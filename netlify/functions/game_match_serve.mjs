// Start your serve in a structured head-to-head match.
//
// POST /api/game-match/serve — set band_a for your serve (auth).
//   body: { token, band_a }
//   -> { ok: true, match: { ...matchState } }
//
// Only the pending server can serve, and only when no serve is currently
// waiting on a defender. The challenger's opening serve is set at match
// creation; this covers every serve after that.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  notFound,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { validBandRef } from './game_challenge.mjs';
import { matchState } from './game_match.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to play');

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return badRequest('expected a JSON body');
  }
  const token = String((body && body.token) || '').slice(0, 128);
  const bandA = validBandRef(body && body.band_a);
  if (!token) return badRequest('missing token');
  if (!bandA) return badRequest('pick a band first');

  const budget = await consume({
    sql,
    bucket: `game-match-serve:uid:${me.id}`,
    limit: 120,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many serves from this account. Try again shortly.', budget.retryAfterSeconds);
  }

  let rows;
  try {
    rows = await sql`
      select m.*, u1.handle as challenger_handle, u2.handle as invitee_handle
        from game_matches m
        join users u1 on u1.id = m.challenger_id
        left join users u2 on u2.id = m.invitee_id
       where m.token = ${token}
       limit 1`;
  } catch (error) {
    console.error('game-match-serve: lookup failed', error && error.message);
    return serverError('could not load the match');
  }
  const match = rows && rows[0];
  if (!match) return notFound('match not found');
  if (match.status === 'complete') return badRequest('this match is over');
  if (match.status !== 'active') return badRequest('the match has not started yet');
  if (match.pending_band_a) return badRequest('a serve is already waiting on a defender');
  if (match.pending_server_id !== me.id) return badRequest("it's not your serve");
  if (me.id !== match.challenger_id && me.id !== match.invitee_id) {
    return badRequest('this match is between two other players');
  }

  try {
    await sql`
      update game_matches
         set pending_band_a = ${bandA}
       where id = ${match.id}`;
  } catch (error) {
    console.error('game-match-serve: update failed', error && error.message);
    return serverError('could not save your serve');
  }

  let fresh;
  try {
    const fr = await sql`
      select m.*, u1.handle as challenger_handle, u2.handle as invitee_handle
        from game_matches m
        join users u1 on u1.id = m.challenger_id
        left join users u2 on u2.id = m.invitee_id
       where m.id = ${match.id}
       limit 1`;
    fresh = fr && fr[0];
  } catch (error) {
    console.error('game-match-serve: refetch failed', error && error.message);
    return serverError('could not load the match');
  }
  return ok({ match: matchState(fresh, fresh.challenger_handle, fresh.invitee_handle) });
};

export const config = { path: '/api/game-match/serve' };
