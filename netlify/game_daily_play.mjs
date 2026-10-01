// Daily Chain gameplay.
//
// POST /api/game-daily/play (auth) — body { action, ... }:
//   start   { date? }            — begin/resume today's run (or an unlocked archive day)
//   pick    { option_id }        — play a band from the current options
//   hint    { type, option_id? } — type 'eliminate' | 'reveal'; costs credits + hint budget
//   escape                       — dig out of the last dead end (5x hint cost)
//   status                       — credits, freezes, streak, completion dates
//
// The server is authoritative: option kinds stay hidden, picks are validated
// against the stored slate, and hops/streaks/credits mutate server-side.
// Helpers never solve — hints only narrow, never reveal the answer.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  notFound,
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
  pacificDate,
  validChainDate,
  buildBandAdj,
  bfsDist,
  optionsFor,
  pickColor,
  hintsFor,
  applyCompletion,
  currentStreak,
  dailyShareText,
  HINT_COST,
  ESCAPE_COST,
  ARCHIVE_COST,
  COMPLETION_REWARD,
  OPTIMAL_BONUS,
} from './_daily.mjs';
import { loadBandGraph } from './game_daily.mjs';

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

async function runState(sql, run, chain, me) {
  const { meta } = await loadBandGraph(sql);
  const cur = meta.get(run.current_band_id) || {};
  const tgt = meta.get(chain.band_b) || {};
  const comps = await sql`select chain_date from daily_completions where user_id = ${me.id}`;
  const dates = (comps || []).map((c) => c.chain_date);
  const fresh = await findUserByToken(sql, me.token).catch(() => me);
  return {
    id: run.id,
    chain_date: run.chain_date,
    status: run.status,
    current_band: { id: run.current_band_id, name: cur.name || 'Band' },
    target: { id: chain.band_b, name: tgt.name || 'Band' },
    start_band: { id: chain.band_a, name: (meta.get(chain.band_a) || {}).name || 'Band' },
    hops_used: run.hops_used,
    hints_used: run.hints_used,
    hints_total: hintsFor(chain.optimal_hops),
    par: chain.optimal_hops,
    picks: publicPicks(run.picks),
    credits: fresh.credits ?? 50,
    freeze_count: fresh.freeze_count ?? 0,
    streak: currentStreak(dates),
  };
}

