// Structured head-to-head matches.
//
// POST /api/game-match — create a match (auth). body: { format, band_a }
//   format: best3 | best5 | best7 | timed | open
//   -> { ok: true, token, inviteUrl }
// The challenger's band_a is their serve for round 1, play 1. The invitee
// opens /game/?match=<token>, signs in, and defends by picking band_b.
//
// GET /api/game-match?token= — fetch match state. PUBLIC (same rationale as
// game-challenge): the invitee needs the format and band_a before signing in.
//   -> { ok, token, format, status, challenger_name, invitee_name,
//        challenger_round_wins, invitee_round_wins, current_round,
//        plays: [{round, server_id, band_a, band_b, hops}],
//        pending: null | { kind: 'defend'|'serve', server_id, band_a },
//        winner_id, ends_at }
//
// Scoring: higher hop count wins the round; tie rounds are replayed (no one
// scores). Serve order is tennis-style: the challenger leads odd rounds,
// the invitee leads even rounds. The chain itself is computed client-side
// from the graph — the server holds the bracket state, not the tree.

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
  generateToken,
} from './_db.mjs';
import { validBandRef } from './game_challenge.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

export const MATCH_FORMATS = ['best3', 'best5', 'best7', 'timed', 'open'];

// Rounds needed to take the match, per format (timed/open have no target).
export const FORMAT_TARGET_WINS = { best3: 2, best5: 3, best7: 4 };

export function validMatchFormat(raw) {
  return typeof raw === 'string' && MATCH_FORMATS.includes(raw) ? raw : null;
}

export function targetWins(format) {
  return FORMAT_TARGET_WINS[format] || 0;
}

// Shape of the public state payload shared by create/get and the play/serve
// endpoints (they all return the fresh state after mutating).
export function matchState(row, challengerName, inviteeName) {
  const plays = Array.isArray(row.plays) ? row.plays : [];
  let pending = null;
  if (row.status !== 'complete') {
    if (row.pending_band_a) {
      pending = { kind: 'defend', server_id: row.pending_server_id, band_a: row.pending_band_a };
    } else if (row.pending_server_id) {
      pending = { kind: 'serve', server_id: row.pending_server_id, band_a: null };
    }
  }
  let winner_id = null;
  if (row.status === 'complete') {
    if (row.challenger_round_wins > row.invitee_round_wins) winner_id = row.challenger_id;
    else if (row.invitee_round_wins > row.challenger_round_wins) winner_id = row.invitee_id;
  }
  return {
    token: row.token,
    format: row.format,
    status: row.status,
    challenger_id: row.challenger_id,
    invitee_id: row.invitee_id,
    challenger_name: challengerName,
    invitee_name: inviteeName,
    challenger_round_wins: row.challenger_round_wins,
    invitee_round_wins: row.invitee_round_wins,
    current_round: row.current_round,
    plays,
    pending,
    winner_id,
    ends_at: row.ends_at,
  };
}

async function loadMatch(sql, token) {
  const rows = await sql`
    select m.*, u1.name as challenger_name, u2.name as invitee_name
      from game_matches m
      join users u1 on u1.id = m.challenger_id
      left join users u2 on u2.id = m.invitee_id
     where m.token = ${token}
     limit 1`;
  return (rows && rows[0]) || null;
}

export default async (req) => {
  const url = new URL(req.url);

  // --- POST: start a match --------------------------------------------------
  if (req.method === 'POST') {
    if (!isDbConfigured()) return dbUnavailable();
    const sql = getSql();
    const me = await findUserByToken(sql, extractBearerToken(req));
    if (!me) return unauthorized('sign in to start a match');

    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    const format = validMatchFormat(body && body.format);
    const bandA = validBandRef(body && body.band_a);
    if (!format) return badRequest('pick a match format');
    if (!bandA) return badRequest('pick a band first');

    const budget = await consume({
      sql,
      bucket: `game-match:uid:${me.id}`,
      limit: 20,
      windowSeconds: 3600,
    });
    if (!budget.allowed) {
      return tooManyRequests('Too many matches from this account. Try again shortly.', budget.retryAfterSeconds);
    }

    const token = generateToken();
    try {
      if (format === 'timed') {
        await sql`insert into game_matches
                    (token, challenger_id, format, pending_server_id, pending_band_a, ends_at)
                  values (${token}, ${me.id}, ${format}, ${me.id}, ${bandA}, now() + interval '10 minutes')`;
      } else {
        await sql`insert into game_matches
                    (token, challenger_id, format, pending_server_id, pending_band_a)
                  values (${token}, ${me.id}, ${format}, ${me.id}, ${bandA})`;
      }
    } catch (error) {
      console.error('game-match: insert failed', error && error.message);
      return serverError('could not start the match');
    }
    const origin = `${url.protocol}//${url.host}`;
    return ok({ token, inviteUrl: `${origin}/game/?match=${encodeURIComponent(token)}` });
  }

  // --- GET: read match state (public; see header comment) --------------------
  if (req.method === 'GET') {
    const token = String(url.searchParams.get('token') || '').slice(0, 128);
    if (!token) return badRequest('missing token');
    if (!isDbConfigured()) return dbUnavailable();
    const sql = getSql();
    let row;
    try {
      row = await loadMatch(sql, token);
    } catch (error) {
      console.error('game-match: fetch failed', error && error.message);
      return serverError('could not load the match');
    }
    if (!row) return notFound('match not found');
    return ok(matchState(row, row.challenger_name || 'Your challenger', row.invitee_name));
  }

  return methodNotAllowed();
};

export const config = { path: '/api/game-match' };
