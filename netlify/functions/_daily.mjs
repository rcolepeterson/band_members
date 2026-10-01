// Daily Chain — shared core (pure, Node-testable).
//
// The Wordle-style daily: one band pair per day (lottery, date-seeded),
// the player builds the chain link-by-link from 4 multiple-choice options
// per hop. This module holds the deterministic pieces every endpoint and
// test shares: date handling, seeded PRNG, server-side band graph,
// option generation, streak math, credit economy constants, and share copy.
//
// The server keeps its own band adjacency (bands linked by shared members)
// so option kinds stay hidden from the client — the client never learns
// which option is optimal.

// ---------------------------------------------------------------------------
// Economy & rules (single source of truth)
// ---------------------------------------------------------------------------

export const HINT_COST = 10;          // credits per hint ("help me choose")
export const ESCAPE_COST = 50;        // 5x a hint — digging out of a dead end
export const FREEZE_COST = 100;       // Seattle Freeze purchase
export const ARCHIVE_COST = 75;       // play a missed day, repair the streak
export const COMPLETION_REWARD = 20;  // credits for finishing the daily chain
export const OPTIMAL_BONUS = 10;      // extra when hops_used === optimal_hops
export const REPLAY_IMPROVEMENT_PER_HOP = 5; // replay credits per hop better than your best
export const BEAT_TREE_BOUNTY = 50;   // outsmart the tree's par (graph grew since deal)
export const MATCH_WIN_REWARD = 10;   // credits for winning a structured match
export const STARTING_CREDITS = 50;   // new users start with a taste

export const MIN_HOPS = 3;            // daily pair shortest-path floor
export const MAX_HOPS = 6;            // daily pair shortest-path ceiling
export const NO_REPEAT_DAYS = 90;     // pair quarantine window
export const OPTIONS_PER_STEP = 4;

// Hints per run: floor(optimal_hops / 2). A 5-hop chain gets 2 — scarce
// enough that you can't hint your way to victory.
export function hintsFor(optimalHops) {
  return Math.max(0, Math.floor(Number(optimalHops) / 2));
}

// ---------------------------------------------------------------------------
// Dates — the chain day is Pacific (the game is Seattle-born).
// ---------------------------------------------------------------------------

export function pacificDate(when = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when);
}

export function validChainDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(raw + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible calendar dates (2026-02-30 parses but isn't real).
  const [y, m, day] = raw.split('-').map(Number);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return null;
  return raw;
}

// Whole-day difference: b - a, in days.
export function dayDiff(a, b) {
  const da = new Date(a + 'T12:00:00Z').getTime();
  const db = new Date(b + 'T12:00:00Z').getTime();
  return Math.round((db - da) / 86400000);
}

// ---------------------------------------------------------------------------
// Seeded PRNG — the lottery. Same date + same graph = same pair, everywhere.
// ---------------------------------------------------------------------------

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — small, deterministic, good enough for dealing bands.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Server-side band graph (built from memberships; mirrors the client engine)
// ---------------------------------------------------------------------------

// memberships: [{ band_id, member_id }]; meta: Map<bandId, {name, genre, years_active}>
// Returns { adj: Map<bandId, Set<bandId>>, degree: Map<bandId, number> }.
export function buildBandAdj(memberships) {
  const byMember = new Map();
  for (const ms of memberships || []) {
    if (!ms || !ms.band_id || !ms.member_id) continue;
    if (!byMember.has(ms.member_id)) byMember.set(ms.member_id, []);
    byMember.get(ms.member_id).push(ms.band_id);
  }
  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const bands of byMember.values()) {
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) link(bands[i], bands[j]);
    }
  }
  const degree = new Map();
  for (const [id, set] of adj) degree.set(id, set.size);
  return { adj, degree };
}

