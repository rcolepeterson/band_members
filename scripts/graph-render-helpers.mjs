// ---------------------------------------------------------------------------
// SVG renderer / synchronous force-layout helpers.
//
// This module is the canonical, unit-tested source for the pure logic
// behind the perf(graph) SVG performance work:
//   - runSyncForceLayout: synchronous d3-force tick loop (no per-tick
//     DOM writes), with an alpha-based early exit.
//   - snapshotNodePositions / applyCachedPositions / clearFixedPositions:
//     position caching across filter changes (near-instant re-layouts).
//
// index.html carries a hand-synced inline copy of this logic (same
// rationale as scripts/location-helpers.mjs -- the page's main script is a
// classic, non-module script, so it can't `import` this file directly; see
// the big comment above the location-helpers copy in index.html for why).
// If you change behavior here, mirror the change in index.html.
//
// d3 (forceSimulation, etc.) is a peer dependency: the browser loads it
// from the CDN (<script src="https://d3js.org/d3.v7.min.js">), and the
// test suite gets it from the `d3` devDependency in package.json (kept at
// the same major version, 7, as the CDN script tag).
//
// NOTE: an earlier revision of this module also carried helpers for a
// canvas-based renderer (rendererFromSearch, buildNodeQuadtree,
// hitTestNode, zoomFilterAllowsPointerdown, computeNodeBounds). That
// renderer was reverted -- its drag/click interaction layer proved too
// fragile to verify without in-the-loop device testing -- and those
// canvas-only helpers were removed along with it. Only the SVG-relevant
// sync-layout and position-cache helpers remain.
// ---------------------------------------------------------------------------

// Advances a (already-configured, already-.stop()'d) d3-force simulation
// synchronously `ticks` times. No DOM writes happen here -- the caller
// does exactly one paint after this returns, which is the whole point of
// the perf fix (the old code painted once per tick).
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
// Map keyed by node id). Call this once a layout has finished.
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
