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
// The constellation is now what a visitor gets. ?renderer=svg still reaches the
// original force-directed renderer -- kept deliberately as an escape hatch while
// the Sigma path settles in production, and because a few things only it can do
// (scene and genre filters, Recently-added) have not been rebuilt yet.
export const DEFAULT_RENDERER = 'sigma';

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
  //
  // Two, not three. From a musician, two degrees is exactly one sentence: here is
  // the person, here are their bands, here are the people they played with. Three
  // begins pulling in those bandmates' OTHER bands, which is a second sentence and
  // the point where the opening view stops being about anyone in particular.
  //
  // From Aaron the difference is small in count -- 15 nodes at two degrees against
  // 18 at three -- so this is a change of meaning, not of weight. It is not a
  // performance measure and should not be sold as one. What it does buy is somewhere
  // for Expand to go: the first press now reveals the branch that used to be there
  // before anyone asked.
  //
  // One constant, so every fresh view agrees: opening, Reset, Travel, search and a
  // filter change all frame two degrees. Anything else would mean Reset could shrink
  // the view you were already looking at.
  MAX_HOPS: 2,
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
  // Remembered so a caller can tell the difference between "no link asked for
  // anything" and "a link asked for a band we do not have". Both used to land
  // silently on the fallback, which meant a shared link to a renamed or deleted
  // band opened on a stranger's node with no explanation -- the recipient cannot
  // tell that they were sent somewhere specific at all.
  let requestedByLink = null;
  for (const param of ANCHOR_PARAMS) {
    const asked = params.get(param);
    if (asked && String(asked).trim() && !requestedByLink) requestedByLink = String(asked).trim();
    const hit = match(asked);
    if (hit) return { anchorId: hit, source: 'deep-link', param, requestedByLink: null };
  }

  const runtime = match(requested);
  if (runtime) return { anchorId: runtime, source: 'requested', param: null, requestedByLink };

  const fallbackHit = match(fallback);
  if (fallbackHit) return { anchorId: fallbackHit, source: 'fallback', param: null, requestedByLink };

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
    ? { anchorId: best, source: 'highest-degree', param: null, requestedByLink }
    : { anchorId: null, source: 'none', param: null, requestedByLink };
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
// Constellation relaxation
// ---------------------------------------------------------------------------

/**
 * Deterministic scatter, from a node's id.
 *
 * Perfect concentric rings read as a bullseye, not a constellation. Nudging each
 * node off its ring by a stable amount derived from its own name breaks that up
 * while keeping the layout reproducible -- the same view always looks the same,
 * and a shared link looks the same for everybody who opens it.
 */
export function scatterSeed(id) {
  let hash = 2166136261;
  const text = String(id);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Two independent values in [-1, 1) from the one hash.
  const a = ((hash >>> 8) & 0xffff) / 32768 - 1;
  const b = ((hash >>> 20) & 0xfff) / 2048 - 1;
  return { angular: a, radial: b };
}

/**
 * Relaxes a seeded layout until nodes stop overlapping each other and the edges.
 *
 * Why a solver instead of more geometry rules: the constraints that matter are
 * "no two nodes touch" and "no edge passes through a node", and those are
 * properties of the whole drawing, not of any single placement rule. Successive
 * attempts to guarantee them by construction -- nested wedges, per-layer slots,
 * parent sectors -- each satisfied one constraint by breaking another. Stating
 * the constraints and letting a solver satisfy them directly is both simpler and
 * far more robust, and it happens to look better: the result keeps the organic,
 * scattered constellation feel rather than snapping to concentric rings.
 *
 * Forces, in order of authority:
 *   1. separation   nodes push each other apart when closer than minSeparation
 *   2. clearance    a node is pushed off any edge it is not part of
 *   3. radial       a soft pull back toward the node's hop radius, so distance
 *                   from the anchor still reads as degrees of separation
 *   4. cohesion     a soft pull toward the average of its neighbours, so bands
 *                   and their members stay visually grouped
 *
 * Fully deterministic: fixed iteration count, no randomness, no time-dependence.
 * The anchor never moves.
 *
 * Mutates and returns `positions`.
 */
/**
 * Relaxation passes to spend on a view of this size.
 *
 * A pass costs time in proportion to the node count, so a fixed count would make
 * the largest expansions the slowest interaction in the app. Budgeting keeps the
 * solve roughly constant-time: small views get plenty of passes, big ones get
 * enough to resolve their overlaps and no more.
 */
export function relaxIterations(nodeCount = 0) {
  if (!nodeCount) return 0;
  return Math.max(220, Math.min(900, Math.round(90000 / nodeCount)));
}

