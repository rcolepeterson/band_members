// ---------------------------------------------------------------------------
// Canvas renderer / synchronous force-layout helpers.
//
// This module is the canonical, unit-tested source for the pure logic
// behind the perf(graph) canvas renderer work:
//   - rendererFromSearch: ?renderer= query-param parsing.
//   - runSyncForceLayout: synchronous d3-force tick loop (no per-tick
//     DOM/canvas writes).
//   - buildNodeQuadtree / hitTestNode: canvas click/drag hit-testing.
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
export function runSyncForceLayout(simulation, ticks = 300) {
  for (let i = 0; i < ticks; i++) simulation.tick();
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
