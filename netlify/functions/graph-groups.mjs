// GET /api/graph-groups — governor group tour: every disconnected group
// in the graph, WITHOUT downloading all nodes.
//
// Why this exists: the graph holds ~35,140 nodes in ~2,601 disconnected
// groups. The client needs to tour those groups ("Show next group") but
// must not download all 35,140 nodes to learn where the groups are. This
// endpoint returns one small entry per group — its anchor and its size —
// and the client then fetches only the group it actually visits (via the
// neighborhood view endpoint) instead of the corpus.
//
// Flow:
//   1. Cheap getDataVersion over GAME_TABLES (bands, band_members,
//      memberships — the tables that define connectivity; links cannot
//      connect or split a group, so they are excluded on purpose).
//   2. Serve the Blobs-cached groups payload keyed by that version
//      (prefix 'graph-groups', same blobKeyFor + 24h-meta freshness pattern
//      as serveCachedGraph) when present and fresh.
//   3. Otherwise get the node/edge data, preferring the api-bands Blobs
//      copy bands_neon.mjs already wrote (blobKeyFor('api-bands',
//      version) — the version key guarantees it matches this version, so
//      no meta check is needed for that read) and falling back to Neon
//      ids-only queries (bands+members+memberships, no bios/links —
//      exactly the columns connectivity needs).
//   4. Compute connected components with buildAdjacency /
//      getConnectedComponents imported from scripts/neighborhood-helpers.mjs
//      (precedent: og_image.mjs imports from the same path), then reduce
//      each component to ONLY { anchorId, nodeCount }.
//   5. Save the groups payload + meta back to Blobs best-effort.
//
// Anchor rule: the busiest node in the component (highest degree). Ties
// break by id ascending, so the same component always yields the same
// anchor regardless of input order. This is a deterministic refinement of
// sigma-explorer.mjs highestDegreeNode, which breaks ties by iteration
// order (first wins) — here the component ids are sorted ascending before
// the strict-greater comparison, which makes "first wins" mean "smallest
// id wins".
// Sort: nodeCount desc, then anchorId asc — a total order, so the list is
// byte-identical for the same input in any order (tests assert this).
//
// Response: { ok:true, version, totalNodes, groupCount,
//             groups: [{ anchorId, nodeCount }] }.
// Deliberately NOT the component node lists: a groups entry carries no
// member ids, no names, no edges. Orphan nodes (degree 0) are groups of
// one and appear as their own entry with themselves as anchor.
// Cache headers: public, 60s fresh like bands_neon; the Blobs version key
// is the staleness guard.
// Public, no auth — same trust level as /api/bands.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  methodNotAllowed,
  serverError,
} from './_db.mjs';
import {
  GAME_TABLES,
  getDataVersion,
  blobKeyFor,
  MAX_BLOB_AGE_MS,
  getGraphStore,
} from './_graph_cache.mjs';
import {
  buildAdjacency,
  getConnectedComponents,
} from '../../scripts/neighborhood-helpers.mjs';

export const GROUPS_BLOB_PREFIX = 'graph-groups';

// Same values as bands_neon.mjs BANDS_CACHE_CONTROL (local constant so
// this file does not import the whole bands endpoint).
export const GROUPS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=3600';

/**
 * Pure component summary. `nodes` need only { id }; `links` are
 * { source, target } band<->member edges (memberships mapped to that shape
 * by the callers — buildAdjacency reads source/target, not band_id/
 * member_id). Returns { totalNodes, groupCount, groups } where each group
 * is ONLY { anchorId, nodeCount } — no member lists, ever.
 */
export function buildGroupsSummary(nodes = [], links = []) {
  const adjacency = buildAdjacency(nodes, links);
  const components = getConnectedComponents(nodes, links, adjacency);
  const groups = components.map((ids) => {
    // Sorted ascending first, then strict `>` keeps the smallest id on a
    // degree tie — the deterministic version of highestDegreeNode.
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let anchorId = null;
    let bestDegree = -1;
    for (const id of sorted) {
      const degree = adjacency.get(id) ? adjacency.get(id).size : 0;
      if (degree > bestDegree) {
        anchorId = id;
        bestDegree = degree;
      }
    }
    return { anchorId, nodeCount: ids.length };
  });
  groups.sort((a, b) => {
    if (b.nodeCount !== a.nodeCount) return b.nodeCount - a.nodeCount;
    return a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0;
  });
  return { totalNodes: nodes.length, groupCount: groups.length, groups };
}

