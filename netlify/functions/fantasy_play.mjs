// Fantasy Band Game — submit a lineup / read today's state.
//
// POST /api/fantasy-play (auth) — body { slots: { V, G, B, D, W: member_id },
//   guest_session_id? }:
//   Validates the five picks server-side against the embedded 100-player
//   pool (all in pool, all distinct, slot-eligible, $100 cap) and stores
//   one lineup per user per Pacific day. A second submit the same day
//   returns 409 — the same one-play-per-day rule as Daily Chain
//   (game_daily_play.mjs). The server recomputes the provisional score;
//   the client's score is never trusted.
//   -> { ok, date, lineup, provisional, valueSum, connectionBonus,
//        pairs, capTotal, submittedAt }
//
// GET /api/fantasy-play (auth) — today's state (the /api/fantasy-today
//   contract the game page expects, served from this same function):
//   the user's lineup if any, provisional, final + win if settled, the
//   day leaderboard, career wins + tier, whether today is settled, and
//   yesterday's winner.
//   -> { ok, date, settled, lineup, provisional, final, won,
//        leaderboard, career, yesterday }
//
// Auth mirrors Daily Chain exactly (game_daily_play.mjs, 2026-10-08):
// signed-in bearer token first; no token? a guest_session_id (POST body,
// or ?guest_session_id= on GET) resolves to — or creates — a guest user
// row, so fantasy is playable without signing in, and a guest's career
// wins persist under the same guest id. No bearer and no guest id -> 401.
// This is the deliberate choice: same as Daily, not signed-in-only.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  conflict,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
  generateToken,
} from './_db.mjs';
import { pacificDate } from './_daily.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { ensureHandle } from './me_handle.mjs';
import {
  GOLD_LINE,
  GOLD_WINS,
  PLATINUM_WINS,
  SALARY_CAP,
  validateSlots,
  scoreLineup,
  tierForWins,
  previousPacificDate,
} from './_fantasy.mjs';
import { loadLeaderboardEntries } from './fantasy_leaderboard.mjs';

// Resolve the caller the Daily way: bearer token, else guest_session_id.
async function resolvePlayer(sql, req, body) {
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (me) return me;
  const params = new URL(req.url).searchParams;
  const guestSessionId =
    (body && body.guest_session_id) || params.get('guest_session_id') || '';
  if (
    typeof guestSessionId !== 'string' ||
    guestSessionId.length < 8 ||
    guestSessionId.length > 64
  ) {
    return null;
  }
  const existing = await sql`
    select * from users where guest_session_id = ${guestSessionId} limit 1
  `.catch(() => []);
  if (existing && existing[0]) return existing[0];
  // Create a guest user row. Credits start at 50 (same as new users).
  // Token, email, name are NOT NULL — generate placeholders for guests.
  const guestToken = generateToken();
  const guestEmail = `guest_${guestSessionId}@guest.local`;
  const rows = await sql`
    insert into users (is_guest, guest_session_id, credits, token, email, name)
    values (true, ${guestSessionId}, 50, ${guestToken}, ${guestEmail}, 'Guest')
    returning *
  `.catch(() => []);
  return (rows && rows[0]) || null;
}

function publicLineup(row) {
  if (!row) return null;
  return {
    play_date: row.play_date,
    slots: row.slots,
    picks: row.picks,
    capTotal: row.price_total,
    valueSum: Number(row.value_sum),
    connectionBonus: row.connection_bonus,
    pairs: row.pairs || [],
    provisional: Number(row.provisional_score),
    final: row.final_score == null ? null : Number(row.final_score),
    won: row.won,
    submittedAt: row.submitted_at,
    settledAt: row.settled_at,
  };
}

async function careerFor(sql, userId) {
  const rows = await sql`
    select count(*) filter (where won) as wins
      from fantasy_lineups where user_id = ${userId}
  `.catch(() => []);
  const wins = Number((rows && rows[0] && rows[0].wins) || 0);
  return {
    wins,
    tier: tierForWins(wins),
    winsToGold: Math.max(0, GOLD_WINS - wins),
    winsToPlatinum: Math.max(0, PLATINUM_WINS - wins),
  };
}

