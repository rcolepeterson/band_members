// Fantasy Band Game — shared scoring, validation, and date helpers.
//
// Imported by fantasy_play.mjs, fantasy_leaderboard.mjs, and
// fantasy_settle.mjs so the three endpoints can never drift apart on the
// numbers. Pure logic only: no DB access in this file, which is what makes
// it unit-testable offline (see tests/fantasy-endpoints.test.mjs).
//
// Rules implemented here are the LOCKED v1 numbers (spec §§3–6, updated
// 2026-11-07):
//   - Salary cap $100; five slots V / G / B / D / W.
//   - Value V per musician (capped top-3, from the embedded pool).
//   - Connection bonus +4 per pair sharing at least one band, capped +16.
//   - Crowd-split at HALF strength: adjusted V = V / (1 + 0.5 * share).
//   - Gold line 69: a day is won by beating 69 (strictly greater).
//   - Tiers: Gold 10 career wins, Platinum 25. Wins accumulate, never reset.
//
// Two deliberate v1 limits, both spec-vs-sim decisions — do not "fix" them
// without Aaron's word:
//   1. Connection bonus is SHARED-BAND ONLY. The spec's phrase "or a link
//      within a few degrees" is NOT implemented in v1: the sim and the
//      verified prototype both score shared-band pairs only.
//   2. Crowd-split shares are computed across that day's lineups exactly as
//      stored. A one-lineup solo day gives its own picks share 1.0, so the
//      formula still waters them down (adjusted V = V / 1.5). There is NO
//      special case exempting a lone lineup — the task and the sim formula
//      say implement it exactly, and the prototype verified two bands
//      sharing only Freddie settled correctly under the plain formula.

import { poolPlayer } from './_fantasy_pool.mjs';

export const GOLD_LINE = 69;
export const GOLD_WINS = 10;
export const PLATINUM_WINS = 25;
export const SALARY_CAP = 100;
export const CONNECTION_PER_PAIR = 4;
export const CONNECTION_CAP = 16;

export const SLOTS = ['V', 'G', 'B', 'D', 'W'];
export const SLOT_NAMES = {
  V: 'Vocalist',
  G: 'Guitar',
  B: 'Bass',
  D: 'Drums',
  W: 'Wild card',
};

// Round money-style: scores are stored and compared at 2dp. Rounding only
// at the end of a computation, never per musician, so a stored final score
// is exactly what the leaderboard orders by.
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function tierForWins(wins) {
  const w = Number(wins) || 0;
  if (w >= PLATINUM_WINS) return 'Platinum';
  if (w >= GOLD_WINS) return 'Gold';
  return null;
}

// --- Lineup validation -------------------------------------------------------
// validateSlots(slots) -> { ok: true, picks: [{slot, player}] }
//                      or { ok: false, error } with a client-safe message.
// `slots` is the POST body shape: { V, G, B, D, W: member_id }.
// Checks, in order: all five slots present; every id in the 100-player
// pool; all five distinct; each player eligible for its slot (W accepts
// any pool member); price sum <= $100. Never trusts client-supplied
// prices or scores — everything is recomputed from the embedded pool.
export function validateSlots(slots) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
    return { ok: false, error: 'slots must be an object with V, G, B, D, W member ids' };
  }
  const picks = [];
  for (const slot of SLOTS) {
    const id = slots[slot];
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: `slot ${slot} (${SLOT_NAMES[slot]}) is missing` };
    }
    const player = poolPlayer(id.trim());
    if (!player) {
      return { ok: false, error: `slot ${slot}: that musician is not in the 100-player pool` };
    }
    picks.push({ slot, player });
  }
  const ids = picks.map((p) => p.player.member_id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: 'the same musician cannot fill two slots' };
  }
  for (const { slot, player } of picks) {
    // W is the wild card: any pool member may fill it (spec §3 — e.g. Ray
    // Manzarek, whose eligible list is ['W'] only, but also anyone else).
    if (slot === 'W') continue;
    if (!player.eligible.includes(slot)) {
      return { ok: false, error: `${player.name} cannot fill the ${SLOT_NAMES[slot]} slot` };
    }
  }
  const capTotal = picks.reduce((sum, p) => sum + p.player.price, 0);
  if (capTotal > SALARY_CAP) {
    return { ok: false, error: `that lineup costs $${capTotal} — over the $${SALARY_CAP} cap`, capTotal };
  }
  return { ok: true, picks, capTotal };
}

