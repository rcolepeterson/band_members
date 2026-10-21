// Card game play stats (anonymous) for sixdegreesofrock.com/cards.
//
// POST /api/cards-stats — body { type, anon, deck, ... }:
//   start — a game was dealt:  { type: 'start', anon, deck }
//   end   — a game finished:   { type: 'end', anon, deck, turns, stalls,
//                                ricky_plays, winner: 'you' | 'cpu',
//                                winner_name, duration_s }
//
// Deliberately unauthenticated and anonymous. The card game is guest play
// (no sign-in gate — sign-in is a prize, not a gate), and this endpoint
// exists for aggregate feel: how many games start vs. finish, how long
// they run, how often Ricky gets played, whether the human or the CPUs
// are winning. `anon` is a random per-browser id the client keeps in
// localStorage; it carries no identity and only lets repeat players be
// counted as repeats.
//
// Stats live in the site's existing Neon database, in their own table
// (cards_games) next to the Daily game's tables — lookups later are
// plain SQL or an ops-board card, same as the Daily Chain numbers.
// The table creates itself on first write (the if-not-exists pattern
// from _rate_limit.mjs), so there is no migration step to run.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  methodNotAllowed,
  serverError,
  dbUnavailable,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

let tableReady = null;
function ensureTable(sql) {
  if (!tableReady) {
    tableReady = sql`
      create table if not exists cards_games (
        id bigserial primary key,
        event text not null,
        anon text,
        deck text,
        turns integer,
        stalls integer,
        ricky_plays integer,
        winner text,
        winner_name text,
        duration_s integer,
        created_at timestamptz not null default now()
      )
    `.catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function cleanStr(v, max) {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();

  // Generous per-IP budget: a start + an end per game is two calls, and
  // even a very enthusiastic table won't deal 120 games a minute.
  try {
    const rl = await consume({
      sql,
      bucket: `cards-stats:${clientIp(req)}`,
      limit: 120,
      windowSeconds: 60,
    });
    if (!rl.allowed) return tooManyRequests('rate limit exceeded', rl.retryAfterSeconds);
  } catch (err) {
    // consume() already degrades to allowed on internal failure; this is
    // extra safety — log and continue (same posture as game_analytics).
    console.error('cards-stats rate limit check failed', err);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('invalid JSON body');
  }

  const type = body?.type;
  if (type !== 'start' && type !== 'end') {
    return badRequest("type must be 'start' or 'end'");
  }
  const anon = cleanStr(body.anon, 64);
  const deck = cleanStr(body.deck, 40) || 'unknown';

  try {
    await ensureTable(sql);
    if (type === 'start') {
      await sql`
        insert into cards_games (event, anon, deck)
        values ('start', ${anon}, ${deck})
      `;
      return ok({});
    }
    const winner =
      body.winner === 'you' || body.winner === 'cpu' ? body.winner : null;
    await sql`
      insert into cards_games
        (event, anon, deck, turns, stalls, ricky_plays, winner, winner_name, duration_s)
      values
        ('end', ${anon}, ${deck},
         ${clampInt(body.turns, 0, 100000)},
         ${clampInt(body.stalls, 0, 100000)},
         ${clampInt(body.ricky_plays, 0, 1000)},
         ${winner},
         ${cleanStr(body.winner_name, 40)},
         ${clampInt(body.duration_s, 0, 86400)})
    `;
    return ok({});
  } catch (err) {
    console.error('cards-stats write failed', err);
    return serverError('could not record stats');
  }
};

export const config = { path: '/api/cards-stats' };
