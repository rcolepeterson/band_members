// ---------------------------------------------------------------------------
// SVG renderer / synchronous force-layout helpers.
//
// This module is the canonical, unit-tested source for the pure logic
// behind the perf(graph) SVG performance work:
//   - FORCE_LAYOUT: the tick-budget / alpha / warm-start constants. Single
//     source of truth -- index.html's inline constants are asserted equal
//     to these by tests/graph-render-helpers.test.mjs.
//   - runSyncForceLayout: synchronous d3-force tick loop (no per-tick
//     DOM writes), with an alpha-based early exit.
//   - snapshotNodePositions / applyCachedPositions / clearFixedPositions:
//     position caching across filter changes (near-instant re-layouts).
//   - canWarmStartLayout / runLayoutWithPositionCache: the warm-start
//     *policy* -- when it is safe to reuse cached coordinates.
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

// Force-layout constants, shared by every helper below. index.html declares
// the same names inline (it is a classic, non-module script and cannot
// `import`), and tests/graph-render-helpers.test.mjs asserts the inline
// values match these -- so this object is the single source of truth even
// though the literal is written twice.
export const FORCE_LAYOUT = Object.freeze({
  // Upper-bound synchronous tick budget for a cold layout.
  //
  // NOTE: this used to default to 300 here while index.html ran 120. The
  // module default was stale, not aspirational: perf(graph) lowered the
  // shipped budget to 120 (300 ticks of O(N log N) Barnes-Hut charge force
  // on the full ~3,200-node graph was several seconds of main-thread
  // block) but only updated the inline copy. 120 is what production has
  // actually run since then, so 120 is the reconciled value.
  SIMULATION_TICKS: 120,

  // Tick budget for a warm re-layout, where most nodes are seeded and
  // pinned from the position cache and only genuinely new nodes need to
  // settle.
  WARM_SIMULATION_TICKS: 15,

  // alpha below which a layout is treated as converged and ticking stops.
  SIMULATION_MIN_ALPHA: 0.02,

  // simulation.alphaDecay() -- tuned so alpha crosses SIMULATION_MIN_ALPHA
  // well inside the SIMULATION_TICKS budget.
  ALPHA_DECAY: 0.05,

  // Warm start requires at least this fraction of the new node set to
  // already have a cached position.
  WARM_CACHE_HIT_RATIO: 0.5,

  // Warm start also requires the new node count to be within this fraction
  // of the node count that produced the cache. See canWarmStartLayout for
  // why a high cache-hit ratio alone is not enough.
  WARM_NODE_COUNT_TOLERANCE: 0.25,
});

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
export function runSyncForceLayout(
  simulation,
  ticks = FORCE_LAYOUT.SIMULATION_TICKS,
  minAlpha = FORCE_LAYOUT.SIMULATION_MIN_ALPHA,
) {
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

// How many of `nodes` have a cached position, WITHOUT mutating anything.
// Lets the warm/cold decision happen before the cache is applied, so a
// cold layout starts from d3-force's pristine (deterministic phyllotaxis)
// initial positions rather than a half-seeded hybrid.
export function countCachedPositions(nodes, cache) {
  let hits = 0;
  nodes.forEach(d => {
    if (cache.has(d.id)) hits++;
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Warm-start policy ("stretched then snap", reported by tester Matt Ashman).
//
// A high cache-hit ratio is NOT sufficient to justify a warm start. Cached
// coordinates encode the *global geometry* of the layout that produced
// them, and the warm path pins them with fx/fy -- so whatever extent that
// previous layout had is frozen in place, and no force can correct it.
//
// Two ways that goes wrong:
//
//   1. The node set shrank a lot. Filtering the full ~3,200-node graph down
//      to one scene (or to bands only) leaves every surviving node cached
//      (100% hit ratio) but still scattered across the *full graph's*
//      extent, with the removed nodes' space left as holes. Pinned there,
//      the result is a handful of nodes strung thinly across a huge area --
//      exactly "stretched out in a weird direction" -- and fitGraph() then
//      zooms out to frame that sparse extent. It stays that way until
//      something reheats the simulation, at which point the forces finally
//      pull it compact: the "then it snaps to a usable shape".
//
//   2. The viewport changed. Cached coordinates were laid out around a
//      different d3.forceCenter(width / 2, height / 2), so reusing them
//      starts every node off-centre relative to the new stage.
//
// In both cases the right answer is a cold layout: it is deterministic
// (d3-force seeds missing x/y from a fixed phyllotaxis spiral, so equal
// inputs give equal output -- which also removes the layout-to-layout
// *inconsistency* half of the report) and on a filtered-down node set it is
// far cheaper than the full-graph cold layout the 120-tick budget was sized
// for.
export function canWarmStartLayout({ hits, nodeCount, previous, current } = {}) {
  if (!nodeCount || !hits) return false;
  if (hits < nodeCount * FORCE_LAYOUT.WARM_CACHE_HIT_RATIO) return false;
  // No recorded shape for the cached layout => cannot prove it is reusable.
  if (!previous || !current || !Number.isFinite(previous.count)) return false;
  if (previous.width !== current.width || previous.height !== current.height) return false;
  const countRatio =
    Math.min(previous.count, nodeCount) / Math.max(previous.count, nodeCount);
  if (countRatio < 1 - FORCE_LAYOUT.WARM_NODE_COUNT_TOLERANCE) return false;
  return true;
}

// Runs the layout for a fresh nodes array, warm-starting from `cache` when
// canWarmStartLayout() says the cached geometry is still applicable.
//
//   - Warm path: seed + pin cached positions, run WARM_SIMULATION_TICKS,
//     then unpin. Near-instant; used for re-renders whose node set and
//     viewport are essentially unchanged.
//   - Cold path: ignore the cache entirely (do not even seed x/y) and run
//     the full SIMULATION_TICKS budget from d3-force's own initial
//     positions.
//
// Always snapshots final positions back into `cache` and returns the shape
// descriptor the caller should remember as `previous` for the next call.
export function runLayoutWithPositionCache(simulation, nodes, cache, {
  current = null,
  previous = null,
  ticks = FORCE_LAYOUT.SIMULATION_TICKS,
  warmTicks = FORCE_LAYOUT.WARM_SIMULATION_TICKS,
  minAlpha = FORCE_LAYOUT.SIMULATION_MIN_ALPHA,
} = {}) {
  const hits = cache.size ? countCachedPositions(nodes, cache) : 0;
  const isWarm = canWarmStartLayout({ hits, nodeCount: nodes.length, previous, current });
  if (isWarm) {
    applyCachedPositions(nodes, cache, { pin: true });
    runSyncForceLayout(simulation, warmTicks, minAlpha);
    clearFixedPositions(nodes);
  } else {
    clearFixedPositions(nodes);
    runSyncForceLayout(simulation, ticks, minAlpha);
  }
  snapshotNodePositions(nodes, cache);
  return { isWarm, hits, shape: current ? { ...current, count: nodes.length } : null };
}
