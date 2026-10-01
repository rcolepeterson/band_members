// My challenges — the quiet status view for remote head-to-head.
//
// GET /api/game-challenges (auth)
//   -> { ok: true, sent: [...], received: [...] }
//
// Aaron's call: no emails, no pushes — "it's all in the game." A player
// learns their challenge was answered by opening the game, where this list
// shows what's waiting, what's answered, and what needs their move.
//   sent:     challenges I created (open = waiting on opponent, answered =
//             ready to reveal — includes the invitee's name and band_b)
//   received: challenges I answered (the matchup is complete on arrival)

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized();

  try {
    const sent = await sql`
      select c.token, c.status, c.band_a, c.band_b, c.created_at, c.answered_at,
             u.handle as invitee_handle
        from game_challenges c
        left join users u on u.id = c.invitee_id
       where c.challenger_id = ${me.id}
       order by c.created_at desc
       limit 20`;
    const received = await sql`
      select c.token, c.status, c.band_a, c.band_b, c.created_at, c.answered_at,
             u.handle as challenger_handle
        from game_challenges c
        join users u on u.id = c.challenger_id
       where c.invitee_id = ${me.id}
       order by c.created_at desc
       limit 20`;
    return ok({
      sent: (sent || []).map((r) => ({
        token: r.token,
        status: r.status,
        band_a: r.band_a,
        band_b: r.band_b,
        invitee_handle: r.invitee_handle,
        created_at: r.created_at,
        answered_at: r.answered_at,
      })),
      received: (received || []).map((r) => ({
        token: r.token,
        status: r.status,
        band_a: r.band_a,
        band_b: r.band_b,
        challenger_handle: r.challenger_handle,
        created_at: r.created_at,
        answered_at: r.answered_at,
      })),
    });
  } catch (error) {
    console.error('game-challenges: list failed', error && error.message);
    return serverError('could not load your challenges');
  }
};

export const config = { path: '/api/game-challenges' };
