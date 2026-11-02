// Server-side graph views (governor v1) — shared logic for
// graph-view.mjs (sync endpoint) and graph-view-background.mjs (worker).
//
// PURPOSE: compute one neighborhood view (nodes + links + positions) on the
// server from the /api/bands payload, so the phone downloads just that view
// instead of laying out the whole corpus. The layout code is NOT reimplemented
// here: polygonLayout / radialLayout / getNeighborhood / roleForNode /
// classifyNode are imported unchanged from scripts/, exactly as the client
// uses them (scripts/sigma-explorer.mjs renderNeighborhood). NO solver code
// is changed by this file, and 1-2 degree output is byte-identical to local
// compute because it IS local compute, run on the server.
//
// DEPENDENCY RULE: this module must stay free of @netlify/blobs and
// @neondatabase/serverless imports so tests can import it with plain node
// (no installed node_modules on the VM). Blobs/Neon access lives in the
// endpoint files, which pass `sql` / `store` in. The blob-key hash below
// mirrors netlify/functions/_graph_cache.mjs::blobKeyFor's algorithm; the
// api-bands blob key itself is computed by callers via _graph_cache so the
// two can never drift apart.
//
// MASTER-GRAPH ADAPTATION: mirrors graph/index.html buildMasterGraph() +
// normalizeNeonToRows() for ids/types:
//   - band node id = plain band name, UNLESS several bands share a normalized
//     name in different locations, in which case the earliest-created keeps
//     the plain name and the rest get "Name — City, State" ids (the client's
//     disambiguatedBandId). Display name stays the plain name.
//   - person node id = plain member name, UNLESS a band shares that name, in
//     which case the person gets "Name (musician)" (PERSON_ID_SUFFIX).
//   - links: one per membership, source = band node id, target = person id.
//   - nodes are created ONLY for bands/members referenced by a membership,
//     exactly as buildMasterGraph only creates nodes from rows. Orphan bands
//     therefore cannot be anchors (same as the client).
//   - NO bios and NO band_links are carried into views (the endpoint must
//     never return them); band genre is kept because the client node has it.
// ORDER-INDEPENDENCE: bands are sorted by (created_at, id) before grouping
// and person city fallbacks pick the alphabetically-first band, so shuffled
// input produces identical node ids and identical positions (the layout
// modules already sort nodes/links internally).

import {
  buildAdjacency,
  getNeighborhood,
  radialLayout,
  roleForNode,
  classifyNode,
  normalizeAnchorKey,
  PERSON_ID_SUFFIX,
} from '../../scripts/neighborhood-helpers.mjs';
import { polygonLayout } from '../../scripts/polygon-layout.mjs';

// --- Giant-view rule -------------------------------------------------------
// Sync functions time out (10s default / 26s Pro) while a giant layout can
// take ~180s (server-view-plan-back-v1.md: Matt Cameron 3-hop Expand). Any
// view matching this rule is NEVER laid out synchronously: the sync endpoint
// returns 202 {status:'computing'} and the background worker computes it.
// INTEGRATION NOTE (governor v1): only polygon views (hops <= 3) can hit the
// ~180s refine phase. Hops 4-6 use radialLayout, which has no refine phase
// and places nodes in linear time, so a deep radial view is laid out
// synchronously even at the 400-node budget. Forcing hops > 3 through the
// background worker would only add a retry round-trip for a fast layout.
export const GIANT_MAX_NODES = 100;
export const GIANT_MAX_HOPS = 3;
export function isGiantView({ nodeCount = 0, hops = 0 } = {}) {
  return hops <= GIANT_MAX_HOPS && nodeCount > GIANT_MAX_NODES;
}

// --- Param defaults / validation -------------------------------------------
export const VIEW_DEFAULTS = Object.freeze({
  hops: 2,
  maxNodes: 100,
  satelliteCap: 7,
  minSeparation: 140,
});
export const VIEW_LIMITS = Object.freeze({
  hops: [1, 6],
  maxNodes: [1, 400],
  satelliteCap: [1, 30],
  minSeparation: [1, 1000],
});

