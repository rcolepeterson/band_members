// Background worker for server-side graph views (governor v1).
//
// Netlify background function: the filename ends in `-background` and there
// is deliberately NO `config.path` export, so Netlify serves it at
// /.netlify/functions/graph-view-background and runs it outside the sync
// timeout (15-minute limit — comfortably fits the ~180s giant layout that
// the sync endpoint must never attempt). It is triggered fire-and-forget by
// graph-view.mjs (giant-view 202s) and admin_refresh_graph.mjs (hot-list
// warming); the trigger POST returns as soon as Netlify accepts the job.
//
// HTTP contract: POST with a JSON body {anchor, hops, maxNodes,
// satelliteCap, hubSatelliteCap, hubGroup, minSeparation, version}.
// (normalizeViewParams supplies the hub defaults, so older triggers that
// omit them still compute the hub-cap-10 view.) The worker loads the api-bands
// payload the same way graph-view.mjs does (Blobs copy if present, else
// Neon), computes the FULL view (including giant layouts — that is the
// point of this worker), and writes it to Blobs under cacheKeyFor(version,
// params), where the sync endpoint will serve it on the next request.
// Returns {ok:true} after the write. It never changes solver output: the
// layout functions are imported unchanged from scripts/.
//
// The pure compute step is exported as computeGraphView(payload, params)
// (defined in _graph_view.mjs) so tests can exercise it without HTTP, Blobs
// or Neon.

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
  computeGraphView,
  loadApiBandsPayload,
} from './_graph_view.mjs';

export { computeGraphView };

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('invalid JSON body');
  }
  let params;
  try {
    params = normalizeViewParams(body || {});
  } catch (err) {
    return badRequest(err && err.message ? String(err.message) : 'invalid params');
  }

  const sql = getSql();
  let version = body && body.version ? String(body.version) : null;
  if (!version) {
    try {
      version = await getDataVersion(sql, BANDS_TABLES);
    } catch (err) {
      console.error('graph-view-background version check failed', err);
      return serverError('could not determine data version');
    }
  }

  let store;
  try {
    store = getGraphStore();
  } catch (err) {
    return serverError('blobs unavailable', { message: String(err && err.message || err) });
  }

  let payload;
  try {
    payload = await loadApiBandsPayload({
      sql,
      store,
      bandsKey: blobKeyFor('api-bands', version),
    });
  } catch (err) {
    console.error('graph-view-background payload load failed', err);
    return serverError('could not load bands');
  }

  const view = computeGraphView(payload, params);
  if (!view.nodes.length) return notFound('unknown anchor');

  try {
    await store.setJSON(cacheKeyFor(version, params), { ...view, version });
  } catch (err) {
    console.error('graph-view-background cache write failed', err);
    return serverError('could not store view');
  }
  return json(200, { ok: true, anchor: view.anchor, hops: view.hops, version });
};
