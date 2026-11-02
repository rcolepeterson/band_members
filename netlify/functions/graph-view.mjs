// GET /api/graph-view?anchor=&hops=&maxNodes=&satelliteCap=[&minSeparation=]
//
// Server-side neighborhood view (governor v1): returns the nodes, links and
// positions for ONE view around an anchor, so the client can render without
// laying out the whole corpus. The response NEVER contains the full corpus,
// bios, or band_links — only the view's nodes/links/positions (plus depths,
// frontier, truncated, totalNodes).
//
// Flow: cheap getDataVersion -> cacheKey -> Blobs `graph-cache` read. HIT
// returns immediately. MISS loads the api-bands payload (Blobs copy if
// present, else Neon), selects the neighborhood WITHOUT laying it out, and
// applies the GIANT RULE: a polygon view (hops <= 3) with >100 nodes is
// never laid out synchronously (a giant layout can take ~180s vs the 10s/26s
// sync timeout) — instead the background worker is triggered (best-effort)
// and the endpoint returns 202 {status:'computing'}; the governor client
// shows its retry state for that view. Hops 4-6 use radialLayout (no refine
// phase) and are laid out synchronously. Small views are laid out
// synchronously, the finished view is stored in Blobs under the cache key
// (best-effort; a failed store write never fails the response), and returned.
//
// Status codes: 200 view (fromCache true/false), 202 computing (giant view,
// worker triggered or trigger attempted), 400 bad params, 404 unknown
// anchor, 405 non-GET, 503 DB unconfigured, 500 version/payload failure.
// In governor mode there is no local corpus to fall back to, so the client
// degrades to a retry state, never a broken graph and never a silent
// full-corpus fetch.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  badRequest,
  notFound,
  json,
} from './_db.mjs';
import {
  BANDS_TABLES,
  blobKeyFor,
  getDataVersion,
  getGraphStore,
} from './_graph_cache.mjs';
import {
  normalizeViewParams,
  cacheKeyFor,
  buildViewNodes,
  layoutView,
  loadApiBandsPayload,
  isGiantView,
  triggerBackgroundCompute,
} from './_graph_view.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  let params;
  try {
    const query = new URL(req.url).searchParams;
    params = normalizeViewParams({
      anchor: query.get('anchor'),
      hops: query.get('hops'),
      maxNodes: query.get('maxNodes'),
      satelliteCap: query.get('satelliteCap'),
      minSeparation: query.get('minSeparation'),
    });
  } catch (err) {
    return badRequest(err && err.message ? String(err.message) : 'invalid params');
  }

  const sql = getSql();
  let version;
  try {
    version = await getDataVersion(sql, BANDS_TABLES);
  } catch (err) {
    console.error('graph-view version check failed', err);
    return serverError('could not determine data version');
  }

  let store = null;
  try {
    store = getGraphStore();
  } catch {
    store = null; // Blobs unavailable -> compute without caching
  }

  const key = cacheKeyFor(version, params);
  if (store) {
    try {
      const cached = await store.get(key, { type: 'json' });
      if (cached && Array.isArray(cached.nodes)) {
        const { version: _storedVersion, ...view } = cached;
        return json(200, { ok: true, fromCache: true, version, ...view });
      }
    } catch {
      // Blob read error -> fall through to compute.
    }
  }

  let payload;
  try {
    payload = await loadApiBandsPayload({
      sql,
      store,
      bandsKey: blobKeyFor('api-bands', version),
    });
  } catch (err) {
    console.error('graph-view payload load failed', err);
    return serverError('could not load bands');
  }

  const selected = buildViewNodes(payload, params);
  if (!selected.nodes.length) return notFound('unknown anchor');

  // GIANT RULE (see _graph_view.mjs): never lay a polygon giant view out here.
  if (isGiantView({ nodeCount: selected.nodes.length, hops: params.hops })) {
    await triggerBackgroundCompute({
      origin: new URL(req.url).origin,
      params,
      version,
    });
    return json(202, {
      ok: false,
      status: 'computing',
      anchor: selected.anchorId,
      hops: params.hops,
      version,
    });
  }

  const view = layoutView(selected, params);
  if (store) {
    try {
      await store.setJSON(key, { ...view, version });
    } catch {
      // Best-effort only; the response is what matters.
    }
  }
  return json(200, { ok: true, fromCache: false, version, ...view });
};

export const config = { path: '/api/graph-view', method: 'GET' };
