// ---------------------------------------------------------------------------
// Canvas renderer / synchronous force-layout helpers.
//
// This module is the canonical, unit-tested source for the pure logic
// behind the perf(graph) canvas renderer work:
//   - rendererFromSearch: ?renderer= query-param parsing.
//   - runSyncForceLayout: synchronous d3-force tick loop (no per-tick
//     DOM/canvas writes), with an alpha-based early exit.
//   - buildNodeQuadtree / hitTestNode: canvas click/drag hit-testing.
//   - zoomFilterAllowsPointerdown: d3.zoom().filter() logic so panning
//     never wins the race against a node drag/click.
//   - snapshotNodePositions / applyCachedPositions / clearFixedPositions:
//     position caching across filter changes (near-instant re-layouts).
//   - computeNodeBounds: bounding-box math used by the canvas fitGraph
//     variant.
//
// index.html carries a hand-synced inline copy of this logic (same
// rationale as scripts/location-helpers.mjs -- the page's main script is a
// classic, non-module script, so it can't `import` this file directly; see
// the big comment above the location-helpers copy in index.html for why).
// If you change behavior here, mirror the change in index.html.
//
// d3 (forceSimulation, quadtree, etc.) is a peer dependency: the browser
// loads it from the CDN (<script src="https://d3js.org/d3.v7.min.js">),
// and the test suite gets it from the `d3` devDependency in package.json
// (kept at the same major version, 7, as the CDN script tag).
// ---------------------------------------------------------------------------

// Parses the `renderer` query parameter into a normalized renderer id.
// `?renderer=svg` is the only value that opts back into the legacy SVG
// renderer; every other value (including an absent param, or an
// unrecognized value like `?renderer=foo`) resolves to 'canvas', which is
// now the default.
export function rendererFromSearch(search) {
  const params = new URLSearchParams(search || '');
  return params.get('renderer') === 'svg' ? 'svg' : 'canvas';
}

// Advances a (already-configured, already-.stop()'d) d3-force simulation
// synchronously `ticks` times. No DOM/canvas writes happen here -- the
// caller does exactly one paint after this returns, which is the whole
// point of the perf fix (the old code painted once per tick).
//
// Early exit: once simulation.alpha() drops below `minAlpha`, the layout
// has effectively converged (further ticks move nodes by imperceptible
// amounts), so we stop early rather than always spending the full `ticks`
// budget. This is what lets a fixed `ticks` upper bound (used for perf
// budgeting/determinism in tests) also behave well on graphs that settle
// faster than the worst case.
export function runSyncForceLayout(simulation, ticks = 300, minAlpha = 0.02) {
  for (let i = 0; i < ticks; i++) {
    simulation.tick();
    if (simulation.alpha() < minAlpha) break;
  }
  return simulation;
}

// Builds a d3.quadtree over `nodes` (each expected to have numeric x/y,
// e.g. after a force layout has run). Thin wrapper kept here so both the
// production code and tests build the quadtree identically.
export function buildNodeQuadtree(d3quadtree, nodes) {
  return d3quadtree()
    .x(d => d.x)
    .y(d => d.y)
    .addAll(nodes);
}

// Given a quadtree, a world-space (x, y), and a maxRadius, returns the
// nearest node within maxRadius or null if none qualifies. Thin wrapper
// around quadtree.find so the "no match" case is explicit (d3's find
// already returns undefined for no-match; we normalize to null).
export function hitTestNode(quadtree, x, y, maxRadius) {
  if (!quadtree) return null;
  const found = quadtree.find(x, y, maxRadius);
  return found === undefined ? null : found;
}

