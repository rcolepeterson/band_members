// Defend a serve in a structured head-to-head match.
//
// POST /api/game-match/play — answer the pending serve (auth).
//   body: { token, band_b, hops }
//   -> { ok: true, match: { ...matchState } }
//   -> 409 { ok: false, error, claimed_by } when someone else claimed the
//      open match first (feed-shared links can bring two defenders at once).
//
// The defender picks band_b against the server's band_a; the client computed
// the chain's hop count from its loaded graph and submits it (the server
// validates shape, not the tree — same trust model as the casual challenge).
// Higher hops wins the round; tie rounds are replayed.
//
// Turn flow after a defended serve:
//   - 1st play of the round -> the defender becomes the next server
//     (pending_band_a cleared; waiting on their serve).
//   - 2nd play of the round -> the round is scored, wins tallied, and the
//     next round starts with tennis-style alternation (challenger leads odd
//     rounds). Match ends at the format's target wins, on the timed clock
//     (sudden death if tied), or never for open-ended.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  notFound,
  conflict,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { validBandRef } from './game_challenge.mjs';
import { ensureHandle } from './me_handle.mjs';
import { matchState, targetWins } from './game_match.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

function validHops(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const hops = Math.floor(n);
  if (hops < 1 || hops > 20) return null;
  return hops;
}

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
  const bandB = validBandRef(body && body.band_b);
  const hops = validHops(body && body.hops);
  if (!token) return badRequest('missing token');
  if (!bandB) return badRequest('pick your band first');
  if (hops === null) return badRequest('invalid hop count');

  const budget = await consume({
    sql,
    bucket: `game-match-play:uid:${me.id}`,
    limit: 120,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many plays from this account. Try again shortly.', budget.retryAfterSeconds);
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
    console.error('game-match-play: lookup failed', error && error.message);
    return serverError('could not load the match');
  }
  const match = rows && rows[0];
  if (!match) return notFound('match not found');
  if (match.status === 'complete') return badRequest('this match is over');
  if (!match.pending_band_a) return badRequest('no serve to answer right now');
  if (match.pending_server_id === me.id) return badRequest("you can't defend your own serve");
  if (match.pending_band_a === bandB) return badRequest('pick a different band than the serve');

  // Joining: the first defender becomes the invitee.
  let inviteeId = match.invitee_id;
  let status = match.status;
  const joining = status === 'open';
  if (joining) {
    if (match.challenger_id === me.id) return badRequest("you can't answer your own serve");
    inviteeId = me.id;
    status = 'active';
    // First defend: make sure the joiner has a battle name too. Fail-soft.
    try {
      await ensureHandle(sql, me);
    } catch (err) {
      console.error('game-match-play: ensureHandle failed', err && err.message);
    }
  } else if (me.id !== match.challenger_id && me.id !== inviteeId) {
    return badRequest('this match is between two other players');
  }

  const plays = Array.isArray(match.plays) ? [...match.plays] : [];
  const serverId = match.pending_server_id;
  plays.push({
    round: match.current_round,
    server_id: serverId,
    band_a: match.pending_band_a,
    band_b: bandB,
    hops,
  });

  const roundPlays = plays.filter((p) => p.round === match.current_round);
  let { challenger_round_wins, invitee_round_wins, current_round } = match;
  let pendingServerId;
  let pendingBandA = null;
  let completedAt = null;

  if (roundPlays.length >= 2) {
    // Round complete — score it.
    const [first, second] = roundPlays.slice(-2);
    const firstIsChallenger = first.server_id === match.challenger_id;
    if (first.hops !== second.hops) {
      // Higher hops takes the round.
      const challengerWon = (firstIsChallenger && first.hops > second.hops) ||
        (!firstIsChallenger && second.hops > first.hops);
      if (challengerWon) challenger_round_wins += 1;
      else invitee_round_wins += 1;
    }
    // Tie rounds are replayed: no one scores, same round number, same order.

    // Match end?
    const target = targetWins(match.format);
    let done = false;
    if (target > 0 && (challenger_round_wins >= target || invitee_round_wins >= target)) {
      done = true;
    } else if (match.format === 'timed' && match.ends_at && new Date(match.ends_at) <= new Date()) {
      // Clock died: decisive score ends it; a tie plays sudden death.
      if (challenger_round_wins !== invitee_round_wins) done = true;
    }
    // 'open' never completes.

    if (done) {
      status = 'complete';
      completedAt = sql`now()`;
      pendingServerId = null;
    } else {
      if (first.hops !== second.hops) current_round += 1; // tie replays the round
      // Tennis alternation: challenger leads odd rounds.
      pendingServerId = current_round % 2 === 1 ? match.challenger_id : inviteeId;
    }
  } else {
    // First play of the round — the defender serves next.
    pendingServerId = me.id;
  }

  // Atomic claim on join: exactly one defender flips an open, unclaimed
  // match. A feed-shared match link can bring two defenders at once — the
  // loser gets a 409 with the claimer's handle instead of a corrupted row.
  // Ongoing plays update by id; the turn order (pending_server_id) is
  // enforced by the checks above.
  let updated;
  try {
    if (status === 'complete') {
      updated = joining
        ? await sql`
            update game_matches
               set invitee_id = ${inviteeId},
                   status = 'complete',
                   challenger_round_wins = ${challenger_round_wins},
                   invitee_round_wins = ${invitee_round_wins},
                   plays = ${JSON.stringify(plays)}::jsonb,
                   pending_server_id = null,
                   pending_band_a = null,
                   completed_at = now()
             where id = ${match.id}
               and status = 'open'
               and invitee_id is null
            returning id`
        : await sql`
            update game_matches
               set invitee_id = ${inviteeId},
                   status = 'complete',
                   challenger_round_wins = ${challenger_round_wins},
                   invitee_round_wins = ${invitee_round_wins},
                   plays = ${JSON.stringify(plays)}::jsonb,
                   pending_server_id = null,
                   pending_band_a = null,
                   completed_at = now()
             where id = ${match.id}
            returning id`;
    } else {
      updated = joining
        ? await sql`
            update game_matches
               set invitee_id = ${inviteeId},
                   status = ${status},
                   challenger_round_wins = ${challenger_round_wins},
                   invitee_round_wins = ${invitee_round_wins},
                   current_round = ${current_round},
                   pending_server_id = ${pendingServerId},
                   pending_band_a = ${pendingBandA},
                   plays = ${JSON.stringify(plays)}::jsonb
             where id = ${match.id}
               and status = 'open'
               and invitee_id is null
            returning id`
        : await sql`
            update game_matches
               set invitee_id = ${inviteeId},
                   status = ${status},
                   challenger_round_wins = ${challenger_round_wins},
                   invitee_round_wins = ${invitee_round_wins},
                   current_round = ${current_round},
                   pending_server_id = ${pendingServerId},
                   pending_band_a = ${pendingBandA},
                   plays = ${JSON.stringify(plays)}::jsonb
             where id = ${match.id}
            returning id`;
    }
  } catch (error) {
    console.error('game-match-play: update failed', error && error.message);
    return serverError('could not save your play');
  }
  if (joining && (!updated || !updated.length)) {
    let claimedBy = null;
    try {
      const again = await sql`
        select u.handle as claimer_handle
          from game_matches m
          left join users u on u.id = m.invitee_id
         where m.id = ${match.id}
         limit 1`;
      if (again && again[0]) claimedBy = again[0].claimer_handle || null;
    } catch (_) {
      // Cosmetic; the 409 still goes out.
    }
    return conflict('this match was just claimed', { claimed_by: claimedBy });
  }

  // Fresh state for the client.
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
    console.error('game-match-play: refetch failed', error && error.message);
    return serverError('could not load the match');
  }
  return ok({ match: matchState(fresh, fresh.challenger_handle, fresh.invitee_handle) });
};

export const config = { path: '/api/game-match/play' };
