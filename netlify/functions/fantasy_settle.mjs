// Fantasy Band Game — nightly settle.
//
// Scheduled: just after midnight Pacific, for the just-ended Pacific date.
// Netlify evaluates `config.schedule` in UTC (same as the site's other
// crons — see cron_verify_stale_bands.mjs, which accepts the same DST
// tradeoff): '5 8 * * *' is 00:05 PST in winter and 01:05 PDT in summer.
// Always after midnight Pacific, never before it — so the day being
// settled is always complete. No netlify.toml entry and no Netlify UI
// step: the schedule ships with the file, like every other cron here.
//
// What a settle does for one Pacific date:
//   1. pick shares per musician = lineups containing them / lineups that day
//   2. final score per lineup = sum(V / (1 + 0.5*share)) + connection bonus
//      (the sim's verified half-strength formula; see _fantasy.mjs —
//      algebraically the spec's adjusted-V form)
//   3. win iff final > 69 (strictly greater)
//   4. store final scores, win flags, and the shares; record the day in
//      fantasy_days with its winner (highest final; ties: connection
//      bonus desc, earliest submission)
//
// IDEMPOTENT by construction: a re-run recomputes from the stored lineups
// and overwrites the same columns in place. Career wins are DERIVED —
// fantasy_play counts stored won flags, never increments a counter — so
// re-settling a day can never double-count a win. A settle never settles
// today or a future date (the day must be over), and never touches any
// graph table (fantasy lives in its own tables; see fantasy-migration-v1.sql).
//
// Manual runs: fantasy_settle_trigger.mjs (POST /api/cron-fantasy-settle,
// admin token, ?date=YYYY-MM-DD, ?dry=1) imports settleFantasyDay from
// here, so the cron and the manual path are the same code — the
// cron_verify_stale_bands pattern.

import { getSql, isDbConfigured } from './_db.mjs';
import { pacificDate, validChainDate } from './_daily.mjs';
import { poolPlayer } from './_fantasy_pool.mjs';
import {
  GOLD_LINE,
  finalScoreFor,
  isWin,
  previousPacificDate,
} from './_fantasy.mjs';

// Settle one Pacific date. Returns a summary; with { dryRun: true } it
// computes everything and writes nothing. Throws on a bad date or on
// trying to settle a day that is not over yet — the caller turns that
// into the HTTP error.
export async function settleFantasyDay(sql, date, { dryRun = false, settledBy = 'cron' } = {}) {
  const day = validChainDate(date);
  if (!day) throw new Error('settle needs a YYYY-MM-DD date');
  if (day >= pacificDate()) throw new Error('cannot settle a day that is not over yet');

  const lineups = await sql`
    select * from fantasy_lineups where play_date = ${day} order by submitted_at asc
  `;
  const total = (lineups || []).length;

  if (total === 0) {
    if (!dryRun) {
      await sql`
        insert into fantasy_days (play_date, lineups, settled_at, settled_by)
        values (${day}, 0, now(), ${settledBy})
        on conflict (play_date) do update
           set lineups = 0, settled_at = now(), settled_by = ${settledBy},
               winner_user_id = null, winner_score = null, shares = '{}'::jsonb
      `;
    }
    return { date: day, lineups: 0, wins: 0, winner: null, dryRun };
  }

  // Pick shares across the day's lineups. No special case for a lone
  // lineup: its picks get share 1.0 and the formula applies as written
  // (adjusted V = V / 1.5). See _fantasy.mjs for why that is deliberate.
  const counts = new Map();
  const parsed = [];
  for (const row of lineups) {
    const slots = row.slots || {};
    const picks = [];
    for (const slot of ['V', 'G', 'B', 'D', 'W']) {
      const player = poolPlayer(slots[slot]);
      if (!player) throw new Error(`lineup ${row.id} names a player outside the pool`);
      picks.push({ slot, player });
    }
    for (const { player } of picks) {
      counts.set(player.member_id, (counts.get(player.member_id) || 0) + 1);
    }
    parsed.push({ row, picks });
  }
  const shares = {};
  for (const [memberId, count] of counts) shares[memberId] = count / total;

  // Score every lineup, then rank for the winner.
  const scored = parsed.map(({ row, picks }) => {
    const result = finalScoreFor(picks, shares);
    const won = isWin(result.final);
    return { row, picks, result, won };
  });
  const ranked = [...scored].sort((a, b) => {
    if (b.result.final !== a.result.final) return b.result.final - a.result.final;
    if (b.result.connectionBonus !== a.result.connectionBonus) {
      return b.result.connectionBonus - a.result.connectionBonus;
    }
    return new Date(a.row.submitted_at) - new Date(b.row.submitted_at);
  });
  const winner = ranked[0];
  const wins = scored.filter((s) => s.won).length;

  if (!dryRun) {
    for (const { row, result, won } of scored) {
      const myShares = {};
      for (const adj of result.adjustments) myShares[adj.member_id] = adj.share;
      await sql`
        update fantasy_lineups
           set final_score = ${result.final},
               won = ${won},
               shares = ${JSON.stringify(myShares)}::jsonb,
               settled_at = now()
         where id = ${row.id}
      `;
    }
    await sql`
      insert into fantasy_days
        (play_date, lineups, settled_at, settled_by, shares, winner_user_id, winner_score)
      values (${day}, ${total}, now(), ${settledBy},
              ${JSON.stringify(shares)}::jsonb,
              ${winner.row.user_id}, ${winner.result.final})
      on conflict (play_date) do update
         set lineups = ${total}, settled_at = now(), settled_by = ${settledBy},
             shares = ${JSON.stringify(shares)}::jsonb,
             winner_user_id = ${winner.row.user_id},
             winner_score = ${winner.result.final}
    `;
  }

  return {
    date: day,
    lineups: total,
    wins,
    winner: { userId: winner.row.user_id, score: winner.result.final },
    dryRun,
  };
}

export const config = { schedule: '5 8 * * *' };

export default async () => {
  if (!isDbConfigured()) {
    console.log('[cron:fantasy-settle] db not configured, skipping');
    return;
  }
  const yesterday = previousPacificDate(pacificDate());
  try {
    const summary = await settleFantasyDay(getSql(), yesterday);
    console.log(`[cron:fantasy-settle] complete: ${JSON.stringify(summary)}`);
  } catch (err) {
    console.error('[cron:fantasy-settle] failed:', err && err.message);
    throw err;
  }
};
