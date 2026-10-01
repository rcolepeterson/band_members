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
// the challenger's handle and band one BEFORE signing in, so the landing can
// say "rawker4821 challenged you with Metallica" instead of a blank login
// wall. Handles (not real names) are returned for privacy.
//   -> { ok: true, token, status, band_a, band_b,
//        challenger_handle, invitee_handle,
//        you_are: 'challenger' | 'invitee' | 'spectator' }
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
  roleOf,
  gone,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { ensureHandle } from './me_handle.mjs';

const MAX_BAND_REF = 160;

// Head-to-head hygiene (Aaron's call): unanswered challenges expire after
// this many days — they quietly leave the active list. No graveyard, no
// pile-up. Answered challenges never expire: the matchup stays viewable.
// One constant so the window is a single-line change.
export const CHALLENGE_EXPIRY_DAYS = 5;

// True when an unanswered ('open') challenge is older than the expiry window.
// createdAt is whatever the driver returns for timestamptz (ISO string or
// Date). Bad data fails open — never expire on a date we can't parse.
export function challengeIsExpired(status, createdAt) {
  if (status !== 'open') return false;
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > CHALLENGE_EXPIRY_DAYS * 86400000;
}

// Fetch one challenge by token for the public single view. Returns { row }
// on success, or { error } carrying the 404/410 response — the 410 keeps a
// dead invite link from rendering an accept flow for a challenge that's
// already expired (the client shows its "ask for a fresh one" state).
export async function getChallengeDetail(sql, token) {
  let rows;
  try {
    rows = await sql`
      select c.token, c.status, c.band_a, c.band_b, c.created_at, c.answered_at,
             c.challenger_id, c.invitee_id,
             u1.handle as challenger_handle, u2.handle as invitee_handle
        from game_challenges c
        join users u1 on u1.id = c.challenger_id
        left join users u2 on u2.id = c.invitee_id
       where c.token = ${token}
       limit 1`;
  } catch (error) {
    console.error('game-challenge: fetch failed', error && error.message);
    return { error: serverError('could not load the challenge') };
  }
  const row = rows && rows[0];
  if (!row) return { error: notFound('challenge not found') };
  if (challengeIsExpired(row.status, row.created_at)) {
    return { error: gone('this challenge expired') };
  }
  return { row };
}

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
    // First challenge: make sure the challenger has a battle name. Fail-soft —
    // a handle hiccup must never block creating the challenge.
    try {
      await ensureHandle(sql, me);
    } catch (err) {
      console.error('game-challenge: ensureHandle failed', err && err.message);
    }
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
    const { error, row } = await getChallengeDetail(sql, token);
    if (error) return error;
    // Optional auth: identifies the viewer's relationship to the challenge so
    // the client can show the "already claimed" message to spectators (open
    // challenges shared to a feed) instead of the accept flow.
    let you_are = 'spectator';
    try {
      const viewer = await findUserByToken(sql, extractBearerToken(req));
      you_are = roleOf(viewer && viewer.id, row.challenger_id, row.invitee_id);
    } catch (_) {
      // Identification is cosmetic; the public state still loads.
    }
    return ok({
      token: row.token,
      status: row.status,
      band_a: row.band_a,
      band_b: row.band_b,
      challenger_handle: row.challenger_handle,
      invitee_handle: row.invitee_handle,
      you_are,
    });
  }

  return methodNotAllowed();
};

export const config = { path: '/api/game-challenge' };
