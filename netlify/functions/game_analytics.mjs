// Game analytics event ingestion.
//
// POST /api/analytics/game-event — fire-and-forget event from the game client.
//   body: {
//     session_id: string (required, client-generated UUID per game),
//     event_type: 'game_started' | 'move_made' | 'hint_clicked' | 'game_completed' (required),
//     game_mode?: 'daily_chain' | 'match_play' | 'solo' | 'casual',
//     band_a?: string, band_b?: string,
//     result?: 'win' | 'loss' | 'abandon',       // game_completed only
//     moves_count?: number, hints_used?: number, // game_completed only
//     duration_seconds?: number,                 // game_completed only
//     move_number?: number,                      // move_made only
//   }
//   -> { ok: true }
//
// WHY THIS EXISTS
//
// Cole asked for 4 engagement metrics (Oct 2026): Games Started per User,
// Win/Loss/Abandon Rate, Hint Clicks, Average Moves per Game. The ops board
// aggregates these from this table. This endpoint is the write side.
//
// WHY NO AUTH
//
// Anonymous play is a first-class product decision (game plan: "un-gated guest
// play"). Requiring a bearer token would either block anonymous events or force
// us to mint throwaway credentials. Instead: no auth, but rate-limited per IP,
// and the payload carries no PII — user_id is resolved server-side from the
// optional bearer token if present, NULL otherwise.
//
// WHY FIRE-AND-FORGET
//
// The client sends these with keepalive fetch and never awaits the response.
// If this endpoint is slow or down, gameplay must not stutter. The handler
// therefore does the minimum: validate, insert, return. No side effects.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

const VALID_EVENT_TYPES = new Set(['game_started', 'move_made', 'hint_clicked', 'game_completed']);
const VALID_RESULTS = new Set(['win', 'loss', 'abandon']);
const VALID_MODES = new Set(['daily_chain', 'match_play', 'solo', 'casual']);

// 100 events/min per IP — comfortably above real play (a game is ~10 events),
// well below what a spam script would want.
const RATE_LIMIT = { limit: 100, windowSeconds: 60 };

const MAX_TEXT = 200;

function asText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, MAX_TEXT);
}

function asInt(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  // Rate limit per IP (no auth on this endpoint by design)
  const ip = clientIp(req);
  try {
    const rl = await consume({
      sql,
      bucket: `game_analytics:${ip}`,
      limit: RATE_LIMIT.limit,
      windowSeconds: RATE_LIMIT.windowSeconds,
    });
    if (!rl.allowed) return tooManyRequests('rate limit exceeded', rl.retryAfterSeconds);
  } catch (err) {
    // consume() already degrades to allowed:true on internal failure,
    // so this catch is just extra safety — log and continue.
    console.error('game-analytics rate limit check failed', err);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('invalid JSON body');
  }

  const sessionId = asText(body.session_id);
  const eventType = asText(body.event_type);

  if (!sessionId) return badRequest('session_id is required');
  if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
    return badRequest('event_type must be one of: ' + [...VALID_EVENT_TYPES].join(', '));
  }

  // Resolve user_id from bearer token if present (NULL for anonymous)
  let userId = null;
  try {
    const token = extractBearerToken(req);
    if (token) {
      const user = await findUserByToken(sql, token);
      if (user) userId = user.id;
    }
  } catch {
    // Auth lookup failure → treat as anonymous, don't block the event
    userId = null;
  }

  const gameMode = asText(body.game_mode);
  const bandA = asText(body.band_a);
  const bandB = asText(body.band_b);
  const result = asText(body.result);
  const movesCount = asInt(body.moves_count);
  const hintsUsed = asInt(body.hints_used);
  const durationSeconds = asInt(body.duration_seconds);

  if (gameMode && !VALID_MODES.has(gameMode)) {
    return badRequest('game_mode must be one of: ' + [...VALID_MODES].join(', '));
  }
  if (result && !VALID_RESULTS.has(result)) {
    return badRequest('result must be one of: ' + [...VALID_RESULTS].join(', '));
  }

  try {
    await sql`
      insert into game_analytics_events
        (user_id, session_id, event_type, game_mode, band_a, band_b,
         result, moves_count, hints_used, duration_seconds)
      values
        (${userId}, ${sessionId}, ${eventType}, ${gameMode}, ${bandA}, ${bandB},
         ${result}, ${movesCount}, ${hintsUsed}, ${durationSeconds})
    `;
  } catch (err) {
    console.error('game-analytics insert failed', err);
    return serverError('failed to record event');
  }

  return ok({});
};

// Netlify Functions v2 route config
export const config = { path: '/api/analytics/game-event' };