// How often the spatial index is rebuilt, in passes.
const REINDEX_EVERY = 4;
// Constraint slack, in layout units, at which a view counts as settled.
const TOLERANCE = 0.5;

export function relaxLayout({
  positions = new Map(),
  links = [],
  anchorId = null,
  minSeparation = 64,
  edgeClearance = 26,
  // Passes are budgeted per view rather than fixed: a pass costs time roughly in
  // proportion to the node count, so a constant count would make the biggest
  // expansions the slowest thing in the app. See relaxIterations.
  iterations = null,
  radialStiffness = 0.06,
  // A node may drift this far in or out of its seeded ring radius, as a
  // fraction. Enforced as a hard clamp, not a spring: "further from the anchor
  // means more degrees of separation" is the one thing the picture has to keep
  // saying, and a spring can be overpowered by a crowd of separation pushes.
  radialBand = 0.26,
  // Cohesion (pulling a node toward the average of its neighbours) is OFF by
  // default and probably should stay that way: the seed layout already places
  // children near their parents, and an attractive force that acts at every
  // distance beats separation, which only acts on contact. With it enabled, a
  // band's forty members were dragged onto the band faster than they could be
  // pushed apart -- the solver compressed the drawing instead of relaxing it.
  cohesion = 0,
  spacing = 150,
} = {}) {
  const ids = Array.from(positions.keys());
  if (ids.length < 2) return positions;
  const passes = iterations || relaxIterations(ids.length);

  const targetRadius = new Map();
  ids.forEach(id => {
    const point = positions.get(id);
    targetRadius.set(id, Math.hypot(point.x, point.y));
  });

  const neighbours = new Map(ids.map(id => [id, []]));
  const edgeList = [];
  links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    if (!positions.has(source) || !positions.has(target) || source === target) return;
    neighbours.get(source).push(target);
    neighbours.get(target).push(source);
    edgeList.push([source, target]);
  });

  const clampToBand = (point, target) => {
    if (!target) return;
    const radius = Math.hypot(point.x, point.y);
    const low = target * (1 - radialBand);
    const high = target * (1 + radialBand);
    if (radius >= low && radius <= high) return;
    const wanted = radius < low ? low : high;
    const scale = wanted / (radius || 1e-6);
    point.x *= scale;
    point.y *= scale;
  };

  const cell = Math.max(minSeparation, edgeClearance) * 2;
  const key = (x, y) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  const grid = new Map();
  // Worst constraint violation seen in a pass, used to stop early.
  let worstViolation = 0;

  // The last quarter of the passes is a SETTLE phase: separation and edge
  // clearance only, with the shaping forces switched off, so the drawing ends on
  // the constraints that matter rather than mid-tug-of-war with them.
  const settleFrom = Math.floor(passes * 0.6);

  for (let pass = 0; pass < passes; pass += 1) {
    const settling = pass >= settleFrom;
    worstViolation = 0;
    // Cooling: big corrections early, fine adjustments later -- but never so
    // gentle that a remaining overlap cannot be resolved before the last pass.
    const strength = 0.55 - 0.25 * (pass / passes);
    const shift = new Map(ids.map(id => [id, { x: 0, y: 0 }]));

    // Spatial index. Rebuilt every few passes rather than every pass: nodes move
    // a fraction of a cell per pass, and the cell is twice the largest constraint
    // distance, so a slightly stale index still finds every real interaction.
    if (pass % REINDEX_EVERY === 0) {
      grid.clear();
      ids.forEach(id => {
        const point = positions.get(id);
        const k = key(point.x, point.y);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(id);
      });
    }

    // 1. Separation.
    ids.forEach(id => {
      const point = positions.get(id);
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.get(`${cx + ox}:${cy + oy}`);
          if (!bucket) continue;
          bucket.forEach(other => {
            if (other === id) return;
            const b = positions.get(other);
            let dx = point.x - b.x;
            let dy = point.y - b.y;
            let distance = Math.hypot(dx, dy);
            if (distance >= minSeparation) return;
            if (distance < 1e-6) {
              // Exactly coincident: separate along a stable direction derived
              // from the ids rather than a random one.
              const seed = scatterSeed(id);
              dx = Math.cos(seed.angular * Math.PI);
              dy = Math.sin(seed.angular * Math.PI);
              distance = 1;
            }
            worstViolation = Math.max(worstViolation, minSeparation - distance);
            const push = ((minSeparation - distance) / distance) * 0.5 * strength;
            const s = shift.get(id);
            s.x += dx * push;
            s.y += dy * push;
          });
        }
      }
    });

    // 2. Edge clearance: push a node off any edge it is not an endpoint of, and
    // nudge that edge's endpoints the other way so the fix is shared.
    edgeList.forEach(([source, target]) => {
      const a = positions.get(source);
      const b = positions.get(target);
      const minX = Math.min(a.x, b.x) - edgeClearance;
      const maxX = Math.max(a.x, b.x) + edgeClearance;
      const minY = Math.min(a.y, b.y) - edgeClearance;
      const maxY = Math.max(a.y, b.y) + edgeClearance;
      for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx += 1) {
        for (let cy = Math.floor(minY / cell); cy <= Math.floor(maxY / cell); cy += 1) {
          const bucket = grid.get(`${cx}:${cy}`);
          if (!bucket) continue;
          bucket.forEach(id => {
            if (id === source || id === target) return;
            const point = positions.get(id);
            const vx = b.x - a.x;
            const vy = b.y - a.y;
            const len2 = vx * vx + vy * vy;
            if (!len2) return;
            let t = ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + t * vx;
            const py = a.y + t * vy;
            let dx = point.x - px;
            let dy = point.y - py;
            let distance = Math.hypot(dx, dy);
            if (distance >= edgeClearance) return;
            if (distance < 1e-6) {
              // Sitting exactly on the line: step off it perpendicular.
              const norm = Math.hypot(vx, vy) || 1;
              dx = -vy / norm;
              dy = vx / norm;
              distance = 1;
            }
            // Edges get extra authority while settling: their endpoints keep
            // moving during the shaping phase, so clearance is the constraint
            // most likely to be left half-resolved at the end.
            worstViolation = Math.max(worstViolation, edgeClearance - distance);
            const push = ((edgeClearance - distance) / distance) * strength * (settling ? 1.6 : 1);
            const s = shift.get(id);
            s.x += dx * push;
            s.y += dy * push;
            // Endpoints yield a little, weighted by how close the crossing is to
            // each of them.
            const sa = shift.get(source);
            const sb = shift.get(target);
            sa.x -= dx * push * 0.25 * (1 - t);
            sa.y -= dy * push * 0.25 * (1 - t);
            sb.x -= dx * push * 0.25 * t;
            sb.y -= dy * push * 0.25 * t;
          });
        }
      }
    });

    // 3 + 4. Soft radial and cohesion pulls (skipped while settling).
    if (!settling) ids.forEach(id => {
      if (id === anchorId) return;
      const point = positions.get(id);
      const s = shift.get(id);
      const radius = Math.hypot(point.x, point.y) || 1e-6;
      const target = targetRadius.get(id);
      const radial = (target - radius) * radialStiffness;
      s.x += (point.x / radius) * radial;
      s.y += (point.y / radius) * radial;

      const group = neighbours.get(id);
      if (group && group.length) {
        let mx = 0;
        let my = 0;
        group.forEach(other => {
          const o = positions.get(other);
          mx += o.x;
          my += o.y;
        });
        mx /= group.length;
        my /= group.length;
        s.x += (mx - point.x) * cohesion;
        s.y += (my - point.y) * cohesion;
      }
    });

    // Apply, with a per-pass cap so one crowded spot cannot fling a node across
    // the view, then clamp back into the node's radial band.
    const maxStep = spacing * 0.4;
    ids.forEach(id => {
      if (id === anchorId) return;
      const point = positions.get(id);
      const s = shift.get(id);
      const magnitude = Math.hypot(s.x, s.y);
      const scale = magnitude > maxStep ? maxStep / magnitude : 1;
      point.x += s.x * scale;
      point.y += s.y * scale;
      clampToBand(point, targetRadius.get(id));
    });

    // Early exit. Once every constraint is satisfied there is nothing left for
    // more passes to do, and most views reach that state long before the
    // iteration ceiling -- which is what keeps this affordable in the browser.
    // Only checked once the shaping forces are out of the way, since they can
    // legitimately create a violation for separation to resolve.
    if (settling && worstViolation <= TOLERANCE) break;
  }

  enforceConstraints({
    positions,
    ids,
    edgeList,
    anchorId,
    minSeparation,
    // Edges are drawn straight, so this pass is the ONLY thing keeping a thread
    // off an unrelated node. Aim well past the strict minimum.
    clearance: minSeparation * 0.55,
    clampToBand,
    targetRadius,
  });

  return positions;
}