// BFS band-hop distances from targetId. Returns Map<bandId, hops>.
export function bfsDist(adj, targetId) {
  const dist = new Map([[targetId, 0]]);
  const queue = [targetId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const nb of adj.get(cur) || []) {
      if (!dist.has(nb)) {
        dist.set(nb, dist.get(cur) + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Seeded fair-pair deal: shortest path within [minHops, maxHops], skipping
// any pair in excludeKeys. Returns { a, b, hops } or null.
export function pickDailyPair({ bandIds, adj, seed, minHops = MIN_HOPS, maxHops = MAX_HOPS, excludeKeys = new Set(), maxTries = 400 }) {
  const rng = mulberry32(hashSeed(seed));
  const n = bandIds.length;
  if (n < 2) return null;
  for (let t = 0; t < maxTries; t++) {
    const a = bandIds[(rng() * n) | 0];
    let b = bandIds[(rng() * n) | 0];
    if (b === a) b = bandIds[((rng() * n) | 0 + 1) % n];
    if (a === b || excludeKeys.has(pairKey(a, b))) continue;
    const dist = bfsDist(adj, b);
    const hops = dist.get(a);
    if (hops === undefined || hops < minHops || hops > maxHops) continue;
    return { a, b, hops };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multiple-choice options for one hop
// ---------------------------------------------------------------------------
// Kinds:
//   optimal — on a shortest path (dist == d - 1)
//   solid   — real neighbor, off the optimal path (valid, longer)
//   obscure — real neighbor with a tiny degree (valid, scenic route)
//   deadend — NOT a neighbor; plausible trap (same genre, no shared member)
//
// Returns [{ band_id, kind }] shuffled, length up to OPTIONS_PER_STEP.
// When valid neighbors are scarce, extra dead ends fill the slate.

export function optionsFor({ adj, dist, degree, meta, currentId, excludeIds = new Set(), trapExcludeIds = new Set(), rng = Math.random }) {
  const d = dist.get(currentId);
  const neighbors = [...(adj.get(currentId) || [])].filter((id) => !excludeIds.has(id));
  const optimal = [];
  const solid = [];
  const obscure = [];
  for (const nb of neighbors) {
    const nd = dist.get(nb);
    if (nd === undefined) continue;
    if (d !== undefined && nd === d - 1) optimal.push(nb);
    else if ((degree.get(nb) || 0) <= 2) obscure.push(nb);
    else solid.push(nb);
  }
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const picked = [];
  const take = (pool, kind) => {
    for (const id of shuffle(pool)) {
      if (picked.length >= OPTIONS_PER_STEP) return;
      if (picked.some((p) => p.band_id === id)) continue;
      picked.push({ band_id: id, kind });
    }
  };
  take(optimal, 'optimal');
  take(solid, 'solid');
  take(obscure, 'obscure');

  // Dead ends: plausible but wrong — same genre, no shared member, not the
  // target, not already on the slate.
  if (picked.length < OPTIONS_PER_STEP && meta) {
    const cur = meta.get(currentId) || {};
    const neighborSet = new Set(neighbors);
    const traps = [];
    const fallback = [];
    for (const [id, m] of meta) {
      if (id === currentId || neighborSet.has(id) || excludeIds.has(id)) continue;
      if (trapExcludeIds.has(id)) continue; // the target is never a trap
      if (picked.some((p) => p.band_id === id)) continue;
      if (dist.get(id) === undefined) continue; // unreachable bands make poor traps
      if (m && cur && m.genre && cur.genre && m.genre === cur.genre) traps.push(id);
      else fallback.push(id);
    }
    take(shuffle(traps).concat(shuffle(fallback)), 'deadend');
  }
  return shuffle(picked).slice(0, OPTIONS_PER_STEP);
}

// Share-card color per pick kind: gold (optimal) → robin's egg (valid but
// long) → black (dead end, lost in space).
export function pickColor(kind) {
  if (kind === 'optimal') return 'gold';
  if (kind === 'deadend') return 'black';
  return 'robin';
}

export const PICK_HEX = {
  gold: '#d9b36c',
  robin: '#9adbe8',
  black: '#151515',
};

// ---------------------------------------------------------------------------
// Streaks — derived from the completion set, never stored redundantly.
// ---------------------------------------------------------------------------
// applyCompletion({ dates, newDate, freezeCount }):
//   dates — array of 'YYYY-MM-DD' already completed (any order)
//   Returns { streak, freezeUsed, frozenDate, dates } where dates includes
//   newDate (and frozenDate when a Seattle Freeze burns).
//
// Rules: completing keeps/extends the trailing run. A missed single day
// breaks the streak unless a freeze is available — then the freeze burns
// and the missing day is backfilled as frozen.

export function applyCompletion({ dates = [], newDate, freezeCount = 0 }) {
  const set = new Set(dates);
  set.add(newDate);
  let freezeUsed = false;
  let frozenDate = null;
  const sorted = [...set].sort();
  const max = sorted[sorted.length - 1];
  // A Seattle Freeze bridges exactly one missed day: the day before the
  // trailing run's end is absent, but the day before that is present.
  const missing = addDays(max, -1);
  if (!set.has(missing) && missing !== newDate && freezeCount > 0 && set.has(addDays(missing, -1))) {
    freezeUsed = true;
    frozenDate = missing;
    set.add(missing);
  }
  // Trailing consecutive run ending at the latest completion.
  let streak = 0;
  let cursor = max;
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return { streak, freezeUsed, frozenDate, dates: [...set].sort() };
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Convenience: current streak from a completion set (no mutation).
export function currentStreak(dates = []) {
  if (!dates.length) return 0;
  const set = new Set(dates);
  const sorted = [...set].sort();
  let streak = 0;
  let cursor = sorted[sorted.length - 1];
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// Replay scoring (pure — the wallet rules for finishing a run).
// - First completion of the day: COMPLETION_REWARD (+ OPTIMAL_BONUS on par).
// - Replays: unlimited, but credits only for beating your previous best —
//   REPLAY_IMPROVEMENT_PER_HOP per hop better. No farming: once you hit
//   your floor, the well is dry.
// - Beat the tree: hopsUsed < par means the graph grew since the deal and a
//   genuinely shorter path appeared. BEAT_TREE_BOUNTY, and the tree learns
//   (newPar becomes the stored par). Rare enough to brag about.
export function scoreRun({ isFirst, hopsUsed, par, prevBest = null }) {
  let reward = 0;
  let beatTree = false;
  let newPar = par;
  if (hopsUsed < par) {
    beatTree = true;
    newPar = hopsUsed;
    reward += BEAT_TREE_BOUNTY;
  } else if (hopsUsed === par && isFirst) {
    reward += OPTIMAL_BONUS;
  }
  if (isFirst) {
    reward += COMPLETION_REWARD;
  } else if (prevBest != null && hopsUsed < prevBest) {
    reward += REPLAY_IMPROVEMENT_PER_HOP * (prevBest - hopsUsed);
  }
  return { reward, beatTree, newPar };
}

// ---------------------------------------------------------------------------
// Share copy — the constellation framing.
// ---------------------------------------------------------------------------

const PICK_EMOJI = { gold: '🟨', robin: '🟦', black: '⬛' };

export function sharePicks(picks) {
  return (picks || []).map((p) => PICK_EMOJI[pickColor(p.kind)] || '⬛').join('');
}

export function dailyShareText({ date, handle, hopsUsed, par, streak, picks, beatTree = false }) {
  const row = sharePicks(picks);
  const lost = (picks || []).some((p) => p.kind === 'deadend');
  const line = beatTree
    ? `I BEAT THE TREE in ${hopsUsed} hops (par was ${par}).`
    : lost
      ? `I connected the constellation in ${hopsUsed} hops (par ${par}) — drifted into the void along the way.`
      : `I connected the constellation in ${hopsUsed} hops (par ${par}).`;
  return [
    `Six Degrees Daily Chain — ${date}`,
    line,
    row,
    `Streak ${streak} · ${handle || 'a rawker'}`,
    'sixdegreesofrock.com/game',
  ].join('\n');
}
