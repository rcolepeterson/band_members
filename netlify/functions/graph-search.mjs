// GET /api/graph-search?q=<text>&limit=<1..50, default 20> — governor
// search endpoint: NAMES ONLY.
//
// Why this exists: the governor must NOT download the full /api/bands
// corpus (~8 MB) to the phone just so the visitor can search. This endpoint
// answers "which nodes match this text?" with the smallest payload that can
// answer it: ids, display names, entity types, and locations. The client then
// fetches exactly one full card (graph-card.mjs) and exactly one
// neighborhood view for the node the visitor picks.
//
// What is deliberately NOT here: bio, links, memberships, popularity_score,
// genre, label, albums, years_active, created_at, added_by — none of those
// columns are selected, and searchNames() allowlist-maps every row to the
// six public fields, so even a cached payload carrying extra fields could
// not leak them into a response. Tests assert this on rows that DO carry
// those fields.
//
// Flow (mirrors _graph_cache.mjs, but the cached object is the names list,
// not a servable response, because each request filters + limits it):
//   1. Cheap getDataVersion over the two tables that feed the names list
//      (bands, band_members — memberships/links cannot change a name, so
//      they are NOT version inputs here; a membership edit alone does not
//      invalidate the names cache).
//   2. Serve the Blobs-cached names payload keyed by that version
//      (prefix 'graph-search-names', same blobKeyFor + 24h-meta freshness
//      pattern as serveCachedGraph) when present and fresh.
//   3. Otherwise build from Neon: one UNION ALL select of id, name, city,
//      state, country (+ a 'band'/'member' type literal) ordered by name,
//      then save the payload + meta back to Blobs best-effort.
//   4. Filter server-side, case-insensitively, by substring on name AND on
//      id (band ids for colliding names carry a city suffix and therefore
//      differ from the plain name — a query for the suffixed form must
//      still match), then clamp limit and slice.
//
// Cache headers: public, 60s fresh like bands_neon; the Blobs version key
// (not the CDN TTL) is the staleness guard, so a names edit surfaces as
// soon as the version changes.
// Public, no auth — same trust level as /api/bands.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  methodNotAllowed,
  serverError,
} from './_db.mjs';
import {
  getDataVersion,
  blobKeyFor,
  MAX_BLOB_AGE_MS,
  getGraphStore,
} from './_graph_cache.mjs';

// Tables whose changes invalidate the names payload. Memberships and links
// carry no names, so they are excluded on purpose: a membership edit alone
// must not force a names rebuild.
export const SEARCH_TABLES = ['bands', 'band_members'];
export const SEARCH_BLOB_PREFIX = 'graph-search-names';

// Same values as bands_neon.mjs BANDS_CACHE_CONTROL (kept as a local
// constant so this file does not import the whole bands endpoint).
export const SEARCH_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=3600';
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

// The ONLY fields a search result may carry. searchNames() maps through
// this list, so extra columns on a cached/Neon row can never leak out.
export const SEARCH_RESULT_FIELDS = ['id', 'name', 'type', 'city', 'state', 'country'];

/**
 * Clamp a raw `limit` query value into [1, 50]; anything missing or
 * non-numeric becomes the default 20.
 */
export function parseSearchLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * Pure search over a names payload: case-insensitive substring match on
 * name OR id, in payload order, capped at `limit`. Every result is
 * allowlist-mapped to SEARCH_RESULT_FIELDS — no bio, links, memberships,
 * popularity_score, genre, label, or albums, even if the input rows have
 * them.
 */
export function searchNames(entries = [], q = '', limit = DEFAULT_LIMIT) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const capped = parseSearchLimit(limit);
  const out = [];
  for (const row of entries) {
    if (out.length >= capped) break;
    const name = String(row?.name ?? '');
    const id = String(row?.id ?? '');
    if (!name.toLowerCase().includes(needle) && !id.toLowerCase().includes(needle)) continue;
    out.push({
      id,
      name,
      type: row?.type === 'member' ? 'member' : 'band',
      city: row?.city ?? null,
      state: row?.state ?? null,
      country: row?.country ?? null,
    });
  }
  return out;
}

/**
 * Build the full names payload from Neon. One UNION ALL: bands and members
 * share exactly the columns the response needs, plus a type literal.
 * Ordered by name (ties by type, then id, so the order is deterministic).
 */
export async function buildNamesPayload(sql) {
  const rows = await sql`
    select id, name, city, state, country, 'band' as type from bands
    union all
    select id, name, city, state, country, 'member' as type from band_members
    order by name, type, id
  `;
  return {
    version: null, // filled in by the caller, which owns the version query
    names: (rows || []).map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      city: row.city ?? null,
      state: row.state ?? null,
      country: row.country ?? null,
    })),
  };
}

function jsonResponse(status, body, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
    },
  });
}

function metaKeyFor(prefix) {
  return `${prefix}-meta`;
}

/**
 * Testable handler: `req` is a Request (only .url and .method are read);
 * pass `sql` and `store` in tests, omit them in production (the default
 * export supplies the real ones). A `store` of null means "no Blobs, Neon
 * every time"; undefined means "resolve the real graph-cache store".
 */
export async function handleGraphSearch(req, { sql, store } = {}) {
  if (req.method && req.method !== 'GET') return methodNotAllowed();

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  if (!q.trim()) {
    return jsonResponse(400, { ok: false, error: 'q is required' });
  }
  const limit = parseSearchLimit(url.searchParams.get('limit'));

  let activeStore = store;
  if (activeStore === undefined) {
    try {
      activeStore = getGraphStore();
    } catch {
      activeStore = null;
    }
  }

  // Cheap version query first; on failure fall through to Neon with a null
  // version (the response still answers, it just cannot be cached by key).
  let version = null;
  try {
    version = await getDataVersion(sql, SEARCH_TABLES);
  } catch {
    version = null;
  }

  const key = version ? blobKeyFor(SEARCH_BLOB_PREFIX, version) : null;
  let names = null;

  if (activeStore && key) {
    try {
      const [cached, metaRaw] = await Promise.all([
        activeStore.get(key, { type: 'json' }),
        activeStore.get(metaKeyFor(SEARCH_BLOB_PREFIX), { type: 'json' }),
      ]);
      const builtAt = metaRaw && typeof metaRaw.builtAt === 'number' ? metaRaw.builtAt : 0;
      const fresh = Date.now() - builtAt < MAX_BLOB_AGE_MS;
      if (cached && Array.isArray(cached.names) && fresh) {
        names = cached.names;
      }
    } catch {
      // Any Blob read error -> rebuild from Neon below.
    }
  }

  if (!names) {
    const payload = await buildNamesPayload(sql);
    payload.version = version;
    names = payload.names;
    if (activeStore && key) {
      try {
        await Promise.all([
          activeStore.setJSON(key, payload),
          activeStore.setJSON(metaKeyFor(SEARCH_BLOB_PREFIX), { version, builtAt: Date.now() }),
        ]);
      } catch {
        // Best effort only; the response is what matters.
      }
    }
  }

  return jsonResponse(200, {
    ok: true,
    version,
    results: searchNames(names, q, limit),
  }, SEARCH_CACHE_CONTROL);
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  try {
    return await handleGraphSearch(req, { sql });
  } catch (err) {
    console.error('graph-search GET failed', err);
    return serverError('could not search', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/graph-search', method: 'GET' };