/**
 * Final enforcement of the two constraints that matter, together.
 *
 * Running them one after the other does not work: pushing a node off a thread
 * can slide it into another node, and pushing nodes apart can slide one onto a
 * thread, so whichever ran last won and the other was left half-satisfied.
 * Interleaving them in one loop lets both converge, and gives separation the
 * slight edge within each round -- two merged nodes are a worse lie than a
 * thread passing close.
 */
function enforceConstraints({
  positions,
  ids,
  edgeList,
  anchorId,
  minSeparation,
  clearance,
  clampToBand,
  targetRadius,
  // Rounds cost time in proportion to node count squared, so budget them the
  // same way relaxIterations does: enough to converge, not enough to stall a
  // 400-node expansion.
  rounds = null,
}) {
  const passes = rounds || Math.max(24, Math.min(90, Math.round(12000 / Math.max(ids.length, 1))));
  const move = (id, dx, dy) => {
    if (id === anchorId) return;
    const point = positions.get(id);
    point.x += dx;
    point.y += dy;
    clampToBand(point, targetRadius.get(id));
  };

  for (let round = 0; round < passes; round += 1) {
    let worst = 0;

    // Nodes off each other.
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i]);
        const b = positions.get(ids[j]);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minSeparation) continue;
        if (distance < 1e-6) {
          const seed = scatterSeed(ids[i]);
          dx = Math.cos(seed.angular * Math.PI);
          dy = Math.sin(seed.angular * Math.PI);
          distance = 1e-6;
        }
        worst = Math.max(worst, minSeparation - distance);
        const push = (minSeparation - distance) / distance / 2;
        move(ids[i], dx * push, dy * push);
        move(ids[j], -dx * push, -dy * push);
      }
    }

    // Nodes off threads they are not part of.
    edgeList.forEach(([source, target]) => {
      const a = positions.get(source);
      const b = positions.get(target);
      ids.forEach(id => {
        if (id === source || id === target) return;
        const point = positions.get(id);
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (!len2) return;
        let t = ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        let dx = point.x - (a.x + t * vx);
        let dy = point.y - (a.y + t * vy);
        let distance = Math.hypot(dx, dy);
        // The anchor cannot move out of the way -- it is pinned at the centre --
        // so it gets a wider berth, and the thread's own endpoints do the moving.
        const isAnchor = id === anchorId;
        const required = isAnchor ? clearance * 1.6 : clearance;
        if (distance >= required) return;
        if (distance < 1e-6) {
          const norm = Math.hypot(vx, vy) || 1;
          dx = -vy / norm;
          dy = vx / norm;
          distance = 1e-6;
        }
        worst = Math.max(worst, required - distance);
        const push = (required - distance) / distance;
        // The node steps aside, and the thread's ends yield a little -- sharing
        // the correction converges faster than moving the node alone, which just
        // pushes it into whatever is behind it. For the pinned anchor the ends do
        // all of the yielding.
        const nodeShare = isAnchor ? 0 : 0.7;
        const endShare = isAnchor ? 0.5 : 0.15;
        move(id, dx * push * nodeShare, dy * push * nodeShare);
        move(source, -dx * push * endShare * (1 - t), -dy * push * endShare * (1 - t));
        move(target, -dx * push * endShare * t, -dy * push * endShare * t);
      });
    });

    if (worst <= TOLERANCE) break;
  }
}

