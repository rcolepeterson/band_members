// Remote head-to-head challenges.
//
// POST /api/game-challenge — create a challenge (auth). body: { band_a }
//   -> { ok: true, token, inviteUrl }
// The challenger picks band one; the invite link goes to the opponent, who
// picks band two on their own device. Picks are OPEN: the invitee sees band
// one before choosing (matches the pass-and-play table behavior).
//
// GET /api/game-challenge?token=... — fetch challenge state. PUBLIC by
// design: the token is a 256-bit unguessable secret, and the invitee needs
// the challenger's name and band one BEFORE signing in, so the landing can
// say "Aaron challenged you with Metallica" instead of a blank login wall.
//   -> { ok: true, token, status, band_a, band_b, challenger_name, invitee_name }
//
// WHY the band refs are opaque strings, not UUIDs: the game client resolves
// bands against its loaded graph, whose node ids are display-name strings
// (city-suffixed only on collision), not database UUIDs. We validate shape
// here, not existence — a renamed or deleted band degrades to a fallback
// label on the client, which is acceptable for a game invite.

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
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

const MAX_BAND_REF = 160;

// Printable, non-empty, length-capped. Returns the cleaned ref or null.
export function validBandRef(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean.length > MAX_BAND_REF) return null;
  return clean;
}

export default async (req) => {
  const url = new URL(req.url);

  // --- POST: mint a challenge -----------------------------------------------
  if (req.method === 'POST') {
    if (!isDbConfigured()) return dbUnavailable();
    const sql = getSql();
    const me = await findUserByToken(sql, extractBearerToken(req));
    if (!me) return unauthorized('sign in to challenge a friend');

    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    const bandA = validBandRef(body && body.band_a);
    if (!bandA) return badRequest('pick a band first');

    // Per-user budget keyed by user id (not token) so rotating a credential
    // doesn't hand its holder a fresh budget. Fail-open like game-share.
    const budget = await consume({
      sql,
      bucket: `game-challenge:uid:${me.id}`,
      limit: 20,
      windowSeconds: 3600,
    });
    if (!budget.allowed) {
      return tooManyRequests('Too many challenges from this account. Try again shortly.', budget.retryAfterSeconds);
    }

    const token = generateToken();
    try {
      await sql`insert into game_challenges (token, challenger_id, band_a)
                values (${token}, ${me.id}, ${bandA})`;
    } catch (error) {
      console.error('game-challenge: insert failed', error && error.message);
      return serverError('could not create the challenge');
    }
    const origin = `${url.protocol}//${url.host}`;
    return ok({ token, inviteUrl: `${origin}/game/?invite=${encodeURIComponent(token)}` });
  }

  // --- GET: read challenge state (public; see header comment) ----------------
  if (req.method === 'GET') {
    const token = String(url.searchParams.get('token') || '').slice(0, 128);
    if (!token) return badRequest('missing token');
    if (!isDbConfigured()) return dbUnavailable();
    const sql = getSql();
    let rows;
    try {
      rows = await sql`
        select c.token, c.status, c.band_a, c.band_b, c.created_at, c.answered_at,
               u1.name as challenger_name, u2.name as invitee_name
          from game_challenges c
          join users u1 on u1.id = c.challenger_id
          left join users u2 on u2.id = c.invitee_id
         where c.token = ${token}
         limit 1`;
    } catch (error) {
      console.error('game-challenge: fetch failed', error && error.message);
      return serverError('could not load the challenge');
    }
    const row = rows && rows[0];
    if (!row) return notFound('challenge not found');
    return ok({
      token: row.token,
      status: row.status,
      band_a: row.band_a,
      band_b: row.band_b,
      challenger_name: row.challenger_name,
      invitee_name: row.invitee_name,
    });
  }

  return methodNotAllowed();
};

export const config = { path: '/api/game-challenge' };
