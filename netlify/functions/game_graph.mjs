// GET /api/game-graph — the band graph the game plays on, cached at the CDN.
//
// Why (2026-10-10): the project hit Neon's monthly transfer limit. Each game
// function (daily, practice, results) kept its own copy of this graph and
// re-read ~3 MB from Neon whenever a fresh instance started, which on a
// quiet site is most visits. Now those functions fetch this endpoint instead
// (see loadBandGraph in game_daily.mjs), so Netlify's CDN serves the graph
// and Neon is read for it about once an hour, however many instances start.
//
// Public data (band and musician names, who played in what), the same facts
// /api/bands already serves. Memberships go as [band_id, member_id] pairs to
// keep it small.

import { getSql, isDbConfigured } from './_db.mjs';
import { readGameGraphRows } from './game_daily.mjs';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!isDbConfigured()) {
    return Response.json({ ok: false, error: 'database not configured' }, { status: 503 });
  }
  try {
    const { memberships, bands, members, excluded } = await readGameGraphRows(getSql());
    return new Response(JSON.stringify({
      ok: true,
      memberships: memberships.map((m) => [m.band_id, m.member_id]),
      bands,
      members,
      excluded: [...excluded],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'netlify-cdn-cache-control': 'public, max-age=3600, stale-while-revalidate=3600, durable',
      },
    });
  } catch (err) {
    console.error('game_graph failed', err && err.message);
    return Response.json({ ok: false, error: 'could not load the game graph' }, { status: 500 });
  }
};

export const config = { path: '/api/game-graph' };
