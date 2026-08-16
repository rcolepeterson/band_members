// ---------------------------------------------------------------------------
// Sigma.js neighborhood explorer — pure logic layer.
//
// This module is the canonical, unit-tested source for the graph *data*
// decisions behind the Sigma migration (issue #80):
//
//   - RENDERER_FLAG / rendererFromSearch: the temporary feature flag that
//     chooses between the shipped SVG renderer and the new Sigma renderer.
//     Default stays 'svg' until interaction + performance parity is proven.
//   - NEIGHBORHOOD_BUDGET: the visible-node budget constants. 50K stored
//     records does not mean 50K rendered nodes; every view is capped.
//   - buildAdjacency / getNeighborhood: breadth-first traversal outward from
//     an anchor that stops at the node budget and reports the *frontier*
//     (adjacent-but-unrendered nodes) so the UI can offer "Expand this
//     constellation" instead of silently dropping the rest of the graph.
//   - resolveAnchor: deep/shared links win over the Aaron McRae fallback.
//   - classifyNode: the space-metaphor mapping (home star / solar system /
//     planet / moon / asteroid) used for Sigma node styling.
//   - toGraphologyGraph: adapter into a canonical Graphology graph. The
//     Graphology constructor is *injected* rather than imported so this file
//     stays dependency-free: the browser passes the CDN build, the test
//     suite passes the `graphology` devDependency.
//
// Deliberately framework-free and side-effect-free: no d3, no sigma, no DOM.
// index.html consumes it through a real `<script type="module">` (the Sigma
// path is a module, unlike the page's classic main script), so unlike
// scripts/location-helpers.mjs and scripts/graph-render-helpers.mjs there is
// NO hand-synced inline copy to keep in step. Keep it that way.
//
// Node/link shapes match buildMasterGraph() in index.html:
//   node = { id, type: 'band' | 'person', city, state, country, genre, ... }
//   link = { source: bandId, target: personId, relation, weight, yearsActive }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export const RENDERER_FLAG = 'renderer';

// The renderer the page uses when no flag is present. Flipping this constant
// to 'sigma' is the ship switch for the migration; the SVG renderer stays
// reachable via ?renderer=svg until it is deleted.
export const DEFAULT_RENDERER = 'svg';

export const RENDERERS = ['svg', 'sigma'];

/**
 * Reads the renderer choice out of a location.search string.
 * Unknown values fall back to DEFAULT_RENDERER rather than throwing, so a
 * typo in a shared link still renders a graph.
 */
export function rendererFromSearch(search = '') {
  const raw = String(search || '');
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  const requested = (params.get(RENDERER_FLAG) || '').trim().toLowerCase();
  return RENDERERS.includes(requested) ? requested : DEFAULT_RENDERER;
}

// ---------------------------------------------------------------------------
// Visible-node budget
// ---------------------------------------------------------------------------

export const NEIGHBORHOOD_BUDGET = Object.freeze({
  // The anchor for direct/home visits when no deep link is present.
  DEFAULT_ANCHOR: 'Aaron McRae',
  // Opening view: anchor + immediate relationships, rendered first.
  OPENING_MAX_NODES: 60,
  // Expanded neighborhood after the opening view settles.
  MAX_NODES: 100,
  // Hard ceiling on traversal depth regardless of the node budget.
  MAX_HOPS: 3,
  // Cap on edges handed to Sigma. Dense hubs (a member in 12 bands) can
  // blow past the node cap in edges alone.
  MAX_EDGES: 400,
  // Ceilings for the deliberate "Expand this constellation" action. Expanding
  // pushes the horizon out one degree at a time and stops here, so exploring
  // never degenerates into rendering the whole corpus.
  EXPAND_MAX_HOPS: 6,
  EXPAND_MAX_NODES: 400,
});

// ---------------------------------------------------------------------------
// Adjacency
// ---------------------------------------------------------------------------

export function linkEndpoints(link) {
  const source = typeof link.source === 'object' && link.source ? link.source.id : link.source;
  const target = typeof link.target === 'object' && link.target ? link.target.id : link.target;
  return [source, target];
}

