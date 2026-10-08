// Solo Run gameplay (v2 — a real game, not a reveal).
//
// POST /api/game-solo/play (auth) — body { action, ... }:
//   start   { band_a?, fresh? }  — begin a solo run (or resume the active one);
//                                 band_a = UUID of the player's chosen start band;
//                                 omit it and the tree deals both bands.
//                                 fresh:true abandons any active run and deals new.
//   pick    { option_id }        — play a band from the current options
//   hint    { type, option_id? } — type 'eliminate' | 'reveal'; costs credits + hint budget
//   escape                       — dig out of the last dead end (5x hint cost)
//   giveup                       — "Show me the chain": tree reveals the par path, run over
//
// The server is authoritative: option kinds stay hidden, picks are validated
// against the stored slate, and hops/credits mutate server-side.
// Helpers never solve — hints only narrow, never reveal the answer.
//
// Free to start (no entry cost). Hints and blackhole escapes cost credits;
// when the player is broke the 403 names the price and the client points at
// credit packs (stubbed until Google Play Billing lands).

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  forbidden,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { ensureHandle } from './me_handle.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import {
  bfsDist,
  optionsFor,
  pickColor,
  hintsFor,
  scoreRun,
  bfsPath,
  HINT_COST,
  ESCAPE_COST,
  COMPLETION_REWARD,
  OPTIMAL_BONUS,
} from './_daily.mjs';
import { loadBandGraph } from './game_daily.mjs';

const SOLO_MIN_HOPS = 3;
const SOLO_MAX_HOPS = 5;
const SOLO_PAIR_TRIES = 80;

// Deal a fair solo pair: band_b is reachable from band_a in 3–5 hops.
// When the player picks band_a we honor it; otherwise the tree deals both.
// Exported for tests.
export function pickSoloPair({ adj, bandIds, bandA }) {
  const ids = bandIds && bandIds.length ? bandIds : [...adj.keys()];
  if (!ids.length) return null;
  for (let t = 0; t < SOLO_PAIR_TRIES; t++) {
    const a = bandA && adj.has(bandA) ? bandA : ids[(Math.random() * ids.length) | 0];
    const dist = bfsDist(adj, a);
    const cands = [];
    for (const id of ids) {
      if (id === a) continue;
      const d = dist.get(id);
      if (d !== undefined && d >= SOLO_MIN_HOPS && d <= SOLO_MAX_HOPS) cands.push({ id, d });
    }
    if (!cands.length) continue;
    const { id, d } = cands[(Math.random() * cands.length) | 0];
    return { band_a: a, band_b: id, optimal_hops: d };
  }
  return null;
}

async function spendCredits(sql, userId, amount) {
  const rows = await sql`
    update users set credits = credits - ${amount}
     where id = ${userId} and credits >= ${amount}
    returning credits`;
  return rows && rows[0] ? rows[0].credits : null;
}

function publicOptions(stored) {
  return (stored || []).map((o) => ({ id: o.band_id, name: o.name }));
}

function publicPicks(picks) {
  return (picks || []).map((p) => ({
    band_id: p.band_id,
    name: p.name,
    kind: p.kind,
    color: pickColor(p.kind),
  }));
}

async function runState(sql, run, me) {
  const { adj, meta } = await loadBandGraph(sql);
  const cur = meta.get(run.current_band_id) || {};
  const tgt = meta.get(run.band_b) || {};
  const fresh = await findUserByToken(sql, me.token).catch(() => me);
  // After a give-up the tree's answer is recomputed live — no stored copy.
  let reveal_path = null;
  if (run.status === 'given_up') {
    const ids = bfsPath(adj, run.band_a, run.band_b) || [];
    reveal_path = ids.map((id) => ({ id, name: (meta.get(id) || {}).name || 'Band' }));
  }
  // Bail-out: if the last hop died and a session legend is in the room (a
  // member of the band you're stuck at), the escape wears his name. Freese
  // first — it's his joke — Aronoff as backup. Same price, same effect.
  let bailout = null;
  const lastPick = (run.picks || [])[(run.picks || []).length - 1];
  if (run.status === 'active' && lastPick && lastPick.kind === 'deadend') {
    try {
      const rows = await sql`
        select bm.name from memberships ms
        join band_members bm on bm.id = ms.member_id
        where ms.band_id = ${run.current_band_id}
          and ms.relation = 'member_of'
          and bm.name in ('Josh Freese', 'Kenny Aronoff')
        order by case when bm.name = 'Josh Freese' then 0 else 1 end
        limit 1`;
      if (rows && rows[0]) bailout = rows[0].name;
    } catch {
      // The plain dig-out stands.
    }
  }
  return {
    id: run.id,
    status: run.status,
    bailout,
    reveal_path,
    current_band: { id: run.current_band_id, name: cur.name || 'Band' },
    target: { id: run.band_b, name: tgt.name || 'Band' },
    start_band: { id: run.band_a, name: (meta.get(run.band_a) || {}).name || 'Band' },
    hops_used: run.hops_used,
    hints_used: run.hints_used,
    hints_total: hintsFor(run.optimal_hops),
    par: run.optimal_hops,
    picks: publicPicks(run.picks),
    credits: fresh.credits ?? 50,
  };
}

