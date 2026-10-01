// Accept a remote head-to-head challenge.
//
// POST /api/game-challenge/accept — answer a challenge (auth).
//   body: { token, band_b }
//   -> { ok: true, band_a, band_b, challenger_handle }
//   -> 409 { ok: false, error, claimed_by } when someone else claimed it first
//
// Rules, in order:
//   - the challenge must exist and still be open (one answer per challenge)
//   - you cannot accept your own challenge (no playing yourself)
//   - band_b must differ from band_a (a matchup needs two bands)
// The claim is atomic (UPDATE ... WHERE status='open' AND invitee_id IS NULL):
// a feed-shared invite can bring two tappers at once, and exactly one wins.
// The chain itself is computed client-side from the two band refs, same as
// every other mode — the server only holds the matchup state.

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
  conflict,
} from './_db.mjs';
import { validBandRef } from './game_challenge.mjs';
import { ensureHandle } from './me_handle.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to accept the challenge');

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return badRequest('expected a JSON body');
  }
  const token = String((body && body.token) || '').slice(0, 128);
  const bandB = validBandRef(body && body.band_b);
  if (!token) return badRequest('missing token');
  if (!bandB) return badRequest('pick your band first');

  const budget = await consume({
    sql,
    bucket: `game-challenge-accept:uid:${me.id}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many answers from this account. Try again shortly.', budget.retryAfterSeconds);
  }

  let rows;
  try {
    rows = await sql`
      select id, challenger_id, band_a, status
        from game_challenges
       where token = ${token}
       limit 1`;
  } catch (error) {
    console.error('game-challenge-accept: lookup failed', error && error.message);
    return serverError('could not load the challenge');
  }
  const challenge = rows && rows[0];
  if (!challenge) return notFound('challenge not found');
  if (challenge.status !== 'open') return badRequest('this challenge already has an answer');
  if (challenge.challenger_id === me.id) return badRequest("you can't accept your own challenge");
  if (challenge.band_a === bandB) return badRequest('pick a different band than your challenger');

  // First answer: make sure the accepter has a battle name too.
  try {
    await ensureHandle(sql, me);
  } catch (err) {
    console.error('game-challenge-accept: ensureHandle failed', err && err.message);
  }

  // Atomic claim: exactly one writer flips an open, unclaimed challenge. A
  // feed-shared invite can bring two tappers at once — the loser gets a 409
  // with the claimer's handle instead of a corrupted row.
  let claimed;
  try {
    claimed = await sql`
      update game_challenges
         set invitee_id = ${me.id},
             band_b = ${bandB},
             status = 'answered',
             answered_at = now()
       where id = ${challenge.id}
         and status = 'open'
         and invitee_id is null
      returning id`;
  } catch (error) {
    console.error('game-challenge-accept: update failed', error && error.message);
    return serverError('could not save your answer');
  }
  if (!claimed || !claimed.length) {
    let claimerHandle = null;
    try {
      const again = await sql`
        select u.handle as claimer_handle
          from game_challenges c
          left join users u on u.id = c.invitee_id
         where c.id = ${challenge.id}
         limit 1`;
      if (again && again[0]) claimerHandle = again[0].claimer_handle || null;
    } catch (_) {
      // Cosmetic; the 409 still goes out.
    }
    return conflict('this challenge was just claimed', { claimed_by: claimerHandle });
  }

  let challengerHandle = 'Your challenger';
  try {
    const nameRows = await sql`select handle from users where id = ${challenge.challenger_id} limit 1`;
    if (nameRows && nameRows[0] && nameRows[0].handle) challengerHandle = nameRows[0].handle;
  } catch (_) {
    // Handle lookup is cosmetic; the matchup is already saved.
  }

  return ok({ band_a: challenge.band_a, band_b: bandB, challenger_handle: challengerHandle });
};

export const config = { path: '/api/game-challenge/accept' };