/**
 * Undirected adjacency map: id -> Set(neighbor ids).
 * Band->member links are stored one way but traversed both ways: a member
 * bridges bands, which is the whole point of the tree.
 */
export function buildAdjacency(nodes = [], links = []) {
  const adjacency = new Map();
  nodes.forEach(node => adjacency.set(node.id, new Set()));
  links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    if (!adjacency.has(source) || !adjacency.has(target)) return;
    adjacency.get(source).add(target);
    adjacency.get(target).add(source);
  });
  return adjacency;
}

// ---------------------------------------------------------------------------
// Breadth-first neighborhood
// ---------------------------------------------------------------------------

/**
 * Collects a capped local neighborhood around `anchorId`.
 *
 * Traversal is breadth-first so nearer relationships always win over distant
 * ones: hop 1 is fully admitted before any hop-2 node is considered. Within a
 * hop, candidates are ordered by degree descending — bridge musicians and
 * busy bands are the most interesting things to show, and they are also the
 * nodes a visitor is most likely to want to expand from next.
 *
 * Returns:
 *   nodes     — the visible subgraph's nodes, each carrying `hop`
 *   links     — links whose BOTH endpoints are visible (capped at MAX_EDGES)
 *   depths    — Map(id -> hop distance from the anchor)
 *   frontier  — adjacent-but-unrendered node ids, i.e. "there is more graph
 *               out there"; the UI turns these into expand affordances
 *   truncated — true when the budget (nodes or edges) stopped the traversal
 */