/**
 * Map an /api/bands payload ({ bands, members, memberships }) to a groups
 * summary. Only ids and membership endpoints are read; bios, links, and
 * every other column are ignored.
 */
export function groupsFromApiBandsPayload(payload = {}) {
  const bands = Array.isArray(payload.bands) ? payload.bands : [];
  const members = Array.isArray(payload.members) ? payload.members : [];
  const memberships = Array.isArray(payload.memberships) ? payload.memberships : [];
  const nodes = [
    ...bands.map((b) => ({ id: b.id })),
    ...members.map((m) => ({ id: m.id })),
  ];
  // buildAdjacency skips edges whose endpoints are not in `nodes`, so a
  // dangling membership row cannot crash the computation.
  const links = memberships.map((m) => ({ source: m.band_id, target: m.member_id }));
  return buildGroupsSummary(nodes, links);
}

/**
 * Neon fallback: ids only. No bios, no links — connectivity needs nothing
 * else.
 */
export async function buildGroupsFromNeon(sql) {
  const [bands, members, memberships] = await Promise.all([
    sql`select id from bands`,
    sql`select id from band_members`,
    sql`select band_id, member_id from memberships`,
  ]);
  return groupsFromApiBandsPayload({ bands, members, memberships });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': GROUPS_CACHE_CONTROL,
    },
  });
}

function metaKeyFor(prefix) {
  return `${prefix}-meta`;
}

/**
 * Testable handler: `req` is a Request (only .method is read); pass `sql`
 * and `store` in tests, omit them in production (the default export
 * supplies the real ones). A `store` of null means "no Blobs, Neon every
 * time"; undefined means "resolve the real graph-cache store".
 */
export async function handleGraphGroups(req, { sql, store } = {}) {
  if (req.method && req.method !== 'GET') return methodNotAllowed();

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
    version = await getDataVersion(sql, GAME_TABLES);
  } catch {
    version = null;
  }

  const key = version ? blobKeyFor(GROUPS_BLOB_PREFIX, version) : null;

  if (activeStore && key) {
    try {
      const [cached, metaRaw] = await Promise.all([
        activeStore.get(key, { type: 'json' }),
        activeStore.get(metaKeyFor(GROUPS_BLOB_PREFIX), { type: 'json' }),
      ]);
      const builtAt = metaRaw && typeof metaRaw.builtAt === 'number' ? metaRaw.builtAt : 0;
      const fresh = Date.now() - builtAt < MAX_BLOB_AGE_MS;
      if (cached && Array.isArray(cached.groups) && fresh) {
        return jsonResponse(200, cached);
      }
    } catch {
      // Any Blob read error -> rebuild below.
    }
  }

  // Prefer the api-bands Blobs copy bands_neon already wrote for this
  // version (keyed by the same version, so presence == freshness); fall
  // back to Neon ids-only queries when it is absent or unreadable.
  let summary = null;
  if (activeStore && version) {
    try {
      const apiBands = await activeStore.get(blobKeyFor('api-bands', version), { type: 'json' });
      if (apiBands && Array.isArray(apiBands.bands) && Array.isArray(apiBands.members)
        && Array.isArray(apiBands.memberships)) {
        summary = groupsFromApiBandsPayload(apiBands);
      }
    } catch {
      summary = null;
    }
  }
  if (!summary) {
    summary = await buildGroupsFromNeon(sql);
  }

  const body = { ok: true, version, ...summary };
  if (activeStore && key) {
    try {
      await Promise.all([
        activeStore.setJSON(key, body),
        activeStore.setJSON(metaKeyFor(GROUPS_BLOB_PREFIX), { version, builtAt: Date.now() }),
      ]);
    } catch {
      // Best effort only; the response is what matters.
    }
  }
  return jsonResponse(200, body);
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  try {
    return await handleGraphGroups(req, { sql });
  } catch (err) {
    console.error('graph-groups GET failed', err);
    return serverError('could not load groups', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/graph-groups', method: 'GET' };