async function yesterdayWinner(sql, today) {
  const yesterday = previousPacificDate(today);
  const rows = await sql`
    select d.settled_at, d.winner_score,
           coalesce(nullif(u.handle, ''), u.name, 'Player') as winner_name
      from fantasy_days d
      left join users u on u.id = d.winner_user_id
     where d.play_date = ${yesterday}
     limit 1
  `.catch(() => []);
  const row = rows && rows[0];
  return {
    date: yesterday,
    settled: !!(row && row.settled_at),
    winner:
      row && row.winner_name
        ? { name: row.winner_name, score: row.winner_score == null ? null : Number(row.winner_score) }
        : null,
  };
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const today = pacificDate();

  let body = null;
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
  }

  const me = await resolvePlayer(sql, req, body);
  if (!me) return unauthorized('sign in (or play as a guest) to play fantasy');

  // Per-user budget, same shape as Daily play (300/hr). The 409 below
  // makes submit-abuse moot, but the read side still wants a ceiling.
  const budget = await consume({
    sql,
    bucket: `fantasy-play:uid:${me.id}`,
    limit: 300,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many fantasy requests. Try again shortly.', budget.retryAfterSeconds);
  }

  // --- GET: today's state ---------------------------------------------------
  if (req.method === 'GET') {
    const rows = await sql`
      select * from fantasy_lineups
       where user_id = ${me.id} and play_date = ${today}
       limit 1
    `.catch(() => []);
    const lineup = rows && rows[0];
    const dayRows = await sql`
      select settled_at from fantasy_days where play_date = ${today} limit 1
    `.catch(() => []);
    const settled = !!(dayRows && dayRows[0] && dayRows[0].settled_at);
    const [entries, total] = await loadLeaderboardEntries(sql, { start: today, end: today });
    return ok({
      date: today,
      settled,
      goldLine: GOLD_LINE,
      lineup: publicLineup(lineup),
      provisional: lineup ? Number(lineup.provisional_score) : null,
      final: lineup && lineup.final_score != null ? Number(lineup.final_score) : null,
      won: lineup ? lineup.won : null,
      leaderboard: { scope: 'daily', date: today, total, entries },
      career: await careerFor(sql, me.id),
      yesterday: await yesterdayWinner(sql, today),
    });
  }

  // --- POST: submit today's lineup ------------------------------------------
  const check = validateSlots(body && body.slots);
  if (!check.ok) {
    return badRequest(check.error, check.capTotal ? { capTotal: check.capTotal, cap: SALARY_CAP } : {});
  }
  const { picks, capTotal } = check;
  const scored = scoreLineup(picks);

  // One lineup per user per Pacific day (Daily's rule). The unique
  // (user_id, play_date) index is the backstop; this read gives the
  // friendly 409 with the existing lineup attached.
  const existing = await sql`
    select * from fantasy_lineups
     where user_id = ${me.id} and play_date = ${today}
     limit 1
  `.catch(() => []);
  if (existing && existing[0]) {
    return conflict('you already submitted a lineup today', { lineup: publicLineup(existing[0]) });
  }

  await ensureHandle(sql, me).catch(() => null);

  const slotsJson = {};
  for (const { slot, player } of picks) slotsJson[slot] = player.member_id;
  const picksJson = picks.map(({ slot, player }) => ({
    slot,
    member_id: player.member_id,
    name: player.name,
    V: player.V,
    price: player.price,
  }));

  let inserted;
  try {
    inserted = await sql`
      insert into fantasy_lineups
        (user_id, play_date, slots, picks, price_total, value_sum,
         connection_bonus, pairs, provisional_score)
      values (${me.id}, ${today},
              ${JSON.stringify(slotsJson)}::jsonb,
              ${JSON.stringify(picksJson)}::jsonb,
              ${capTotal}, ${scored.valueSum},
              ${scored.connectionBonus},
              ${JSON.stringify(scored.pairs)}::jsonb,
              ${scored.provisional})
      on conflict (user_id, play_date) do nothing
      returning *
    `;
  } catch (err) {
    console.error('fantasy-play: insert failed', err && err.message);
    return serverError('could not save the lineup');
  }
  if (!inserted || !inserted[0]) {
    // Lost a race with a concurrent submit — the other one won.
    const rows = await sql`
      select * from fantasy_lineups
       where user_id = ${me.id} and play_date = ${today}
       limit 1
    `.catch(() => []);
    return conflict('you already submitted a lineup today', {
      lineup: rows && rows[0] ? publicLineup(rows[0]) : null,
    });
  }

  const row = inserted[0];
  return ok({
    date: today,
    lineup: publicLineup(row),
    provisional: scored.provisional,
    valueSum: scored.valueSum,
    connectionBonus: scored.connectionBonus,
    pairs: scored.pairs,
    capTotal,
  });
};

export const config = { path: '/api/fantasy-play' };