export function getNeighborhood({
  nodes = [],
  links = [],
  anchorId,
  maxHops = NEIGHBORHOOD_BUDGET.MAX_HOPS,
  maxNodes = NEIGHBORHOOD_BUDGET.MAX_NODES,
  maxEdges = NEIGHBORHOOD_BUDGET.MAX_EDGES,
  adjacency = null,
} = {}) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const empty = { nodes: [], links: [], depths: new Map(), frontier: [], truncated: false };
  if (!anchorId || !byId.has(anchorId)) return empty;

  const adj = adjacency || buildAdjacency(nodes, links);
  const degree = id => (adj.get(id) ? adj.get(id).size : 0);

  const depths = new Map([[anchorId, 0]]);
  const visible = new Set([anchorId]);
  let frontierCandidates = new Set();
  let truncated = false;

  let currentLayer = [anchorId];
  for (let hop = 1; hop <= maxHops && currentLayer.length; hop += 1) {
    // Candidates for this hop, de-duplicated, ordered by degree desc then
    // name asc (a stable, reproducible order — same anchor, same view).
    const candidates = [];
    const seenThisLayer = new Set();
    currentLayer.forEach(id => {
      (adj.get(id) || new Set()).forEach(neighbor => {
        if (visible.has(neighbor) || seenThisLayer.has(neighbor)) return;
        seenThisLayer.add(neighbor);
        candidates.push(neighbor);
      });
    });
    candidates.sort((a, b) => degree(b) - degree(a) || String(a).localeCompare(String(b)));

    const admitted = [];
    candidates.forEach(id => {
      if (visible.size >= maxNodes) {
        truncated = true;
        frontierCandidates.add(id);
        return;
      }
      visible.add(id);
      depths.set(id, hop);
      admitted.push(id);
    });

    currentLayer = admitted;
    if (visible.size >= maxNodes) break;
  }

  // Anything adjacent to a visible node but not itself visible is frontier —
  // including the nodes one hop past maxHops, which are not "truncated by
  // budget" but are still more graph to explore.
  visible.forEach(id => {
    (adj.get(id) || new Set()).forEach(neighbor => {
      if (!visible.has(neighbor)) frontierCandidates.add(neighbor);
    });
  });

  const visibleLinks = links.filter(link => {
    const [source, target] = linkEndpoints(link);
    return visible.has(source) && visible.has(target);
  });
  const cappedLinks = visibleLinks.slice(0, maxEdges);
  if (cappedLinks.length < visibleLinks.length) truncated = true;
  // A view that filled its node budget while neighbors remain unrendered is
  // truncated even if the traversal stopped cleanly at a layer boundary --
  // the UI must still say "there is more graph beyond this view".
  if (visible.size >= maxNodes && frontierCandidates.size > 0) truncated = true;

  const resultNodes = Array.from(visible).map(id => ({ ...byId.get(id), hop: depths.get(id) }));

  return {
    nodes: resultNodes,
    links: cappedLinks,
    depths,
    frontier: Array.from(frontierCandidates).filter(id => byId.has(id)),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

export const ANCHOR_PARAMS = ['node', 'band', 'member', 'person', 'anchor'];

/**
 * Decides which node the opening view is centered on.
 *
 * Precedence, highest first:
 *   1. A deep/shared link parameter (?band=, ?member=, ?node=, ...). Shared
 *      context is authoritative — someone who clicked a link about Mudhoney
 *      must land on Mudhoney, never on Aaron.
 *   2. An explicit runtime anchor (e.g. the node a search just selected).
 *   3. The Aaron McRae fallback for direct/home visits.
 *   4. The highest-degree node in the data, so a graph without Aaron in it
 *      (a filtered scene, a fresh database, a test fixture) still opens on
 *      something meaningful instead of nothing.
 *
 * Matching is case/whitespace-insensitive on node id (ids are names here).
 */
export function resolveAnchor({
  search = '',
  nodes = [],
  links = [],
  requested = null,
  fallback = NEIGHBORHOOD_BUDGET.DEFAULT_ANCHOR,
  adjacency = null,
} = {}) {
  const byKey = new Map(nodes.map(node => [normalizeAnchorKey(node.id), node.id]));
  const match = value => {
    const key = normalizeAnchorKey(value);
    return key && byKey.has(key) ? byKey.get(key) : null;
  };

  const raw = String(search || '');
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  for (const param of ANCHOR_PARAMS) {
    const hit = match(params.get(param));
    if (hit) return { anchorId: hit, source: 'deep-link', param };
  }

  const runtime = match(requested);
  if (runtime) return { anchorId: runtime, source: 'requested', param: null };

  const fallbackHit = match(fallback);
  if (fallbackHit) return { anchorId: fallbackHit, source: 'fallback', param: null };

  const adj = adjacency || buildAdjacency(nodes, links);
  let best = null;
  let bestDegree = -1;
  nodes.forEach(node => {
    const size = adj.get(node.id) ? adj.get(node.id).size : 0;
    if (size > bestDegree || (size === bestDegree && best && String(node.id).localeCompare(best) < 0)) {
      best = node.id;
      bestDegree = size;
    }
  });
  return best
    ? { anchorId: best, source: 'highest-degree', param: null }
    : { anchorId: null, source: 'none', param: null };
}

export function normalizeAnchorKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Space metaphor → node styling
// ---------------------------------------------------------------------------

// Membership relations that mean "not a permanent member". A moon orbits a
// planet without being one: touring, session, live, guest, fill-in players.
export const MOON_RELATIONS = Object.freeze([
  'touring', 'tour', 'session', 'live', 'guest', 'fill-in', 'fill in', 'substitute', 'temporary',
]);

export const NODE_KINDS = Object.freeze({
  HOME_STAR: 'home-star',
  SOLAR_SYSTEM: 'solar-system',
  CONSTELLATION: 'constellation',
  PLANET: 'planet',
  MOON: 'moon',
  ASTEROID: 'asteroid',
});

// The anchor gets its own visual identity: a silver ringed star, not just a
// bigger dot. It is the one node every home visitor sees first, so it doubles
// as the legend for "this is where you are".
export const HOME_STAR_STYLE = Object.freeze({
  kind: NODE_KINDS.HOME_STAR,
  // Sigma custom node program name; renderer registers a ringed-star program.
  nodeType: 'ringed-star',
  color: '#dfe6ef',        // silver core
  ringColor: '#9fb0c4',    // outer ring
  haloColor: 'rgba(223,230,239,0.28)',
  sizeMultiplier: 2.2,
  ringTiltDeg: -18,
  label: 'You are here',
});

/**
 * Maps a node onto the space hierarchy for rendering.
 *
 *   home star     — the current anchor (silver ringed star)
 *   solar system  — a band
 *   constellation — a person in 2+ bands (the bridges that make paths work)
 *   planet        — a core member of a single band
 *   moon          — touring / session / short-term member only
 *   asteroid      — incomplete, unverified, disputed or orphaned record
 *
 * Asteroid wins over planet/moon/solar-system because "needs data" is the
 * state we most want visible; it is the invitation to contribute.
 */
export function classifyNode(node, { anchorId = null, adjacency = null, links = [] } = {}) {
  if (!node) return NODE_KINDS.ASTEROID;
  if (anchorId && node.id === anchorId) return NODE_KINDS.HOME_STAR;

  const degree = adjacency && adjacency.get(node.id) ? adjacency.get(node.id).size : null;

  if (node.type === 'band') {
    if (degree === 0) return NODE_KINDS.ASTEROID;
    return NODE_KINDS.SOLAR_SYSTEM;
  }

  const memberships = links.filter(link => linkEndpoints(link)[1] === node.id);
  if (!memberships.length) return NODE_KINDS.ASTEROID;

  const bandCount = new Set(memberships.map(link => linkEndpoints(link)[0])).size;
  if (bandCount > 1) return NODE_KINDS.CONSTELLATION;

  const everyMembershipIsTemporary = memberships.every(link =>
    MOON_RELATIONS.includes(String(link.relation || '').trim().toLowerCase())
  );
  if (everyMembershipIsTemporary) return NODE_KINDS.MOON;

  return NODE_KINDS.PLANET;
}

// ---------------------------------------------------------------------------
// Graphology adapter
// ---------------------------------------------------------------------------

/**
 * Builds a canonical Graphology graph from the master band/member data.
 *
 * `GraphConstructor` is injected (browser: CDN graphology; tests: the
 * devDependency) so this module never imports a graph library itself.
 *
 * Node attributes carry everything the Sigma renderer and the Six Degrees
 * feature need: entity type, space-metaphor kind, label, location, genre,
 * verification/claim status. Edges keep the membership relation and tenure,
 * which is what lets a shared member read as ONE user-facing degree while
 * the stored path remains Band -> Member -> Band.
 */
export function toGraphologyGraph({ nodes = [], links = [] } = {}, GraphConstructor, options = {}) {
  if (typeof GraphConstructor !== 'function') {
    throw new TypeError('toGraphologyGraph: a Graphology constructor must be provided.');
  }
  const graph = new GraphConstructor({ type: 'undirected', multi: false, allowSelfLoops: false });
  const adjacency = buildAdjacency(nodes, links);
  const anchorId = options.anchorId || null;

  nodes.forEach(node => {
    if (graph.hasNode(node.id)) return;
    graph.addNode(node.id, {
      label: node.id,
      entityType: node.type,
      kind: classifyNode(node, { anchorId, adjacency, links }),
      city: node.city || '',
      state: node.state || '',
      country: node.country || '',
      genre: node.genre || '',
      instruments: [node.instrument1, node.instrument2].filter(Boolean),
      yearsActive: node.yearsActive || '',
      createdAt: node.createdAt || '',
      verified: Boolean(node.verified),
      claimed: Boolean(node.claimed),
      degree: adjacency.get(node.id) ? adjacency.get(node.id).size : 0,
    });
  });

  links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    if (!graph.hasNode(source) || !graph.hasNode(target) || source === target) return;
    if (graph.hasEdge(source, target)) return;
    graph.addEdge(source, target, {
      relation: link.relation || 'member',
      weight: Number(link.weight || 1),
      yearsActive: link.yearsActive || '',
    });
  });

  return graph;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Deterministic radial layout for a capped neighborhood.
 *
 * The migration plan is explicit that we must not re-run a costly global
 * force simulation on every page load. For a 50-100 node local view we do not
 * need one: hop distance already carries the meaning, so the anchor sits at
 * the origin and each hop gets its own ring.
 *
 * Children are placed inside the angular wedge of the parent that first
 * reached them, which keeps a band and its members visually clustered -- the
 * solar-system reading -- instead of scattering members around the ring.
 * Same input, same coordinates, every time: no jitter, no randomness, so a
 * shared link looks identical to everybody who opens it.
 *
 * Returns Map(id -> { x, y, hop }).
 */