async function dealOptions(sql, run) {
  const { adj, degree, meta } = await loadBandGraph(sql);
  const dist = bfsDist(adj, run.band_b);
  const deadPicked = (run.picks || []).filter((p) => p.kind === 'deadend').map((p) => p.band_id);
  const dugOut = run.escaped || [];
  const opts = optionsFor({
    adj, dist, degree, meta,
    currentId: run.current_band_id,
    // Target excluded from options — auto-finish completes the chain when
    // adjacent (Aaron, 2026-10-07: no need to tap the final band).
    excludeIds: new Set([...deadPicked, ...dugOut, run.band_b]),
    trapExcludeIds: new Set([run.band_b]),
  });
  return opts.map((o) => ({ band_id: o.band_id, name: (meta.get(o.band_id) || {}).name || 'Band', kind: o.kind }));
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to play solo');

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return badRequest('expected a JSON body');
  }
  const action = body && body.action;

  const budget = await consume({
    sql,
    bucket: `game-solo-play:uid:${me.id}`,
    limit: 300,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many moves. Try again shortly.', budget.retryAfterSeconds);
  }

  const getActiveRun = async () => {
    const runs = await sql`select * from solo_runs where user_id = ${me.id} and status = 'active' order by created_at desc limit 1`;
    return (runs && runs[0]) || null;
  };

  // --- start ----------------------------------------------------------------
  // Resume the active run, or deal a fresh pair. fresh:true (the "New
  // matchup" button) abandons the current run first — no penalty, it's practice.
  if (action === 'start') {
    await ensureHandle(sql, me).catch(() => null);
    if (body.fresh === true) {
      await sql`update solo_runs set status = 'abandoned', completed_at = now()
                 where user_id = ${me.id} and status = 'active'`;
    } else {
      const active = await getActiveRun();
      if (active) {
        if (!active.current_options || !active.current_options.length) {
          const opts = await dealOptions(sql, active);
          const upd = await sql`update solo_runs set current_options = ${JSON.stringify(opts)}::jsonb where id = ${active.id} returning *`;
          return ok({ run: await runState(sql, upd[0], me), options: publicOptions(upd[0].current_options), resumed: true });
        }
        return ok({ run: await runState(sql, active, me), options: publicOptions(active.current_options), resumed: true });
      }
    }
    const { adj, bandIds } = await loadBandGraph(sql);
    let bandA = null;
    if (body.band_a) {
      const check = await sql`select id from bands where id = ${String(body.band_a)} limit 1`;
      if (!check || !check[0]) return badRequest('unknown band');
      bandA = check[0].id;
    }
    const pair = pickSoloPair({ adj, bandIds, bandA });
    if (!pair) return serverError('could not deal a pair — the tree is too small here');
    const created = await sql`
      insert into solo_runs (user_id, band_a, band_b, optimal_hops, current_band_id)
      values (${me.id}, ${pair.band_a}, ${pair.band_b}, ${pair.optimal_hops}, ${pair.band_a})
      returning *`;
    const run = created && created[0];
    if (!run) return serverError('could not start the run');
    const opts = await dealOptions(sql, run);
    const upd = await sql`update solo_runs set current_options = ${JSON.stringify(opts)}::jsonb where id = ${run.id} returning *`;
    return ok({ run: await runState(sql, upd[0], me), options: publicOptions(upd[0].current_options) });
  }

  // --- helpers for in-run actions --------------------------------------------
  const needActive = async () => {
    const run = await getActiveRun();
    if (!run) return { error: badRequest('no solo run in progress — start one first') };
    return { run };
  };

  // --- pick -------------------------------------------------------------------
  if (action === 'pick') {
    const { run, error } = await needActive();
    if (error) return error;
    const optionId = String(body.option_id || '');
    const slate = run.current_options || [];
    const chosen = slate.find((o) => String(o.band_id) === optionId);
    if (!chosen) return badRequest('that\u2019s not one of the options');

    const kind = chosen.kind;
    const picks = [...(run.picks || []), { band_id: chosen.band_id, name: chosen.name, kind }];
    const hopsUsed = run.hops_used + 1;
    let newCurrent = run.current_band_id;
    if (kind !== 'deadend') newCurrent = chosen.band_id;

    if (String(chosen.band_id) === String(run.band_b)) {
      // Reached the target — score the run. Solo economy: finish + par bonus.
      const { reward } = scoreRun({ isFirst: true, hopsUsed, par: run.optimal_hops, prevBest: null });
      await sql`
        update solo_runs set status = 'complete', hops_used = ${hopsUsed},
               picks = ${JSON.stringify(picks)}::jsonb, current_options = '[]'::jsonb,
               completed_at = now()
         where id = ${run.id}`;
      if (reward > 0) {
        await sql`update users set credits = credits + ${reward} where id = ${me.id}`;
      }
      const fresh = await findUserByToken(sql, me.token).catch(() => me);
      const doneRun = { ...run, status: 'complete', hops_used: hopsUsed, picks };
      return ok({
        run: await runState(sql, doneRun, { ...me, credits: fresh.credits }),
        completed: {
          hops_used: hopsUsed,
          par: run.optimal_hops,
          optimal: hopsUsed === run.optimal_hops,
          credits_earned: reward,
          credits: fresh.credits ?? 50,
          picks: publicPicks(picks),
        },
      });
    }

    // Mid-run: advance (or burn) and deal fresh options.
    // Auto-finish (Aaron, 2026-10-07): if the new position is adjacent to
    // the target, the chain completes itself — no need to tap the target.
    const { adj: adjCheck } = await loadBandGraph(sql);
    const neighbors = adjCheck.get(newCurrent) || new Set();
    if (neighbors.has(run.band_b) && String(newCurrent) !== String(run.band_b)) {
      const targetName = (await loadBandGraph(sql).then(({ meta }) => meta.get(run.band_b) || {}).catch(() => ({}))).name || 'Target';
      const finalPicks = [...picks, { band_id: run.band_b, name: targetName, kind: 'optimal' }];
      const finalHops = hopsUsed + 1;
      const { reward } = scoreRun({ isFirst: true, hopsUsed: finalHops, par: run.optimal_hops, prevBest: null });
      await sql`
        update solo_runs set status = 'complete', hops_used = ${finalHops},
               picks = ${JSON.stringify(finalPicks)}::jsonb, current_options = '[]'::jsonb,
               completed_at = now()
         where id = ${run.id}`;
      if (reward > 0) {
        await sql`update users set credits = credits + ${reward} where id = ${me.id}`;
      }
      const fresh = await findUserByToken(sql, me.token).catch(() => me);
      const doneRun = { ...run, status: 'complete', hops_used: finalHops, picks: finalPicks };
      return ok({
        run: await runState(sql, doneRun, { ...me, credits: fresh.credits }),
        completed: {
          hops_used: finalHops,
          par: run.optimal_hops,
          optimal: finalHops === run.optimal_hops,
          credits_earned: reward,
          credits: fresh.credits ?? 50,
          picks: publicPicks(finalPicks),
          auto_finished: true,
        },
      });
    }

    const next = { ...run, current_band_id: newCurrent, hops_used: hopsUsed, picks };
    const opts = await dealOptions(sql, next);
    const upd = await sql`
      update solo_runs set current_band_id = ${newCurrent}, hops_used = ${hopsUsed},
             picks = ${JSON.stringify(picks)}::jsonb,
             current_options = ${JSON.stringify(opts)}::jsonb
       where id = ${run.id} and status = 'active'
      returning *`;
    const saved = (upd && upd[0]) || next;
    return ok({
      run: await runState(sql, saved, me),
      options: publicOptions(saved.current_options),
      picked: { kind, deadend: kind === 'deadend' },
    });
  }

  // --- hint -------------------------------------------------------------------
  if (action === 'hint') {
    const { run, error } = await needActive();
    if (error) return error;
    const total = hintsFor(run.optimal_hops);
    if (run.hints_used >= total) return badRequest('no hints left this run');
    const type = body.type === 'reveal' ? 'reveal' : 'eliminate';
    const slate = [...(run.current_options || [])];
    if (!slate.length) return badRequest('no options to hint on');

    let payload = {};
    if (type === 'eliminate') {
      // Never eliminate the optimal pick; prefer burning a trap.
      const order = { deadend: 0, obscure: 1, solid: 2, optimal: 3 };
      const victim = [...slate].sort((a, b) => order[a.kind] - order[b.kind])[0];
      if (!victim || victim.kind === 'optimal') return badRequest('nothing to eliminate');
      payload = { eliminated: { id: victim.band_id, name: victim.name } };
      slate.splice(slate.findIndex((o) => String(o.band_id) === String(victim.band_id)), 1);
    } else {
      const optionId = String(body.option_id || '');
      const target = slate.find((o) => String(o.band_id) === optionId);
      if (!target) return badRequest('that\u2019s not one of the options');
      payload = { option: { id: target.band_id, name: target.name }, on_optimal_path: target.kind === 'optimal' };
    }

    const credits = await spendCredits(sql, me.id, HINT_COST);
    if (credits === null) {
      return forbidden('not enough credits for a hint — credit packs are coming soon', { hint_cost: HINT_COST });
    }
    const upd = await sql`
      update solo_runs set hints_used = hints_used + 1,
             current_options = ${JSON.stringify(slate)}::jsonb
       where id = ${run.id} and status = 'active'
      returning *`;
    const saved = (upd && upd[0]) || run;
    return ok({
      run: await runState(sql, saved, { ...me, credits }),
      options: publicOptions(saved.current_options),
      hint: { type, hints_used: saved.hints_used, hints_total: total, ...payload },
    });
  }

  // --- escape -------------------------------------------------------------------
  // Dug out of a black hole. Costs 5x a hint; when the player is broke the
  // 403 names the price and the client points at credit packs (coming soon).
  if (action === 'escape') {
    const { run, error } = await needActive();
    if (error) return error;
    const picks = [...(run.picks || [])];
    const last = picks[picks.length - 1];
    const escaped = run.escaped || [];
    if (!last || last.kind !== 'deadend' || escaped.includes(String(last.band_id))) {
      return badRequest('nothing to dig out of');
    }
    const credits = await spendCredits(sql, me.id, ESCAPE_COST);
    if (credits === null) {
      return forbidden('not enough credits to dig out — credit packs are coming soon', { escape_cost: ESCAPE_COST });
    }
    picks.pop();
    const upd = await sql`
      update solo_runs set picks = ${JSON.stringify(picks)}::jsonb,
             hops_used = hops_used - 1,
             escaped = ${JSON.stringify([...escaped, String(last.band_id)])}::jsonb
       where id = ${run.id} and status = 'active'
      returning *`;
    const saved = (upd && upd[0]) || run;
    return ok({
      run: await runState(sql, saved, { ...me, credits }),
      options: publicOptions(saved.current_options),
      escaped: { band_id: last.band_id, name: last.name },
    });
  }

  // --- giveup ---------------------------------------------------------------
  // "Show me the chain." The tree reveals the par path and the run is done:
  // no credits — but the loss is on the record.
  // The reveal is recomputed live, so nothing needs storing.
  if (action === 'giveup') {
    const { run, error } = await needActive();
    if (error) return error;
    const { adj, meta } = await loadBandGraph(sql);
    const ids = bfsPath(adj, run.band_a, run.band_b) || [];
    const path = ids.map((id) => ({ id, name: (meta.get(id) || {}).name || 'Band' }));
    await sql`
      update solo_runs set status = 'given_up', picks = ${JSON.stringify(run.picks || [])}::jsonb,
             current_options = '[]'::jsonb, completed_at = now()
       where id = ${run.id} and status = 'active'`;
    const doneRun = { ...run, status: 'given_up' };
    return ok({
      run: await runState(sql, doneRun, me),
      gave_up: {
        hops_deep: run.hops_used,
        par: run.optimal_hops,
        path,
      },
    });
  }

  return badRequest('unknown action');
};

export const config = { path: '/api/game-solo/play' };