async function dealOptions(sql, run, chain, excludeExtra = []) {
  const { adj, degree, meta } = await loadBandGraph(sql);
  const dist = bfsDist(adj, chain.band_b);
  const deadPicked = (run.picks || []).filter((p) => p.kind === 'deadend').map((p) => p.band_id);
  const dugOut = run.escaped || [];
  const opts = optionsFor({
    adj, dist, degree, meta,
    currentId: run.current_band_id,
    excludeIds: new Set([...deadPicked, ...dugOut, ...excludeExtra]),
    // The target is never a trap — reaching it always ends the run.
    // (It stays eligible as a neighbor pick at distance 1.)
    trapExcludeIds: new Set([chain.band_b]),
  });
  return opts.map((o) => ({ band_id: o.band_id, name: (meta.get(o.band_id) || {}).name || 'Band', kind: o.kind }));
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to play the daily chain');

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return badRequest('expected a JSON body');
  }
  const action = body && body.action;

  const budget = await consume({
    sql,
    bucket: `game-daily-play:uid:${me.id}`,
    limit: 300,
    windowSeconds: 3600,
  });
  if (!budget.allowed) {
    return tooManyRequests('Too many moves. Try again shortly.', budget.retryAfterSeconds);
  }

  // --- status ---------------------------------------------------------------
  if (action === 'status') {
    const comps = await sql`select chain_date from daily_completions where user_id = ${me.id} order by chain_date desc limit 60`;
    const dates = (comps || []).map((c) => c.chain_date);
    return ok({
      credits: me.credits ?? 50,
      freeze_count: me.freeze_count ?? 0,
      streak: currentStreak(dates),
      completed_dates: dates,
    });
  }

  // --- start ----------------------------------------------------------------
  if (action === 'start') {
    const date = validChainDate(body.date) || pacificDate();
    if (date > pacificDate()) return badRequest('that day hasn\u2019t happened yet');
    const chains = await sql`select date, band_a, band_b, optimal_hops from daily_chains where date = ${date} limit 1`;
    const chain = chains && chains[0];
    if (!chain) return notFound('no chain for that day');

    if (date !== pacificDate()) {
      const existing = await sql`select id from daily_runs where user_id = ${me.id} and chain_date = ${date} limit 1`;
      const unlocked = await sql`select chain_date from daily_unlocks where user_id = ${me.id} and chain_date = ${date} limit 1`;
      if ((!existing || !existing[0]) && (!unlocked || !unlocked[0])) {
        return forbidden('that day is locked', { archive_cost: ARCHIVE_COST, date });
      }
    }

    await ensureHandle(sql, me).catch(() => null);
    let runs = await sql`select * from daily_runs where user_id = ${me.id} and chain_date = ${date} limit 1`;
    let run = runs && runs[0];
    if (!run) {
      const created = await sql`
        insert into daily_runs (user_id, chain_date, current_band_id)
        values (${me.id}, ${date}, ${chain.band_a})
        on conflict (user_id, chain_date) do nothing
        returning *`;
      run = (created && created[0]) || (await sql`select * from daily_runs where user_id = ${me.id} and chain_date = ${date} limit 1`)[0];
    }
    if (!run) return serverError('could not start the run');
    if (!run.current_options || !run.current_options.length) {
      const opts = await dealOptions(sql, run, chain);
      const upd = await sql`update daily_runs set current_options = ${JSON.stringify(opts)}::jsonb where id = ${run.id} returning *`;
      run = upd[0];
    }
    return ok({ run: await runState(sql, run, chain, me), options: publicOptions(run.current_options) });
  }

  // --- helpers for in-run actions --------------------------------------------
  const getActiveRun = async () => {
    const date = validChainDate(body.date) || pacificDate();
    const chains = await sql`select date, band_a, band_b, optimal_hops from daily_chains where date = ${date} limit 1`;
    const chain = chains && chains[0];
    if (!chain) return { error: notFound('no chain for that day') };
    const runs = await sql`select * from daily_runs where user_id = ${me.id} and chain_date = ${date} limit 1`;
    const run = runs && runs[0];
    if (!run) return { error: badRequest('no run started for that day') };
    if (run.status !== 'active') return { error: badRequest('that run is over'), run, chain };
    return { run, chain };
  };

  // --- pick -------------------------------------------------------------------
  if (action === 'pick') {
    const { run, chain, error } = await getActiveRun();
    if (error) return error;
    const optionId = String(body.option_id || '');
    const slate = run.current_options || [];
    const chosen = slate.find((o) => String(o.band_id) === optionId);
    if (!chosen) return badRequest('that\u2019s not one of the options');

    const kind = chosen.kind;
    const picks = [...(run.picks || []), { band_id: chosen.band_id, name: chosen.name, kind }];
    const hopsUsed = run.hops_used + 1;
    let newCurrent = run.current_band_id;
    let completed = null;

    if (kind !== 'deadend') newCurrent = chosen.band_id;

    if (String(chosen.band_id) === String(chain.band_b)) {
      // Reached the target — score the run.
      const handle = await ensureHandle(sql, me).catch(() => null);
      const comps = await sql`select chain_date, via_freeze from daily_completions where user_id = ${me.id}`;
      const dates = (comps || []).map((c) => c.chain_date);
      const { streak, freezeUsed, frozenDate } = applyCompletion({
        dates,
        newDate: run.chain_date,
        freezeCount: me.freeze_count ?? 0,
      });
      const reward = COMPLETION_REWARD + (hopsUsed === chain.optimal_hops ? OPTIMAL_BONUS : 0);
      await sql`
        update daily_runs set status = 'complete', hops_used = ${hopsUsed},
               picks = ${JSON.stringify(picks)}::jsonb, current_options = '[]'::jsonb,
               completed_at = now()
         where id = ${run.id}`;
      await sql`
        insert into daily_completions (user_id, chain_date) values (${me.id}, ${run.chain_date})
        on conflict do nothing`;
      if (freezeUsed && frozenDate) {
        await sql`
          insert into daily_completions (user_id, chain_date, via_freeze)
          values (${me.id}, ${frozenDate}, true) on conflict do nothing`;
        await sql`update users set freeze_count = freeze_count - 1 where id = ${me.id} and freeze_count > 0`;
      }
      await sql`update users set credits = credits + ${reward} where id = ${me.id}`;
      const fresh = await findUserByToken(sql, me.token).catch(() => me);
      completed = {
        hops_used: hopsUsed,
        par: chain.optimal_hops,
        optimal: hopsUsed === chain.optimal_hops,
        streak,
        freeze_used: freezeUsed,
        credits_earned: reward,
        credits: fresh.credits ?? 50,
        picks: publicPicks(picks),
        share_text: dailyShareText({
          date: run.chain_date,
          handle: handle || me.handle,
          hopsUsed,
          par: chain.optimal_hops,
          streak,
          picks,
        }),
      };
      const doneRun = { ...run, status: 'complete', hops_used: hopsUsed, picks };
      return ok({ run: await runState(sql, doneRun, chain, { ...me, credits: fresh.credits }), completed });
    }

    // Mid-run: advance (or burn) and deal fresh options.
    const next = { ...run, current_band_id: newCurrent, hops_used: hopsUsed, picks };
    const opts = await dealOptions(sql, next, chain);
    const upd = await sql`
      update daily_runs set current_band_id = ${newCurrent}, hops_used = ${hopsUsed},
             picks = ${JSON.stringify(picks)}::jsonb,
             current_options = ${JSON.stringify(opts)}::jsonb
       where id = ${run.id} and status = 'active'
      returning *`;
    const saved = (upd && upd[0]) || next;
    return ok({
      run: await runState(sql, saved, chain, me),
      options: publicOptions(saved.current_options),
      picked: { kind, deadend: kind === 'deadend' },
    });
  }

  // --- hint -------------------------------------------------------------------
  if (action === 'hint') {
    const { run, chain, error } = await getActiveRun();
    if (error) return error;
    const total = hintsFor(chain.optimal_hops);
    if (run.hints_used >= total) return badRequest('no hints left today');
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
    if (credits === null) return forbidden('not enough credits', { hint_cost: HINT_COST });
    const upd = await sql`
      update daily_runs set hints_used = hints_used + 1,
             current_options = ${JSON.stringify(slate)}::jsonb
       where id = ${run.id} and status = 'active'
      returning *`;
    const saved = (upd && upd[0]) || run;
    return ok({
      run: await runState(sql, saved, chain, { ...me, credits }),
      options: publicOptions(saved.current_options),
      hint: { type, hints_used: saved.hints_used, hints_total: total, ...payload },
    });
  }

  // --- escape -------------------------------------------------------------------
  if (action === 'escape') {
    const { run, chain, error } = await getActiveRun();
    if (error) return error;
    const picks = [...(run.picks || [])];
    const last = picks[picks.length - 1];
    const escaped = run.escaped || [];
    if (!last || last.kind !== 'deadend' || escaped.includes(String(last.band_id))) {
      return badRequest('nothing to dig out of');
    }
    const credits = await spendCredits(sql, me.id, ESCAPE_COST);
    if (credits === null) return forbidden('not enough credits', { escape_cost: ESCAPE_COST });
    picks.pop();
    const upd = await sql`
      update daily_runs set picks = ${JSON.stringify(picks)}::jsonb,
             hops_used = hops_used - 1,
             escaped = ${JSON.stringify([...escaped, String(last.band_id)])}::jsonb
       where id = ${run.id} and status = 'active'
      returning *`;
    const saved = (upd && upd[0]) || run;
    return ok({
      run: await runState(sql, saved, chain, { ...me, credits }),
      options: publicOptions(saved.current_options),
      escaped: { band_id: last.band_id, name: last.name },
    });
  }

  return badRequest('unknown action');
};

export const config = { path: '/api/game-daily/play' };