// Decides whether a pointerdown-family event on the canvas/zoom surface
// should be allowed to start a d3.zoom pan gesture. Wheel/pinch events
// always pass through untouched (zoom must still work for those). For
// pointerdown-ish events (mousedown / touchstart / pointerdown), we
// decline (return false) whenever the pointer landed on a node -- that
// point belongs to d3.drag() instead, so d3.zoom must get out of the way
// or its own mousedown listener wins the race and starts panning instead
// of letting the node-drag/click machinery see the gesture.
//
// `toWorld` is the caller's screenToWorld(sx, sy) -> [wx, wy] converter
// (kept as an injected function rather than imported here, since it
// depends on the live zoom transform, which is page/runtime state, not
// something this pure-logic module owns).
export function zoomFilterAllowsPointerdown(event, quadtree, toWorld, hitRadius = 40) {
  const type = event && event.type;
  if (type !== 'mousedown' && type !== 'touchstart' && type !== 'pointerdown') return true;
  const touch = event.touches && event.touches[0];
  const clientX = event.clientX ?? touch?.clientX;
  const clientY = event.clientY ?? touch?.clientY;
  if (clientX == null || clientY == null) return true;
  const [wx, wy] = toWorld(clientX, clientY);
  return hitTestNode(quadtree, wx, wy, hitRadius) == null;
}

// ---------------------------------------------------------------------------
// Position caching across filter changes (perf(graph) bug C).
//
// Filter changes (band/person toggle, scene, genre, search) tear down and
// rebuild the nodes/links arrays from scratch, which otherwise means a
// full cold force layout (SIMULATION_TICKS) every single time -- even
// though most of the nodes are the *same* nodes that already have a
// perfectly good position from the previous layout. Caching positions by
// node id lets a filter change reuse those positions and run a much
// shorter "warm" layout instead of a cold one.
// ---------------------------------------------------------------------------

// Copies {x, y} for every node with a finite position into `cache` (a
// Map keyed by node id). Call this once a layout has finished (both the
// SVG and canvas paths share this, since both build nodes the same way).
export function snapshotNodePositions(nodes, cache) {
  nodes.forEach(d => {
    if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
      cache.set(d.id, { x: d.x, y: d.y });
    }
  });
  return cache;
}

// Before running a fresh layout on a NEW nodes array (post-filter), seeds
// any node whose id is present in `cache` with its previous x/y -- and,
// when `pin` is true, also sets fx/fy so the simulation treats it as
// (temporarily) fixed. Returns the count of nodes that were seeded from
// cache, which callers can use to decide whether a "warm" (short) layout
// is appropriate (e.g. most ids matched) vs. a cold one (e.g. an empty
// cache, or a mostly-new node set).
export function applyCachedPositions(nodes, cache, { pin = false } = {}) {
  let seeded = 0;
  nodes.forEach(d => {
    const cached = cache.get(d.id);
    if (!cached) return;
    d.x = cached.x;
    d.y = cached.y;
    if (pin) {
      d.fx = cached.x;
      d.fy = cached.y;
    }
    seeded++;
  });
  return seeded;
}

// Clears fx/fy on every node in `nodes` -- used after a warm re-layout
// that pinned cached nodes via applyCachedPositions(..., { pin: true }),
// so a later drag isn't fighting a stale fixed position.
export function clearFixedPositions(nodes) {
  nodes.forEach(d => {
    d.fx = null;
    d.fy = null;
  });
  return nodes;
}

// Computes a padded bounding box over a node array, where each node's
// "footprint" extends `radiusFor(node)` past its center point (so halos /
// verification badges aren't clipped when the caller uses this to frame a
// fit-to-bounds zoom). Returns {minX, minY, maxX, maxY}; for an empty
// array, returns a degenerate all-zero box (caller should guard on
// nodes.length before trusting the result for a real fit).
export function computeNodeBounds(nodes, radiusFor = () => 0) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(d => {
    const r = radiusFor(d);
    minX = Math.min(minX, d.x - r);
    maxX = Math.max(maxX, d.x + r);
    minY = Math.min(minY, d.y - r);
    maxY = Math.max(maxY, d.y + r);
  });
  return { minX, minY, maxX, maxY };
}