/**
 * Last word on edge clearance.
 *
 * Same idea as enforceSeparation: one constraint, pushed until it holds. A node
 * lying on an edge it has nothing to do with is the single most misleading thing
 * this drawing can do -- it invents a band membership -- so it gets a dedicated
 * pass rather than being left to the balance of forces.
 */
function enforceEdgeClearance({
  positions,
  ids,
  edgeList,
  anchorId,
  clearance,
  clampToBand,
  targetRadius,
  rounds = 40,
}) {
  for (let round = 0; round < rounds; round += 1) {
    let worst = 0;
    edgeList.forEach(([source, target]) => {
      const a = positions.get(source);
      const b = positions.get(target);
      ids.forEach(id => {
        if (id === source || id === target) return;
        const point = positions.get(id);
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (!len2) return;
        let t = ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        let dx = point.x - (a.x + t * vx);
        let dy = point.y - (a.y + t * vy);
        let distance = Math.hypot(dx, dy);
        // The anchor cannot move out of the way -- it is pinned at the centre --
        // so it gets a wider berth, and the thread's own endpoints do the moving.
        const isAnchor = id === anchorId;
        const required = isAnchor ? clearance * 1.6 : clearance;
        if (distance >= required) return;
        if (distance < 1e-6) {
          const norm = Math.hypot(vx, vy) || 1;
          dx = -vy / norm;
          dy = vx / norm;
          distance = 1e-6;
        }
        worst = Math.max(worst, clearance - distance);
        const push = (clearance - distance) / distance;
        if (id !== anchorId) {
          point.x += dx * push * 0.8;
          point.y += dy * push * 0.8;
          clampToBand(point, targetRadius.get(id));
        }
      });
    });
    if (worst <= TOLERANCE) break;
  }
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
// Widest arc, in radians, that one branch may fan its children across. The
// anchor's ring gets the whole circle; deeper branches stay narrow and centred
// on their parent, so a member is always drawn outward from its band rather
// than swung around to the far side of it.
export const MAX_BRANCH_SPAN = Math.PI * 1.5;

// How much larger than its ring's nominal radius a single branch may push
// itself to fit its children, before it starts using sub-rings instead. A
// branch whose parent sits on a crowded ring inherits a very narrow sector, and
// the only geometrically honest answers are "further out" or "across more
// sub-rings" -- refusing both is what let children of adjacent members collide.
export const MAX_BRANCH_RADIUS_GROWTH = 6;

// Most sub-rings one branch may stagger its children across.
export const MAX_SUB_RINGS = 6;

// Widest slice of a ring one parent's children may occupy before they are moved
// into a local orbit around that parent instead.
export const WIDE_BLOCK_SPAN = Math.PI * 0.75;

// A parent needs at least this many children before its block is treated as
// crowded enough to become an orbit.
export const WIDE_BLOCK_MIN_CHILDREN = 8;

// Narrowest sector a branch may be given, in radians. Only a guard against
// division by zero: a genuinely tiny sector is respected, and the branch moves
// outward instead of spilling into its neighbours.
export const MIN_SECTOR_WIDTH = 0.004;

/**
 * The slice of angle each node on a ring owns: from the midpoint to its
 * counter-clockwise neighbour to the midpoint to its clockwise neighbour,
 * shrunk slightly for margin. A lone node on a ring owns the whole circle.
 *
 * Children placed inside their parent's sector cannot drift sideways past a
 * neighbouring band, which is what keeps membership edges from crossing over
 * unrelated nodes on the way out.
 */
export function sectorsForRing(ids = [], anglesByNode = new Map(), margin = 0.86) {
  const sectors = new Map();
  const ring = ids
    .filter(id => anglesByNode.has(id))
    .map(id => ({ id, angle: normalizeAngle(anglesByNode.get(id)) }))
    .sort((a, b) => a.angle - b.angle);
  if (!ring.length) return sectors;
  if (ring.length === 1) {
    sectors.set(ring[0].id, { center: ring[0].angle, width: Math.PI * 2 });
    return sectors;
  }
  ring.forEach((entry, index) => {
    const previous = ring[(index - 1 + ring.length) % ring.length];
    const next = ring[(index + 1) % ring.length];
    const gapBefore = normalizeAngle(entry.angle - previous.angle) || Math.PI * 2;
    const gapAfter = normalizeAngle(next.angle - entry.angle) || Math.PI * 2;
    // The SMALLER gap sets the width, not the average: a sector is centred on
    // its node, so a window sized by the average would reach past the closer
    // neighbour and let two branches interleave.
    //
    // The floor matters: two ring nodes at (nearly) the same angle would
    // otherwise hand a branch a zero-width sector, collapsing every child in it
    // onto a single point.
    const width = Math.max(Math.min(gapBefore, gapAfter) * margin, MIN_SECTOR_WIDTH);
    sectors.set(entry.id, { center: entry.angle, width });
  });
  return sectors;
}

export function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

export function radialLayout({
  nodes = [],
  links = [],
  anchorId,
  depths = null,
  spacing = 100,
  adjacency = null,
  // Minimum arc length between two neighbours on the same ring, in layout
  // units. Each ring's radius is grown until its whole population fits at this
  // separation, so a crowded ring moves outward instead of packing tighter.
  //
  // Raised from 44 after the invariant sweep (scripts/layout-tune.mjs): more
  // room between neighbours is also more room for the chords that pass between
  // them, and since the camera frames whatever the layout produces, a larger
  // number costs nothing visually.
  minSeparation = 76,
  // How far nodes are nudged off their ring before relaxing, as a fraction of
  // their ring slot. 0 gives clean concentric rings; the default gives a
  // scattered constellation.
  scatter = 1,
  // Forwarded to relaxLayout: how far a node may drift in or out of its ring.
  radialBand = 0.26,
  // Whether to run the collision solver. Off only for tests that want to inspect
  // the raw seed.
  relax = true,
  // How many sub-rings a still-crowded branch may stagger across, and how far
  // apart those sub-rings sit (as a fraction of `spacing`).
  subRingSpacing = 0.34,
  // Fraction of its available angular gap a node actually uses for children,
  // leaving a little breathing room between neighbouring branches.
  sectorMargin = 0.78,
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
  const sortedHops = Array.from(layers.keys()).filter(hop => hop > 0).sort((a, b) => a - b);

  // ----- 1. BFS tree -------------------------------------------------------
  // Each node is attached to the first node one hop closer to the anchor
  // (alphabetically, for determinism). Non-tree edges still exist in the data
  // -- a musician in three bands only gets one tree parent -- they are simply
  // not what drives placement.
  const parentOf = new Map();
  const childrenOf = new Map([[anchorId, []]]);
  sortedHops.forEach(hop => {
    (layers.get(hop) || []).forEach(id => {
      const parents = Array.from(adj.get(id) || []).filter(candidate => hopOf(candidate) === hop - 1);
      parents.sort((a, b) => String(a).localeCompare(String(b)));
      const parent = parents[0] || anchorId;
      parentOf.set(id, parent);
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(id);
      if (!childrenOf.has(id)) childrenOf.set(id, []);
    });
  });

  // ----- 2. Subtree weights ------------------------------------------------
  // Leaves weigh 1; a branch weighs the sum of its leaves. Weights decide how
  // much of the circle each branch is given, which is what makes per-node
  // spacing come out roughly uniform without any node drifting away from its
  // own band.
  const weightOf = new Map();
  [...sortedHops].reverse().concat([0]).forEach(hop => {
    (hop === 0 ? [anchorId] : layers.get(hop) || []).forEach(id => {
      const kids = childrenOf.get(id) || [];
      const weight = kids.reduce((sum, kid) => sum + (weightOf.get(kid) || 1), 0);
      weightOf.set(id, Math.max(1, weight));
    });
  });

  // ----- 3. Rings and placement --------------------------------------------
  //
  // Angles are allocated PER RING, uniformly, ordered by the angle of each
  // node's tree parent. That combination is what satisfies both properties that
  // fought each other through several rewrites:
  //
  //   SEPARATION  A ring of n nodes gives every node the same slot, 2*PI/n, and
  //               the ring's radius is grown until that slot is worth at least
  //               minSeparation of arc. So spacing is guaranteed by
  //               construction -- not inherited, not divided down, and immune to
  //               the cascade where two crowded nodes collapse together and
  //               every descendant collapses with them.
  //   LOCALITY    Ordering by parent angle keeps siblings contiguous and keeps
  //               each block in the same rotational order as the parents that
  //               spawned them, so a band and its members still read as one
  //               solar system and membership edges stay short.
  //
  // Residual long chords -- a musician in eight bands cannot be adjacent to all
  // of them -- are handled by bowing edges away from nodes, see
  // chooseEdgeCurvatures.
  const nodeAngles = new Map([[anchorId, 0]]);
  positions.set(anchorId, { x: 0, y: 0, hop: 0 });
  let previousRadius = 0;

  sortedHops.forEach(hop => {
    const ids = layers.get(hop) || [];
    if (!ids.length) return;

    // Ring radius: far enough out that every slot on it is worth minSeparation,
    // never inside the previous ring, and still reading as one more degree out.
    const slot = (Math.PI * 2) / ids.length;
    const radius = Math.max(
      spacing * hop,
      minSeparation / slot,
      previousRadius + spacing * 0.75
    );

    // Blocks, one per parent, sized by how many children that parent has and
    // placed as close to the parent's own angle as possible without overlapping
    // the block before it.
    //
    // Spreading a layer evenly around the whole ring gives every node the same
    // arc, but it also scatters one band's members across the entire circle --
    // and with STRAIGHT threads, the members on the far side are joined to their
    // band by lines that cut straight across the middle of the graph, through
    // the anchor and whatever else is in the way. Clustering each parent's
    // children in front of it keeps threads short and local, which is what makes
    // a band read as its own little system.
    const byParent = new Map();
    ids.forEach(id => {
      const parent = parentOf.get(id);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(id);
    });
    byParent.forEach(kids => kids.sort((a, b) => String(a).localeCompare(String(b))));

    const parents = Array.from(byParent.keys()).sort(
      (a, b) =>
        (nodeAngles.has(a) ? nodeAngles.get(a) : 0) - (nodeAngles.has(b) ? nodeAngles.get(b) : 0) ||
        String(a).localeCompare(String(b))
    );

    // Monotone placement: each block starts at its parent's angle if it can, or
    // immediately after the previous block if not. Blocks therefore never
    // overlap, so every node keeps its full slot of arc.
    let cursor = null;
    parents.forEach(parent => {
      const kids = byParent.get(parent);
      const width = slot * kids.length;
      const parentAngle = nodeAngles.has(parent) ? nodeAngles.get(parent) : 0;
      const parentPoint = positions.get(parent);

      // A parent with a large share of the ring cannot have its children "in
      // front of it" -- a band with forty members would need most of the circle,
      // and its members would end up ringing the ANCHOR, joined back to their
      // band by long straight threads across the middle of the graph.
      //
      // So past a certain width, the children orbit their own band instead: a
      // compact local ring centred on the parent. Short threads, no crossings,
      // and it is exactly the solar system the space metaphor promises.
      // Only for a genuinely crowded parent: a layer with two or three nodes
      // gives each of them a huge nominal slot, and those should stay on the
      // ring where "one more degree out" still reads.
      if (
        kids.length >= WIDE_BLOCK_MIN_CHILDREN &&
        width > WIDE_BLOCK_SPAN &&
        parentPoint &&
        parent !== anchorId
      ) {
        const orbit = Math.max((kids.length * minSeparation) / (Math.PI * 2), spacing * 0.7);
        // The orbit is centred beyond the band, away from the anchor, so the
        // cluster still sits further out than the ring it came from -- distance
        // from the anchor has to keep meaning degrees of separation.
        const facing = Math.atan2(parentPoint.y, parentPoint.x);
        const centreX = parentPoint.x + Math.cos(facing) * orbit;
        const centreY = parentPoint.y + Math.sin(facing) * orbit;
        kids.forEach((id, index) => {
          const angle = facing + (index + 0.5) * ((Math.PI * 2) / kids.length);
          const x = centreX + Math.cos(angle) * orbit;
          const y = centreY + Math.sin(angle) * orbit;
          positions.set(id, { x, y, hop });
          nodeAngles.set(id, Math.atan2(y, x));
        });
        return;
      }

      const desired = parentAngle - width / 2;
      const start = cursor === null ? desired : Math.max(cursor, desired);
      cursor = start + width;
      kids.forEach((id, index) => {
        const angle = start + slot * (index + 0.5);
        positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, hop });
        nodeAngles.set(id, angle);
      });
    });

    // The next ring must clear whatever this one ACTUALLY used, which is more
    // than its nominal radius once a crowded band's children have been moved out
    // into an orbit around it.
    previousRadius = ids.reduce((furthest, id) => {
      const point = positions.get(id);
      return point ? Math.max(furthest, Math.hypot(point.x, point.y)) : furthest;
    }, radius);
  });

  // ----- 4. Scatter and relax ----------------------------------------------
  // The rings above are a SEED, not the finished drawing: they encode "distance
  // from the anchor means degrees of separation" and nothing else. Scattering
  // each node off its ring by a stable amount derived from its own id turns the
  // bullseye into a constellation, and relaxLayout then resolves whatever that
  // scatter (and the graph's own cross-links) would have overlapped.
  if (scatter > 0) {
    const slots = new Map();
    layers.forEach((ids, hop) => slots.set(hop, (Math.PI * 2) / Math.max(ids.length, 1)));
    positions.forEach((point, id) => {
      if (id === anchorId) return;
      const seed = scatterSeed(id);
      const radius = Math.hypot(point.x, point.y);
      const angle = Math.atan2(point.y, point.x);
      const slot = slots.get(point.hop) || 0;
      const nextAngle = angle + seed.angular * slot * scatter * 0.5;
      const nextRadius = radius * (1 + seed.radial * scatter * 0.18);
      point.x = Math.cos(nextAngle) * nextRadius;
      point.y = Math.sin(nextAngle) * nextRadius;
    });
  }

  if (relax) {
    relaxLayout({
      positions,
      links,
      anchorId,
      minSeparation,
      // Aiming well beyond the strict minimum: the solver has to satisfy many
      // constraints at once, so a generous target is what leaves every one of
      // them comfortably met at the end.
      edgeClearance: minSeparation * 2,
      spacing,
      radialBand,
    });
  }

  return positions;
}

