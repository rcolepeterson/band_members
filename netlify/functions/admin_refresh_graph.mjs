// POST /api/admin/refresh-graph — force-rebuild the Blobs saved copies for
// /api/bands and /api/game-graph, bypassing the version check.
//
// Admin-only: requires the ADMIN_TOKEN env var as the x-admin-token header
// (same pattern as admin_user_lookup.mjs). Use after a bulk import or when
// the cached copy looks stale; normal edits invalidate the cache on their
// own via the updated_at version check.
//
// HOT VIEW WARMING (governor v1): after the rebuilds, the background worker
// is triggered for each HOT_ANCHORS anchor at hops 2 and 3, so the worst
// (super-connector) views are warm before anyone taps Expand. Warming is
// BEST-EFFORT: trigger failures are counted in the response (hotViews.failed)
// and never fail the whole refresh — the lazy path still covers any view the
// warming missed, because a cache miss on GET /api/graph-view returns 202
// {status:'computing'} and triggers the same worker on demand.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  serverError,
  unauthorized,
  methodNotAllowed,
} from './_db.mjs';
import { readGameGraphRows } from './game_daily.mjs';
import {
  BANDS_TABLES,
  GAME_TABLES,
  MAX_BLOB_AGE_MS,
  blobKeyFor,
  getDataVersion,
  getGraphStore,
} from './_graph_cache.mjs';
import { triggerBackgroundCompute } from './_graph_view.mjs';

// Hot anchors: the famous / super-connector views precomputed on each
// refresh so the worst views are warm before anyone taps Expand.
export const HOT_ANCHORS = ['Matt Cameron', 'Josh Freese', 'Pearl Jam'];
export const HOT_HOPS = [2, 3];

// Trigger the background worker for every hot anchor x hot hop. Best-effort:
// returns {triggered, failed} and never throws, so a failed trigger can
// never fail the refresh it rides along with. `triggerFn` is injectable for
// tests; it defaults to triggerBackgroundCompute.
export async function warmHotViews({ origin, version, triggerFn = null }) {
  const trigger = triggerFn || (({ params }) =>
    triggerBackgroundCompute({ origin, params, version }));
  let triggered = 0;
  let failed = 0;
  for (const anchor of HOT_ANCHORS) {
    for (const hops of HOT_HOPS) {
      let ok = false;
      try {
        ok = await trigger({ params: { anchor, hops } });
      } catch {
        ok = false;
      }
      if (ok) triggered += 1;
      else failed += 1;
    }
  }
  return { triggered, failed };
}

const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

async function rebuildBands(sql, store) {
  const [bands, members, memberships, band_links] = await Promise.all([
    sql`
      select id, name, city, state, country, genre, years_active, label, albums, bio, csv_origin, created_at,
             added_by
      from bands
      order by name
    `,
    sql`
      select id, name, city, state, country, instrument1, instrument2, years_active, bio,
             coalesce(popularity_score, 0) as popularity_score
      from band_members
      order by name
    `,
    sql`
      select id, band_id, member_id, tenure, weight, relation
      from memberships
    `,
    sql`
      select band_id, platform, url
      from band_links
    `,
  ]);
  const payload = { ok: true, bands, members, memberships, band_links };
  const version = await getDataVersion(sql, BANDS_TABLES);
  const key = blobKeyFor('api-bands', version);
  await store.setJSON(key, payload);
  await store.setJSON('api-bands-meta', { version, builtAt: Date.now() });
  return { key, rows: bands.length + members.length + memberships.length + band_links.length };
}

async function rebuildGameGraph(sql, store) {
  const { memberships, bands, members, excluded } = await readGameGraphRows(sql);
  const payload = {
    ok: true,
    memberships: memberships.map((m) => [m.band_id, m.member_id]),
    bands,
    members,
    excluded: [...excluded],
  };
  const version = await getDataVersion(sql, GAME_TABLES);
  const key = blobKeyFor('api-game-graph', version);
  await store.setJSON(key, payload);
  await store.setJSON('api-game-graph-meta', { version, builtAt: Date.now() });
  return { key, rows: bands.length + members.length + memberships.length };
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  let store;
  try {
    store = getGraphStore();
  } catch (err) {
    return serverError('blobs unavailable', { message: String(err && err.message || err) });
  }

  try {
    const [bands, game] = await Promise.all([
      rebuildBands(sql, store),
      rebuildGameGraph(sql, store),
    ]);
    // Hot-view warming is best-effort and never fails the refresh: any
    // trigger failure is counted, and the lazy 202 path covers the view.
    let hotViews = { triggered: 0, failed: 0 };
    try {
      const version = await getDataVersion(sql, BANDS_TABLES);
      hotViews = await warmHotViews({
        origin: new URL(req.url).origin,
        version,
      });
    } catch (err) {
      console.error('admin_refresh_graph hot warming failed', err);
    }
    return Response.json({
      ok: true,
      rebuilt: { bands, game },
      hotViews: { ...hotViews, anchors: HOT_ANCHORS, hops: HOT_HOPS },
      maxBlobAgeMs: MAX_BLOB_AGE_MS,
    });
  } catch (err) {
    console.error('admin_refresh_graph failed', err);
    return serverError('refresh failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/admin/refresh-graph', method: 'POST' };