// --- Scoring -----------------------------------------------------------------
// picks: [{ slot, player }] as returned by validateSlots, or any five
// pool-player entries in slot order. `pairs` name the shared band that
// connects each pair (first shared band alphabetically, for determinism).
export function connectionBonusFor(picks) {
  const pairs = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i].player;
      const b = picks[j].player;
      const shared = (a.all_bands || []).filter((band) => (b.all_bands || []).includes(band)).sort();
      if (shared.length) {
        pairs.push({ a: a.member_id, b: b.member_id, a_name: a.name, b_name: b.name, band: shared[0] });
      }
    }
  }
  const bonus = Math.min(CONNECTION_CAP, pairs.length * CONNECTION_PER_PAIR);
  return { bonus, pairs };
}

// Provisional score: what the player sees at submit time, before the day
// settles (crowd-split needs the whole day's field, which does not exist
// yet). sum(V) + connection bonus.
export function scoreLineup(picks) {
  const valueSum = round2(picks.reduce((sum, p) => sum + p.player.V, 0));
  const { bonus: connectionBonus, pairs } = connectionBonusFor(picks);
  const capTotal = picks.reduce((sum, p) => sum + p.player.price, 0);
  return {
    valueSum,
    connectionBonus,
    pairs,
    capTotal,
    provisional: round2(valueSum + connectionBonus),
  };
}

// Final score: sum of crowd-split-adjusted V + connection bonus.
// shares: { member_id: pick share in [0, 1] } for the play date.
// Algebraically identical to the spec's form adjusted V = V / (1 + 0.5*s):
//   V/(1+0.5s) = V + V*(1/(1+0.5s) - 1)
// so the penalty term below is the spec formula, not a second formula.
export function finalScoreFor(picks, shares) {
  const { bonus: connectionBonus, pairs } = connectionBonusFor(picks);
  let adjustedSum = 0;
  const adjustments = [];
  for (const { player } of picks) {
    const share = Number(shares?.[player.member_id]) || 0;
    const adjusted = player.V / (1 + 0.5 * share);
    adjustments.push({ member_id: player.member_id, name: player.name, V: player.V, share, adjusted: round2(adjusted) });
    adjustedSum += adjusted;
  }
  return {
    valueSum: round2(picks.reduce((sum, p) => sum + p.player.V, 0)),
    connectionBonus,
    pairs,
    adjustments,
    final: round2(adjustedSum + connectionBonus),
  };
}

export function isWin(finalScore) {
  // Strictly greater: exactly 69.00 does NOT win ("beat 69").
  return Number(finalScore) > GOLD_LINE;
}

// --- Dates -------------------------------------------------------------------
// Pacific-day helpers. The fantasy day is the Pacific date (same rule as
// Daily's pacificDate in _daily.mjs — the game is Seattle-born).
export function previousPacificDate(date) {
  // Noon UTC keeps the calendar date unambiguous across DST boundaries.
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Pacific week containing `date`, Monday-start (ISO week). The spec says
// the weekly board resets "each week" without defining the week; Monday
// start is the call made here — flag it if Aaron wants Sunday start
// (his approvals week starts Sunday) instead. Returns { start, end }
// as YYYY-MM-DD Pacific dates, inclusive.
export function weekContaining(date) {
  const d = new Date(`${date}T12:00:00Z`);
  // getUTCDay: 0 = Sunday … 6 = Saturday. Monday-start offset:
  const day = d.getUTCDay();
  const back = (day + 6) % 7; // days since Monday
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - back);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// Public view of one pool player for API responses (no internals leak).
export function publicPlayer(player) {
  return {
    member_id: player.member_id,
    name: player.name,
    V: player.V,
    price: player.price,
    eligible: [...player.eligible],
  };
}