/**
 * Distance from a point to a straight segment.
 */
export function straightDistance(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * Largest distance from the anchor to any node in a layout, in layout units.
 * This is the radius the camera has to frame.
 */
export function layoutExtent(positions) {
  let extent = 0;
  positions.forEach(point => {
    extent = Math.max(extent, Math.sqrt(point.x * point.x + point.y * point.y));
  });
  return extent;
}

/**
 * Chooses a node-size multiplier that keeps nodes from touching ON SCREEN.
 *
 * Node radii are in screen pixels while the camera frames the whole layout, so
 * the pixels-per-layout-unit ratio depends on BOTH how big the neighborhood is
 * and how big the window is. A view that looks well spaced on a 1440x900
 * desktop can collide on a narrower or shorter window -- which is exactly how
 * the first-view overlap was reported.
 *
 * So: convert minSeparation (a layout-unit guarantee from radialLayout) into
 * pixels for this specific viewport, then size nodes to fit inside it with a
 * visible gap.
 *
 *   pixelsPerUnit = usableViewportRadius / layoutExtent
 *   separationPx  = minSeparation * pixelsPerUnit
 *   scale         = separationPx / (2 * maxNodeSize + gap)
 *
 * Clamped to `min`..1 so nodes never grow past their designed size and never
 * shrink below a tappable floor.
 */
export function viewportSizeScale({
  extent = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  minSeparation = 44,
  maxNodeSize = 13,
  gap = 6,
  padding = 0.86,
  min = 0.6,
} = {}) {
  const usableRadius = (Math.min(viewportWidth, viewportHeight) / 2) * padding;
  if (!extent || !usableRadius) return 1;
  const pixelsPerUnit = usableRadius / extent;
  const separationPx = minSeparation * pixelsPerUnit;
  const scale = separationPx / (2 * maxNodeSize + gap);
  return Math.max(min, Math.min(1, scale));
}

/**
 * Camera ratio to open a view at.
 *
 * Fitting the whole neighborhood on screen is only the right move while the
 * result stays legible. Past that point -- a 220-node expansion on a phone --
 * fitting everything forces nodes below a usable size and they collide no matter
 * how small they are drawn. The honest answer is to stop fitting: keep a minimum
 * pixels-per-layout-unit and show a REGION, which is what the explorer is for
 * anyway. The frontier count and expand affordance already tell people there is
 * more graph beyond the edge of the screen.
 *
 * Returns a Sigma camera ratio: baseRatio when everything fits, smaller (zoomed
 * in) when fitting would cost legibility.
 */
export function framingRatio({
  extent = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  minSeparation = 44,
  maxNodeSize = 13,
  // Breathing room between two adjacent node rims, in pixels. Generous on
  // purpose: selection grows a node by a quarter, and a gap of a pixel or two
  // reads as a collision anyway.
  gap = 10,
  padding = 0.86,
  baseRatio = 1.22,
} = {}) {
  const usableRadius = (Math.min(viewportWidth, viewportHeight) / 2) * padding;
  if (!extent || !usableRadius) return baseRatio;
  // Pixels per layout unit needed for two adjacent nodes to clear each other.
  const requiredPixelsPerUnit = (2 * maxNodeSize + gap) / minSeparation;
  const requiredRadius = extent * requiredPixelsPerUnit;
  if (requiredRadius <= usableRadius) return baseRatio;
  return baseRatio * (usableRadius / requiredRadius);
}

/**
 * Shrinks node radii as the visible count grows, so expanded views stay
 * legible instead of turning into overlapping blobs. Square-root scaling
 * because spacing shrinks roughly with the square root of the node count when
 * the camera frames a disc-shaped layout. Floored so nodes never become
 * untappable on a phone.
 */
export function densitySizeScale(visibleCount, baseline = NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES) {
  if (!visibleCount || visibleCount <= baseline) return 1;
  // Floor raised from 0.45 once framingRatio took over responsibility for
  // legibility: nodes should stay tappable, and the camera should zoom instead.
  return Math.max(0.6, Math.min(1, Math.sqrt(baseline / visibleCount)));
}

/**
 * The size multiplier actually used by the renderer: the stricter of the
 * density and viewport constraints, because either one alone can be the thing
 * that would make nodes touch.
 */
export function nodeSizeScale({ visibleCount = 0, ...viewport } = {}) {
  return Math.min(densitySizeScale(visibleCount), viewportSizeScale(viewport));
}

/**
 * Label visibility settings for a view of this size.
 *
 * Sigma hides a label when its node is drawn smaller than
 * labelRenderedSizeThreshold, which silently hid every moon and asteroid --
 * names appeared only on click. In a capped local view we WANT every name, so
 * the threshold follows the smallest node actually drawn, and label density is
 * relaxed for small views and tightened for crowded ones (where Sigma's own
 * overlap culling should do the thinning).
 */
export function labelSettings({ visibleCount = 0, smallestNodeSize = 4 } = {}) {
  const crowded = visibleCount > NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES;
  return {
    // Just under the smallest drawn node, so nothing is silently nameless.
    labelRenderedSizeThreshold: Math.max(0, smallestNodeSize - 0.5),
    // Sigma's grid culling is deliberately switched off (a very high density
    // allowance). It thins labels by grid cell, which cannot prevent collisions
    // across cell boundaries and hid names that had room -- exactly the "a
    // couple of names are missing" report. The renderer's updateLabelBlocking()
    // owns the decision instead: it measures every label box and drops only the
    // ones that would actually overlap chrome or a bigger node's name.
    labelDensity: 1000,
    labelGridCellSize: crowded ? 90 : 55,
  };
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