export function radialLayout({
  nodes = [],
  links = [],
  anchorId,
  depths = null,
  spacing = 100,
  adjacency = null,
  // Minimum arc length between two nodes on the same ring, in layout units.
  minSeparation = 34,
  // How many sub-rings a crowded wedge may spill into, and how far apart
  // those sub-rings sit (as a fraction of `spacing`).
  subRingLimit = 4,
  subRingSpacing = 0.32,
} = {}) {
  const positions = new Map();
  if (!anchorId || !nodes.length) return positions;

  const adj = adjacency || buildAdjacency(nodes, links);
  const hopOf = id => {
    if (depths && depths.has(id)) return depths.get(id);
    const node = nodes.find(n => n.id === id);
    return node && typeof node.hop === 'number' ? node.hop : 0;
  };

  const layers = new Map();
  nodes.forEach(node => {
    const hop = hopOf(node.id);
    if (!layers.has(hop)) layers.set(hop, []);
    layers.get(hop).push(node.id);
  });
  layers.forEach(ids => ids.sort((a, b) => String(a).localeCompare(String(b))));

  // The anchor owns the full circle; every later layer subdivides its
  // parent's wedge.
  const wedges = new Map([[anchorId, { start: 0, end: Math.PI * 2 }]]);
  positions.set(anchorId, { x: 0, y: 0, hop: 0 });

  const maxHop = Math.max(...layers.keys());
  for (let hop = 1; hop <= maxHop; hop += 1) {
    const ids = layers.get(hop) || [];
    const byParent = new Map();
    ids.forEach(id => {
      const parents = Array.from(adj.get(id) || []).filter(
        candidate => hopOf(candidate) === hop - 1 && positions.has(candidate)
      );
      parents.sort((a, b) => String(a).localeCompare(String(b)));
      const parent = parents[0] || anchorId;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(id);
    });

    byParent.forEach((children, parent) => {
      const wedge = wedges.get(parent) || { start: 0, end: Math.PI * 2 };
      const span = wedge.end - wedge.start;
      const baseRadius = spacing * hop;

      // A narrow wedge holding many children would stack them into an
      // unreadable smear along one radial line -- exactly what a hub band
      // with 30 members does. When the arc each child would get is thinner
      // than minSeparation, split the children across sub-rings just inside
      // and outside the nominal hop radius. Still fully deterministic.
      const arcPerChild = (span * baseRadius) / children.length;
      const rings = Math.max(
        1,
        Math.min(subRingLimit, Math.ceil(minSeparation / Math.max(arcPerChild, 1)))
      );
      const perRing = Math.ceil(children.length / rings);

      children.forEach((id, index) => {
        const ring = index % rings;
        const indexInRing = Math.floor(index / rings);
        const countInRing = Math.min(perRing, Math.ceil((children.length - ring) / rings));
        const step = span / Math.max(countInRing, 1);
        const start = wedge.start + step * indexInRing;
        const end = start + step;
        const angle = (start + end) / 2;
        const radius = baseRadius + ring * spacing * subRingSpacing;
        positions.set(id, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          hop,
        });
        // Narrow the wedge slightly so grandchildren do not collide with
        // their cousins on the next ring out.
        const inset = step * 0.05;
        wedges.set(id, { start: start + inset, end: end - inset });
      });
    });
  }

  return positions;
}

/**
 * Band-to-band degrees for the Six Degrees feature.
 *
 * The stored path alternates Band -> Member -> Band, so the user-facing
 * degree count is the number of *shared members* along it, i.e. half the
 * edge count. "Band A -> Aaron McRae -> Band B" is 1 degree, matching the
 * Kevin Bacon game. A person-to-person or mixed path falls back to counting
 * membership hops.
 */
export function pathToUserFacingDegrees(path = []) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  return Math.ceil((path.length - 1) / 2);
}
