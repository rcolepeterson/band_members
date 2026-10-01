// My matches — the quiet status view for structured head-to-head.
//
// GET /api/game-matches (auth)
//   -> { ok: true, sent: [...], received: [...] }
//
// Same quiet contract as game-challenges: no emails, no pushes. A player
// learns a match moved by opening the game. Each row carries the format,
// the round score, whose turn it is, and the invite token so the client can
// deep-link straight into the match.

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

function summarize(r) {
  return {
    token: r.token,
    format: r.format,
    status: r.status,
    challenger_round_wins: r.challenger_round_wins,
    invitee_round_wins: r.invitee_round_wins,
    current_round: r.current_round,
    pending_kind: r.pending_band_a ? 'defend' : (r.pending_server_id ? 'serve' : null),
    pending_server_id: r.pending_server_id,
    challenger_id: r.challenger_id,
    invitee_id: r.invitee_id,
    opponent_handle: r.opponent_handle,
    created_at: r.created_at,
    completed_at: r.completed_at,
    ends_at: r.ends_at,
  };
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized();

  try {
    const sent = await sql`
      select m.*, u.handle as opponent_handle
        from game_matches m
        left join users u on u.id = m.invitee_id
       where m.challenger_id = ${me.id}
       order by m.created_at desc
       limit 20`;
    const received = await sql`
      select m.*, u.handle as opponent_handle
        from game_matches m
        join users u on u.id = m.challenger_id
       where m.invitee_id = ${me.id}
       order by m.created_at desc
       limit 20`;
    return ok({
      sent: (sent || []).map(summarize),
      received: (received || []).map(summarize),
    });
  } catch (error) {
    console.error('game-matches: list failed', error && error.message);
    return serverError('could not load your matches');
  }
};

export const config = { path: '/api/game-matches' };