// Normalize raw (string-or-number) view params. Throws Error on any invalid
// value; callers map that to HTTP 400. `anchor` is required (non-empty).
export function normalizeViewParams(raw = {}) {
  const anchor = String(raw.anchor ?? '').trim();
  if (!anchor) throw new Error('anchor is required');
  const parse = (value, fallback, [lo, hi], name) => {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new Error(`${name} must be an integer in ${lo}..${hi}`);
    }
    return n;
  };
  return {
    anchor,
    hops: parse(raw.hops, VIEW_DEFAULTS.hops, VIEW_LIMITS.hops, 'hops'),
    maxNodes: parse(raw.maxNodes, VIEW_DEFAULTS.maxNodes, VIEW_LIMITS.maxNodes, 'maxNodes'),
    satelliteCap: parse(raw.satelliteCap, VIEW_DEFAULTS.satelliteCap, VIEW_LIMITS.satelliteCap, 'satelliteCap'),
    minSeparation: parse(raw.minSeparation, VIEW_DEFAULTS.minSeparation, VIEW_LIMITS.minSeparation, 'minSeparation'),
  };
}

// --- Cache keys ------------------------------------------------------------
// Same hash as _graph_cache.mjs::blobKeyFor (imul-31, base36). Exported so
// tests can assert a key embeds the version hash.
export function hashString(value) {
  let h = 0;
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Deterministic key for one view. Includes EVERYTHING that affects positions:
// the data version (as its hash — no raw timestamps in the key beyond what
// the version string itself carries) plus anchor, hops, maxNodes, satelliteCap
// and minSeparation. Same inputs -> same key -> same cached positions.
// A data edit changes the version, so the old key is simply never served
// again (orphaned, never reused).
export function cacheKeyFor(version, params) {
  const p = normalizeViewParams(params);
  const versionHash = hashString(version);
  const paramsHash = hashString(JSON.stringify([
    p.anchor, p.hops, p.maxNodes, p.satelliteCap, p.minSeparation,
  ]));
  return `graph-view-v${versionHash}-${paramsHash}`;
}

// --- Identity helpers (mirrors graph/index.html) ---------------------------
function normalizeIdentityKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
// Client's normalizeKey (person-suffix decision): lowercase + whitespace only.
function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function citiesMatch(a, b) {
  const ka = normalizeIdentityKey(a);
  const kb = normalizeIdentityKey(b);
  if (!ka || !kb) return true;
  const ta = ka.split(' ');
  const tb = kb.split(' ');
  const small = ta.length <= tb.length ? ta : tb;
  const bigSet = new Set(ta.length <= tb.length ? tb : ta);
  return small.every((token) => bigSet.has(token));
}
function locationLabel({ city, state, country }) {
  const c = String(city || '').trim();
  const s = String(state || '').trim();
  const co = String(country || '').trim();
  if (co === 'USA') {
    if (c && s) return `${c}, ${s}`;
    return c || s || 'USA';
  }
  if (c && co) return `${c}, ${co}`;
  return c || co || '';
}
function disambiguatedBandId(name, city, state, country) {
  const label = locationLabel({ city, state, country }) || 'Unknown location';
  return `${name} — ${label}`;
}

// --- Master graph ----------------------------------------------------------
export function buildMasterFromPayload(payload = {}) {
  const bands = [...(payload.bands || [])];
  const members = [...(payload.members || [])];
  const memberships = [...(payload.memberships || [])];
  const bandsById = new Map(bands.map((b) => [b.id, b]));
  const membersById = new Map(members.map((m) => [m.id, m]));

  // Deterministic band order (created_at, then id) so suffix assignment does
  // not depend on payload order.
  const orderedBands = bands.slice().sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
    String(a.id).localeCompare(String(b.id)));

  // Same-name band groups -> location clusters -> node ids.
  const bandNameKeys = new Set(bands.map((b) => normalizeKey(b.name)).filter(Boolean));
  const groups = new Map();
  for (const band of orderedBands) {
    const key = normalizeIdentityKey(band.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(band);
  }
  const nodeIdByBandId = new Map();
  for (const group of groups.values()) {
    const clusters = [];
    for (const band of group) {
      const countryKey = normalizeIdentityKey(band.country);
      const cluster = clusters.find((c) => {
        const first = c[0];
        const firstCountry = normalizeIdentityKey(first.country);
        return citiesMatch(first.city, band.city) &&
          (firstCountry === countryKey || !firstCountry || !countryKey);
      });
      if (!cluster) { const next = [band]; clusters.push(next); }
      else cluster.push(band);
    }
    // `group` is already in (created_at, id) order: index 0 keeps the plain
    // name, exactly as normalizeNeonToRows does.
    group.forEach((band, index) => {
      nodeIdByBandId.set(band.id,
        (clusters.length < 2 || index === 0)
          ? band.name
          : disambiguatedBandId(band.name, band.city, band.state, band.country));
    });
  }

  const personNodeId = (name) => {
    const clean = String(name || '').trim();
    if (!clean) return clean;
    if (clean.endsWith(PERSON_ID_SUFFIX)) return clean;
    return bandNameKeys.has(normalizeKey(clean)) ? clean + PERSON_ID_SUFFIX : clean;
  };

  const nodeMap = new Map();
  const links = [];
  // Per-person candidate band rows for the city/state/country fallback,
  // picked deterministically (alphabetically-first band node id).
  const personBandRows = new Map();
  for (const m of memberships) {
    const band = bandsById.get(m.band_id) || {};
    const member = membersById.get(m.member_id) || {};
    const bandNodeId = nodeIdByBandId.get(m.band_id) || band.name || '';
    const memberName = String(member.name || '').trim();
    if (!bandNodeId || !memberName) continue;
    const pid = personNodeId(memberName);
    if (!nodeMap.has(bandNodeId)) {
      nodeMap.set(bandNodeId, {
        id: bandNodeId,
        // Neon uuid, carried so the client can fetch the exact card and so
        // the server can resolve a uuid anchor back to this display id.
        // It is a single row's key, not corpus data, and carries no bio.
        uuid: band.id || '',
        name: band.name || bandNodeId,
        type: 'band',
        city: band.city || '',
        state: band.state || '',
        country: band.country || '',
        genre: band.genre || '',
      });
    }
    if (!personBandRows.has(pid)) personBandRows.set(pid, []);
    personBandRows.get(pid).push({ bandNodeId, band });
    if (!nodeMap.has(pid)) {
      nodeMap.set(pid, {
        id: pid,
        // Neon uuid, same purpose as on band nodes (see above).
        uuid: member.id || '',
        name: memberName,
        type: 'person',
        city: member.city || '',
        state: member.state || '',
        country: member.country || '',
        instrument1: member.instrument1 || '',
        instrument2: member.instrument2 || '',
        popularity_score: member.popularity_score != null ? Number(member.popularity_score) : 0,
      });
    }
    links.push({
      source: bandNodeId,
      target: pid,
      relation: (m.relation || 'member_of').trim ? String(m.relation || 'member_of').trim() : 'member_of',
      weight: Number(m.weight != null ? m.weight : 1),
    });
  }
  // Person city fallback (client: the row's band location): deterministic
  // first band by node id, only when the member row itself has no location.
  for (const [pid, rows] of personBandRows) {
    const node = nodeMap.get(pid);
    if (!node || node.city || node.state || node.country) continue;
    const first = rows.slice().sort((a, b) => String(a.bandNodeId).localeCompare(String(b.bandNodeId)))[0];
    if (first) {
      node.city = first.band.city || '';
      node.state = first.band.state || '';
      node.country = first.band.country || '';
    }
  }
  // Person weight = minimum membership weight (buildMasterGraph's
  // personWeightMap); default 2.
  const minWeight = new Map();
  for (const link of links) {
    if (!minWeight.has(link.target) || link.weight < minWeight.get(link.target)) {
      minWeight.set(link.target, link.weight);
    }
  }
  const nodes = Array.from(nodeMap.values()).map((node) => {
    if (node.type !== 'person') return node;
    return { ...node, weight: minWeight.get(node.id) || 2 };
  });
  nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  links.sort((a, b) =>
    String(a.source).localeCompare(String(b.source)) ||
    String(a.target).localeCompare(String(b.target)));
  return { nodes, links };
}

function resolveAnchorId(masterNodes, anchor) {
  const byId = new Map(masterNodes.map((n) => [n.id, n.id]));
  if (byId.has(anchor)) return anchor;
  const key = normalizeAnchorKey(anchor);
  for (const node of masterNodes) {
    if (normalizeAnchorKey(node.id) === key) return node.id;
  }
  // INTEGRATION (governor v1): search results carry Neon uuids, while graph
  // display ids are names (city-suffixed for colliding bands). A uuid anchor
  // therefore resolves here to its display id, so a search selection can be
  // passed straight to /api/graph-view and to /api/graph-card with the same
  // key, including for colliding same-name bands where a plain name 404s.
  const uuidKey = String(anchor || '').trim().toLowerCase();
  if (uuidKey) {
    for (const node of masterNodes) {
      if (node.uuid && String(node.uuid).trim().toLowerCase() === uuidKey) return node.id;
    }
  }
  return null;
}

// Size of the connected component containing `anchorId`, by BFS over the
// full-master adjacency. This is what lets the client compute the
// other-groups count exactly (totalNodes - currentComponentNodeCount)
// without downloading any other component's nodes.
export function componentNodeCount(adjacency, anchorId) {
  if (!adjacency || !anchorId || !adjacency.has(anchorId)) return 0;
  const seen = new Set([anchorId]);
  const queue = [anchorId];
  while (queue.length) {
    const current = queue.shift();
    for (const neighbor of adjacency.get(current) || []) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen.size;
}

function sortedObjectFromMap(map) {
  const out = {};
  for (const key of Array.from(map.keys()).sort((a, b) => String(a).localeCompare(String(b)))) {
    out[key] = map.get(key);
  }
  return out;
}

// Neighborhood selection + role/kind attachment, WITHOUT layout. This is the
// pure helper the sync endpoint uses to apply the giant rule BEFORE paying
// for a layout, and the helper tests use to assert the rule without running
// a ~180s layout. Returned `nodes` carry `role` (roleForNode vs the anchor,
// full master links) and `kind` (classifyNode, full master adjacency) so the
// client need not hold the full corpus to render identically.
export function buildViewNodes(payload, rawParams) {
  const params = normalizeViewParams(rawParams);
  const master = buildMasterFromPayload(payload);
  const anchorId = resolveAnchorId(master.nodes, params.anchor);
  const empty = {
    anchor: params.anchor,
    anchorId: null,
    nodes: [],
    links: [],
    depths: {},
    depthsMap: new Map(),
    frontier: [],
    truncated: false,
    totalNodes: master.nodes.length,
    currentComponentNodeCount: 0,
    master,
    adjacency: buildAdjacency(master.nodes, master.links),
  };
  if (!anchorId) return empty;
  const adjacency = buildAdjacency(master.nodes, master.links);
  const view = getNeighborhood({
    nodes: master.nodes,
    links: master.links,
    anchorId,
    maxHops: params.hops,
    maxNodes: params.maxNodes,
    adjacency,
    maxSatellites: params.satelliteCap,
  });
  const nodes = view.nodes.map((node) => ({
    ...node,
    role: roleForNode(node, { anchorId, links: master.links }),
    kind: classifyNode(node, { anchorId, adjacency, links: master.links }),
  }));
  nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const links = view.links.slice().sort((a, b) =>
    String(a.source).localeCompare(String(b.source)) ||
    String(a.target).localeCompare(String(b.target)));
  return {
    anchor: anchorId,
    anchorId,
    nodes,
    links,
    depths: sortedObjectFromMap(view.depths),
    depthsMap: view.depths,
    frontier: view.frontier.slice().sort((a, b) => String(a).localeCompare(String(b))),
    truncated: view.truncated,
    totalNodes: master.nodes.length,
    currentComponentNodeCount: componentNodeCount(adjacency, anchorId),
    master,
    adjacency,
  };
}

// Layout step for an already-selected view. Polygon for hops <= 3 (client:
// polygonLayout minSeparation 140), radial for hops 4-6 (client:
// radialLayout spacing 190, full master adjacency + view depths — the exact
// arguments sigma-explorer.mjs passes, so output matches local compute).
export function layoutView(viewNodes, rawParams) {
  const params = normalizeViewParams(rawParams);
  if (!viewNodes.nodes.length) {
    return {
      anchor: params.anchor,
      hops: params.hops,
      maxNodes: params.maxNodes,
      satelliteCap: params.satelliteCap,
      minSeparation: params.minSeparation,
      nodes: [],
      links: [],
      positions: {},
      depths: {},
      frontier: [],
      truncated: false,
      totalNodes: viewNodes.totalNodes || 0,
      currentComponentNodeCount: 0,
    };
  }
  let positionsMap;
  if (params.hops <= 3) {
    positionsMap = polygonLayout({
      nodes: viewNodes.nodes,
      links: viewNodes.links,
      anchorId: viewNodes.anchorId,
      minSeparation: params.minSeparation,
    });
  } else {
    positionsMap = radialLayout({
      nodes: viewNodes.nodes,
      links: viewNodes.links,
      anchorId: viewNodes.anchorId,
      depths: viewNodes.depthsMap,
      spacing: 190,
      adjacency: viewNodes.adjacency,
    });
  }
  const positions = {};
  for (const id of viewNodes.nodes.map((n) => n.id).sort((a, b) => String(a).localeCompare(String(b)))) {
    const p = positionsMap.get(id);
    if (p) positions[id] = { x: p.x, y: p.y };
  }
  return {
    anchor: viewNodes.anchorId,
    hops: params.hops,
    maxNodes: params.maxNodes,
    satelliteCap: params.satelliteCap,
    minSeparation: params.minSeparation,
    nodes: viewNodes.nodes,
    links: viewNodes.links,
    positions,
    depths: viewNodes.depths,
    frontier: viewNodes.frontier,
    truncated: viewNodes.truncated,
    totalNodes: viewNodes.totalNodes,
    currentComponentNodeCount: viewNodes.currentComponentNodeCount || 0,
  };
}

// Full view: selection + layout. Unknown anchor -> empty view (nodes []);
// the HTTP endpoint maps that to 404.
export function buildViewFromPayload(payload, rawParams) {
  const selected = buildViewNodes(payload, rawParams);
  return layoutView(selected, rawParams);
}

// Pure alias required by the background worker contract: the same function
// the HTTP handler and the tests use.
export const computeGraphView = buildViewFromPayload;

// --- Payload loading (shared by both endpoints) ----------------------------
// Verbatim copy of the queries in netlify/functions/bands_neon.mjs
// buildPayload (the /api/bands payload). Kept as a copy, NOT a divergent
// second implementation: bands_neon.mjs does not export its builder, and this
// file must not import other function files. If bands_neon.mjs changes its
// select list, update this function to match.
export async function buildApiBandsPayload(sql) {
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
  return { ok: true, bands, members, memberships, band_links };
}

// Load the api-bands payload for a data version: prefer the Blobs copy
// (keyed by the caller via _graph_cache.blobKeyFor), fall back to Neon.
// `store` may be null (Blobs unavailable) -> straight to Neon.
export async function loadApiBandsPayload({ sql, store, bandsKey }) {
  if (store && bandsKey) {
    try {
      const cached = await store.get(bandsKey, { type: 'json' });
      if (cached && Array.isArray(cached.bands)) return cached;
    } catch {
      // Blob read error -> fall through to Neon.
    }
  }
  return buildApiBandsPayload(sql);
}

// --- Background trigger ------------------------------------------------------
// Fire-and-forget invocation of the background worker. The worker is a
// Netlify background function, so the POST itself returns quickly (202) and
// the compute happens out of band; awaiting this fetch therefore never waits
// for the layout. Best-effort: returns false (never throws) when the trigger
// fails, and the caller must still serve the client (lazy 202 / local
// fallback). `origin` comes from the incoming request URL.
export async function triggerBackgroundCompute({ origin, params, version }) {
  try {
    if (!origin) return false;
    const url = new URL('/.netlify/functions/graph-view-background', origin).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...normalizeViewParams(params), version: version ?? null }),
    });
    return res.ok || res.status === 202;
  } catch {
    return false;
  }
}
