// Tests for the force-layout warm-up policy and layout-quality metric added
// by perf(graph): reconcile inline/module force-layout drift + reduce
// stretched-then-snap on load.
//
// Source of the bug: tester Matt Ashman -- "Sometimes the graph layout is
// inconsistent. Like stretched out in a weird direction, then it snaps to a
// usable shape."
//
// Three things are exercised here:
//   1. Drift guards. index.html's inline force-layout constants and the
//      module's FORCE_LAYOUT object must agree, and the module's default
//      tick budget must be the value production actually runs.
//   2. runLayoutWithPositionCache -- cold / warm / partial-cache / repeat
//      stability -- against BOTH the canonical module copy and the REAL
//      inline copy extracted from index.html, plus a parity check that the
//      two make the same warm/cold decisions.
//   3. The label-overlap-at-settle metric (tests/helpers/label-overlap.mjs),
//      which baselines layout *readability* rather than ticks-to-settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as d3 from 'd3';

import {
  FORCE_LAYOUT,
  runSyncForceLayout,
  countCachedPositions,
  canWarmStartLayout,
  runLayoutWithPositionCache,
} from '../scripts/graph-render-helpers.mjs';
import { countLabelOverlaps, layoutExtent, LABEL_PAD_X } from './helpers/label-overlap.mjs';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8'
);

// Pull a top-level `function NAME(...) { ... }` out of index.html by matching
// balanced braces. Same idea as the helper in
// tests/graph-render-helpers.test.mjs, but the parameter list is skipped by
// paren-matching first -- several of these helpers destructure their options
// argument (`{ pin = false } = {}`), and starting the brace scan at the first
// `{` in the whole declaration would stop at the end of the parameter list
// and return a truncated function.
function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found in index.html`);

  let parens = 0;
  let i = html.indexOf('(', start);
  for (; i < html.length; i++) {
    if (html[i] === '(') parens++;
    else if (html[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }

  let depth = 0;
  let j = html.indexOf('{', i);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return html.slice(start, j);
}

// Pull a whole `const NAME = ...;` declaration out of index.html, so the
// harness below runs with the page's real constant values.
function extractConst(name) {
  const match = html.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(match, `const ${name} not found in index.html`);
  return match[0];
}

const INLINE_CONSTANTS = [
  'SIMULATION_TICKS',
  'WARM_SIMULATION_TICKS',
  'SIMULATION_MIN_ALPHA',
  'WARM_CACHE_HIT_RATIO',
  'WARM_NODE_COUNT_TOLERANCE',
];

// Builds a runnable copy of index.html's REAL inline layout code, so these
// tests exercise exactly what the browser runs rather than a paraphrase. The
// page's `lastNodePositions` / `lastLayoutShape` module state is recreated in
// the harness scope and exposed for assertions.
function inlineHarness() {
  const src = `
    const lastNodePositions = new Map();
    let lastLayoutShape = null;
    ${INLINE_CONSTANTS.map(extractConst).join('\n')}
    ${extract('getPersonRadius')}
    ${extract('getNodeOuterRadius')}
    ${extract('buildForceSimulation')}
    ${extract('snapshotNodePositions')}
    ${extract('applyCachedPositions')}
    ${extract('clearFixedPositions')}
    ${extract('countCachedPositions')}
    ${extract('canWarmStartLayout')}
    ${extract('runSyncForceLayout')}
    ${extract('runLayoutWithPositionCache')}
    return {
      buildForceSimulation,
      getNodeOuterRadius,
      canWarmStartLayout,
      countCachedPositions,
      runLayoutWithPositionCache,
      cache: lastNodePositions,
      shape: () => lastLayoutShape,
      constants: { ${INLINE_CONSTANTS.join(', ')} },
    };
  `;
  return new Function('d3', src)(d3);
}

// ---------------------------------------------------------------------
// Test graph. Band/member star topology, same shape as the real dataset:
// every member links to at least one band, a few members span two bands.
// ---------------------------------------------------------------------
function makeGraph({ bands = 40, membersPerBand = 5, prefix = '' } = {}) {
  const nodes = [];
  const links = [];
  for (let b = 0; b < bands; b++) {
    nodes.push({ id: `${prefix}Band ${b}`, type: 'band', weight: 1, city: 'Seattle' });
    for (let m = 0; m < membersPerBand; m++) {
      const id = `${prefix}Member ${b}-${m}`;
      nodes.push({ id, type: 'person', weight: 1 + ((b + m) % 3), instrument1: 'guitar' });
      links.push({ source: `${prefix}Band ${b}`, target: id, weight: 1 });
      // Every 7th member also plays in the previous band, so the graph is
      // connected rather than a pile of disjoint stars.
      if (b > 0 && (b + m) % 7 === 0) {
        links.push({ source: `${prefix}Band ${b - 1}`, target: id, weight: 1 });
      }
    }
  }
  return { nodes, links };
}

// A "filtered down to one scene" subset of a graph: the first `bands` bands
// and their members, as fresh node objects with no positions (exactly what
// renderGraph() builds via filtered.nodes.map(d => ({ ...d }))).
function subsetOf(graph, bands) {
  const keep = new Set();
  for (let b = 0; b < bands; b++) keep.add(`Band ${b}`);
  const nodes = graph.nodes
    .filter(d => keep.has(d.id) || graph.links.some(l => l.target === d.id && keep.has(l.source)))
    .map(d => ({ ...d, x: undefined, y: undefined, fx: undefined, fy: undefined }));
  const ids = new Set(nodes.map(d => d.id));
  const links = graph.links
    .filter(l => ids.has(l.source) && ids.has(l.target))
    .map(l => ({ ...l }));
  return { nodes, links };
}

// Approximates the rendered label geometry index.html measures in the browser
// with getComputedTextLength(). The constant factor is a rough advance-width
// per character for the page's sans stack -- its exact value doesn't matter,
// only that it is fixed, so overlap counts stay comparable across runs.
const AVG_CHAR_WIDTH_RATIO = 0.55;

function annotateLabels(nodes, getNodeOuterRadius) {
  nodes.forEach(d => {
    const text = d.type === 'band' ? `${d.id} · Seattle` : `${d.id} — guitar`;
    const fontPx = d.type === 'band' ? 12 : 10;
    d.labelWidth = text.length * fontPx * AVG_CHAR_WIDTH_RATIO;
    d.labelHeight = fontPx;
    d.outerRadius = getNodeOuterRadius(d);
  });
  return nodes;
}

// index.html's collideRadius closure from renderGraph().
function collideRadiusFor(getNodeOuterRadius) {
  return d => {
    const base = getNodeOuterRadius(d) + LABEL_PAD_X;
    const labelReach = (d.labelWidth || 0) * 0.5 + LABEL_PAD_X;
    return Math.max(base, labelReach);
  };
}

function degreeMap(links) {
  const degree = {};
  links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    degree[s] = (degree[s] || 0) + 1;
    degree[t] = (degree[t] || 0) + 1;
  });
  return degree;
}

const STAGE = { width: 1200, height: 800 };

// Builds the simulation using index.html's REAL buildForceSimulation.
function buildSim(harness, nodes, links, stage = STAGE) {
  return harness.buildForceSimulation(
    nodes,
    links,
    stage.width,
    stage.height,
    degreeMap(links),
    collideRadiusFor(harness.getNodeOuterRadius),
  );
}

// ---------------------------------------------------------------------
// 1. Drift guards
// ---------------------------------------------------------------------
test('index.html inline force-layout constants match the canonical FORCE_LAYOUT object', () => {
  const inline = inlineHarness().constants;
  assert.equal(inline.SIMULATION_TICKS, FORCE_LAYOUT.SIMULATION_TICKS);
  assert.equal(inline.WARM_SIMULATION_TICKS, FORCE_LAYOUT.WARM_SIMULATION_TICKS);
  assert.equal(inline.SIMULATION_MIN_ALPHA, FORCE_LAYOUT.SIMULATION_MIN_ALPHA);
  assert.equal(inline.WARM_CACHE_HIT_RATIO, FORCE_LAYOUT.WARM_CACHE_HIT_RATIO);
  assert.equal(inline.WARM_NODE_COUNT_TOLERANCE, FORCE_LAYOUT.WARM_NODE_COUNT_TOLERANCE);
});

test('module runSyncForceLayout defaults to the shipped 120-tick budget, not the stale 300', () => {
  // The regression this guards: the module default drifted to 300 while
  // index.html ran 120, so the unit-tested copy was not the shipped policy.
  assert.equal(FORCE_LAYOUT.SIMULATION_TICKS, 120);

  let tickCalls = 0;
  const { nodes, links } = makeGraph({ bands: 4, membersPerBand: 3 });
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id))
    .alphaDecay(0) // alpha never reaches minAlpha, so the budget is spent in full
    .stop();
  const realTick = simulation.tick.bind(simulation);
  simulation.tick = (...args) => { tickCalls++; return realTick(...args); };

  runSyncForceLayout(simulation); // no explicit budget -> the default

  assert.equal(tickCalls, FORCE_LAYOUT.SIMULATION_TICKS);
});

test('index.html alphaDecay matches FORCE_LAYOUT.ALPHA_DECAY', () => {
  assert.ok(html.includes(`.alphaDecay(${FORCE_LAYOUT.ALPHA_DECAY})`));
});

// ---------------------------------------------------------------------
// 2. runLayoutWithPositionCache -- canonical module copy
// ---------------------------------------------------------------------
test('runLayoutWithPositionCache cold path: empty cache runs the full budget and positions every node', () => {
  const harness = inlineHarness();
  const { nodes, links } = makeGraph();
  annotateLabels(nodes, harness.getNodeOuterRadius);
  const cache = new Map();

  const result = runLayoutWithPositionCache(buildSim(harness, nodes, links), nodes, cache, {
    current: STAGE,
    previous: null,
  });

  assert.equal(result.isWarm, false);
  assert.equal(result.hits, 0);
  assert.equal(result.shape.count, nodes.length);
  assert.equal(cache.size, nodes.length, 'Cold layout must still populate the cache for next time.');
  nodes.forEach(d => {
    assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y), `Expected finite position for ${d.id}`);
    assert.equal(d.fx, null, 'Cold path must leave no node pinned.');
    assert.equal(d.fy, null);
  });
});

test('runLayoutWithPositionCache warm path: unchanged node set and stage reuses cached positions', () => {
  const harness = inlineHarness();
  const first = makeGraph();
  annotateLabels(first.nodes, harness.getNodeOuterRadius);
  const cache = new Map();
  const cold = runLayoutWithPositionCache(
    buildSim(harness, first.nodes, first.links), first.nodes, cache, { current: STAGE },
  );

  // Same ids, fresh objects with no positions -- what a re-render builds.
  const second = makeGraph();
  annotateLabels(second.nodes, harness.getNodeOuterRadius);
  const warm = runLayoutWithPositionCache(
    buildSim(harness, second.nodes, second.links), second.nodes, cache,
    { current: STAGE, previous: cold.shape },
  );

  assert.equal(warm.isWarm, true);
  assert.equal(warm.hits, second.nodes.length);
  second.nodes.forEach(d => {
    assert.equal(d.fx, null, 'Warm path must unpin when it is done.');
    assert.equal(d.fy, null);
  });
  // Pinned during the warm ticks, so they land exactly on the cached coords.
  const drift = Math.max(...second.nodes.map((d, i) => Math.hypot(d.x - first.nodes[i].x, d.y - first.nodes[i].y)));
  assert.ok(drift < 1, `Expected a warm re-layout to stay put, max drift was ${drift}`);
});

test('runLayoutWithPositionCache partial cache: warm-starts known nodes and still settles the new ones', () => {
  const harness = inlineHarness();
  const first = makeGraph({ bands: 40, membersPerBand: 5 });
  annotateLabels(first.nodes, harness.getNodeOuterRadius);
  const cache = new Map();
  const cold = runLayoutWithPositionCache(
    buildSim(harness, first.nodes, first.links), first.nodes, cache, { current: STAGE },
  );

  // Same node count, but ~30% of the ids are brand new (a search/genre
  // filter that swapped some members in and out). Cache-hit ratio stays
  // above WARM_CACHE_HIT_RATIO and the count is unchanged, so this is a
  // legitimate warm start.
  const second = makeGraph({ bands: 40, membersPerBand: 5 });
  annotateLabels(second.nodes, harness.getNodeOuterRadius);
  const renamed = new Set();
  second.nodes.forEach((d, i) => {
    if (d.type === 'person' && i % 3 === 0) {
      renamed.add(d.id);
      d.id = `New ${d.id}`;
    }
  });
  second.links.forEach(l => { if (renamed.has(l.target)) l.target = `New ${l.target}`; });

  const hits = countCachedPositions(second.nodes, cache);
  assert.ok(hits > 0 && hits < second.nodes.length, `Expected a partial cache hit, got ${hits}/${second.nodes.length}`);

  // d3.forceSimulation() assigns initial coordinates at construction time, so
  // capture them before ticking to prove the warm budget actually moves the
  // uncached nodes rather than leaving them on the initial spiral.
  const simulation = buildSim(harness, second.nodes, second.links);
  const initial = new Map(second.nodes.map(d => [d.id, { x: d.x, y: d.y }]));

  const warm = runLayoutWithPositionCache(simulation, second.nodes, cache, {
    current: STAGE,
    previous: cold.shape,
  });

  assert.equal(warm.isWarm, true);
  assert.equal(warm.hits, hits);
  second.nodes.forEach(d => {
    assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y), `Expected finite position for ${d.id}`);
  });
  // Cached nodes were pinned, so they must not have moved...
  second.nodes.filter(d => !d.id.startsWith('New ')).forEach(d => {
    const cached = cache.get(d.id);
    assert.ok(Math.hypot(d.x - cached.x, d.y - cached.y) < 1, `Cached node ${d.id} should not have moved`);
  });
  // ...while every brand-new node must have been pulled off its initial
  // position by the link/charge forces during the warm ticks.
  second.nodes.filter(d => d.id.startsWith('New ')).forEach(d => {
    const from = initial.get(d.id);
    assert.ok(
      Math.hypot(d.x - from.x, d.y - from.y) > 1,
      `New node ${d.id} never moved off its initial position -- the warm budget did not settle it.`,
    );
  });
});

test('runLayoutWithPositionCache partial cache below the hit ratio falls back to cold', () => {
  const cache = new Map([['Band 0', { x: 10, y: 20 }]]);
  const nodes = makeGraph({ bands: 4, membersPerBand: 4 }).nodes;
  const hits = countCachedPositions(nodes, cache);
  assert.equal(hits, 1);
  assert.equal(
    canWarmStartLayout({ hits, nodeCount: nodes.length, previous: { count: nodes.length, ...STAGE }, current: STAGE }),
    false,
    'A single cached node out of 20 is far below WARM_CACHE_HIT_RATIO.',
  );
});

test('runLayoutWithPositionCache is stable across repeated runs: settled positions do not drift', () => {
  const harness = inlineHarness();
  const cache = new Map();
  let previous = null;
  let last = null;

  for (let run = 0; run < 4; run++) {
    const { nodes, links } = makeGraph();
    annotateLabels(nodes, harness.getNodeOuterRadius);
    const result = runLayoutWithPositionCache(
      buildSim(harness, nodes, links), nodes, cache, { current: STAGE, previous },
    );
    previous = result.shape;
    if (last) {
      const drift = Math.max(...nodes.map((d, i) => Math.hypot(d.x - last[i].x, d.y - last[i].y)));
      assert.ok(drift < 1, `Run ${run} drifted ${drift}px from the previous settled layout.`);
    }
    last = nodes.map(d => ({ x: d.x, y: d.y }));
  }
});

test('a cold layout ignores the cache entirely, so it is deterministic even with stale coordinates', () => {
  const harness = inlineHarness();

  const clean = makeGraph();
  annotateLabels(clean.nodes, harness.getNodeOuterRadius);
  runLayoutWithPositionCache(buildSim(harness, clean.nodes, clean.links), clean.nodes, new Map(), { current: STAGE });

  // Same graph, but the cache is pre-poisoned with wildly wrong coordinates
  // for every node and the recorded shape is a mismatch, forcing the cold
  // path. The cold layout must not seed from those coordinates at all.
  const poisoned = makeGraph();
  annotateLabels(poisoned.nodes, harness.getNodeOuterRadius);
  const cache = new Map(poisoned.nodes.map((d, i) => [d.id, { x: 50000 + i * 900, y: -40000 - i * 700 }]));
  const result = runLayoutWithPositionCache(
    buildSim(harness, poisoned.nodes, poisoned.links), poisoned.nodes, cache,
    { current: STAGE, previous: { count: 3, width: 400, height: 400 } },
  );

  assert.equal(result.isWarm, false);
  const drift = Math.max(...poisoned.nodes.map((d, i) => Math.hypot(d.x - clean.nodes[i].x, d.y - clean.nodes[i].y)));
  assert.ok(drift < 0.001, `Cold layouts of identical input must match exactly; drifted ${drift}`);
});

// ---------------------------------------------------------------------
// 2b. "Stretched then snap" regression -- the actual reported bug
// ---------------------------------------------------------------------
test('regression: filtering down to a small subset re-lays out cold instead of pinning the full graph extent', () => {
  const harness = inlineHarness();
  const full = makeGraph({ bands: 40, membersPerBand: 5 });
  annotateLabels(full.nodes, harness.getNodeOuterRadius);
  const cache = new Map();
  const cold = runLayoutWithPositionCache(
    buildSim(harness, full.nodes, full.links), full.nodes, cache, { current: STAGE },
  );

  // "Filter to one scene": 4 of the 40 bands survive. Every survivor is
  // still in the cache.
  const scene = subsetOf(full, 4);
  annotateLabels(scene.nodes, harness.getNodeOuterRadius);
  const hits = countCachedPositions(scene.nodes, cache);
  assert.equal(hits, scene.nodes.length, 'Every surviving node should be a cache hit.');

  // The OLD policy -- cache-hit ratio alone -- would have gone warm here,
  // pinned all 24-ish nodes at their full-graph coordinates, and frozen the
  // full graph's sprawl in place. That is the "stretched out in a weird
  // direction" state users saw.
  assert.ok(
    hits >= scene.nodes.length * FORCE_LAYOUT.WARM_CACHE_HIT_RATIO,
    'Precondition: the old hit-ratio-only guard passes, which is why this needed the extra shape check.',
  );
  const stretched = layoutExtent(scene.nodes.map(d => cache.get(d.id)));

  const result = runLayoutWithPositionCache(
    buildSim(harness, scene.nodes, scene.links), scene.nodes, cache,
    { current: STAGE, previous: cold.shape },
  );

  assert.equal(result.isWarm, false, 'A large drop in node count must force a cold re-layout.');
  const settled = layoutExtent(scene.nodes);
  const stretchedSpan = Math.max(stretched.width, stretched.height);
  const settledSpan = Math.max(settled.width, settled.height);
  assert.ok(
    settledSpan < stretchedSpan * 0.75,
    `Expected the cold re-layout to compact the subset. Pinned span ${stretchedSpan.toFixed(0)}px vs settled ${settledSpan.toFixed(0)}px.`,
  );
});

test('regression: a stage resize forces a cold layout, since cached coords were centred on the old stage', () => {
  const previous = { count: 200, width: 1200, height: 800 };
  assert.equal(
    canWarmStartLayout({ hits: 200, nodeCount: 200, previous, current: { width: 1200, height: 800 } }),
    true,
    'Same stage and node count is the legitimate warm case.',
  );
  assert.equal(
    canWarmStartLayout({ hits: 200, nodeCount: 200, previous, current: { width: 390, height: 780 } }),
    false,
    'A desktop -> mobile stage change must not warm-start from desktop coordinates.',
  );
});

test('canWarmStartLayout tolerates small node-count changes but not large ones', () => {
  // The guard compares min(previous, current) / max(previous, current), so it
  // is symmetric in direction: both a shrink and a growth of more than
  // WARM_NODE_COUNT_TOLERANCE relative to the larger count force a cold
  // layout.
  const previous = { count: 100, width: 1200, height: 800 };
  const current = { width: 1200, height: 800 };
  const decide = nodeCount => canWarmStartLayout({ hits: nodeCount, nodeCount, previous, current });
  assert.equal(decide(100), true);
  assert.equal(decide(80), true, '80/100 = 0.80, inside the 0.75 floor.');
  assert.equal(decide(70), false, '70/100 = 0.70, outside it.');
  assert.equal(decide(120), true, '100/120 = 0.83, inside it.');
  assert.equal(decide(140), false, '100/140 = 0.71, outside it.');
});

test('canWarmStartLayout refuses to warm-start when there is no recorded shape for the cache', () => {
  assert.equal(
    canWarmStartLayout({ hits: 50, nodeCount: 50, previous: null, current: STAGE }),
    false,
    'First layout after load has no previous shape, so it must be cold.',
  );
});

// ---------------------------------------------------------------------
// 2c. "Stretched then snap" -- the reheat half of the bug
// ---------------------------------------------------------------------
test('index.html drag start no longer reheats the simulation (plain clicks must not re-settle the graph)', () => {
  const dragStart = html.slice(
    html.indexOf(".call(d3.drag()"),
    html.indexOf(".on('drag'", html.indexOf('.call(d3.drag()')),
  );
  assert.ok(dragStart.includes("on('start'"), 'Expected to find the drag start handler.');
  assert.doesNotMatch(
    dragStart,
    /alphaTarget\([^)]*\)\.restart\(\)/,
    'Reheating on drag start fires on every plain click (which opens a node card) and visibly re-settles the whole graph.',
  );
});

test('index.html reheats lazily on the first real drag movement, idempotently', () => {
  const dragHandler = html.slice(
    html.indexOf(".on('drag'"),
    html.indexOf(".on('end'", html.indexOf(".on('drag'")),
  );
  assert.match(dragHandler, /simulation\.alphaTarget\(\) < DRAG_REHEAT_ALPHA_TARGET/);
  assert.match(dragHandler, /simulation\.alphaTarget\(DRAG_REHEAT_ALPHA_TARGET\)\.restart\(\)/);
});

test('a stopped simulation stays stopped through a click-shaped drag gesture (start then end, no movement)', () => {
  const harness = inlineHarness();
  const { nodes, links } = makeGraph({ bands: 6, membersPerBand: 4 });
  annotateLabels(nodes, harness.getNodeOuterRadius);
  const simulation = buildSim(harness, nodes, links);
  runLayoutWithPositionCache(simulation, nodes, new Map(), { current: STAGE });

  const settled = nodes.map(d => ({ x: d.x, y: d.y }));
  // Replay what the handlers do for a click: pin on start, unpin on end.
  const target = nodes[0];
  target.fx = target.x;
  target.fy = target.y;
  simulation.alphaTarget(0);
  target.fx = null;
  target.fy = null;

  // No restart() happened, so nothing may have moved.
  nodes.forEach((d, i) => {
    assert.equal(d.x, settled[i].x, `Clicking must not move ${d.id}`);
    assert.equal(d.y, settled[i].y);
  });
});

// ---------------------------------------------------------------------
// 3. Inline / module parity
// ---------------------------------------------------------------------
test('the inline and module runLayoutWithPositionCache agree on warm/cold decisions and positions', () => {
  const harness = inlineHarness();
  const cases = [
    { label: 'cold first load', stage: STAGE, bands: 20 },
    { label: 'unchanged re-render', stage: STAGE, bands: 20 },
    { label: 'filtered down hard', stage: STAGE, bands: 3 },
    { label: 'stage resized', stage: { width: 390, height: 780 }, bands: 3 },
  ];

  const moduleCache = new Map();
  let modulePrevious = null;

  cases.forEach(({ label, stage, bands }) => {
    const inlineGraph = makeGraph({ bands, membersPerBand: 5 });
    annotateLabels(inlineGraph.nodes, harness.getNodeOuterRadius);
    const inlineWarm = harness.runLayoutWithPositionCache(
      buildSim(harness, inlineGraph.nodes, inlineGraph.links, stage), inlineGraph.nodes, stage,
    );

    const moduleGraph = makeGraph({ bands, membersPerBand: 5 });
    annotateLabels(moduleGraph.nodes, harness.getNodeOuterRadius);
    const moduleResult = runLayoutWithPositionCache(
      buildSim(harness, moduleGraph.nodes, moduleGraph.links, stage), moduleGraph.nodes, moduleCache,
      { current: stage, previous: modulePrevious },
    );
    modulePrevious = moduleResult.shape;

    assert.equal(inlineWarm, moduleResult.isWarm, `warm/cold decision differs for "${label}"`);
    const drift = Math.max(...moduleGraph.nodes.map((d, i) => Math.hypot(d.x - inlineGraph.nodes[i].x, d.y - inlineGraph.nodes[i].y)));
    assert.ok(drift < 0.001, `Positions differ for "${label}" by ${drift}px -- the copies have drifted.`);
  });
});

// ---------------------------------------------------------------------
// 4. Label-overlap-at-settle baseline (Step 3)
//
// Reporting-first: the assertion is a loose ceiling, because the absolute
// number depends on the synthetic label-width approximation above and on the
// dataset shape. Its job is to catch a *large* regression (e.g. a collide
// radius that stops accounting for label width, or a link distance change
// that packs nodes tighter) and to give future PRs a number to compare
// against, not to pin down an exact layout.
// ---------------------------------------------------------------------
test('label-overlap metric: labels do not overlap when nodes are far apart, and do when they are stacked', () => {
  const apart = [
    { id: 'A', x: 0, y: 0, labelWidth: 40, labelHeight: 10, outerRadius: 8 },
    { id: 'B', x: 0, y: 400, labelWidth: 40, labelHeight: 10, outerRadius: 8 },
  ];
  assert.equal(countLabelOverlaps(apart).pairs, 0);

  const stacked = [
    { id: 'A', x: 0, y: 0, labelWidth: 40, labelHeight: 10, outerRadius: 8 },
    { id: 'B', x: 4, y: 1, labelWidth: 40, labelHeight: 10, outerRadius: 8 },
  ];
  const result = countLabelOverlaps(stacked);
  assert.equal(result.pairs, 1);
  assert.equal(result.nodesInvolved, 2);
});

test('label-overlap metric ignores nodes with no label', () => {
  const nodes = [
    { id: 'A', x: 0, y: 0, labelWidth: 0, labelHeight: 10, outerRadius: 8 },
    { id: 'B', x: 1, y: 0, labelWidth: 0, labelHeight: 10, outerRadius: 8 },
  ];
  const result = countLabelOverlaps(nodes);
  assert.equal(result.labelledNodes, 0);
  assert.equal(result.pairs, 0);
});

test('label-overlap-at-settle baseline for the current force configuration', () => {
  const harness = inlineHarness();
  const { nodes, links } = makeGraph({ bands: 40, membersPerBand: 5 });
  annotateLabels(nodes, harness.getNodeOuterRadius);

  runLayoutWithPositionCache(buildSim(harness, nodes, links), nodes, new Map(), { current: STAGE });

  const overlap = countLabelOverlaps(nodes);
  const extent = layoutExtent(nodes);
  // Reported so a future PR can diff the numbers from CI output rather than
  // re-deriving them. Read the two together: sprawl trivially reduces
  // overlaps, so a drop in `pairsPerNode` alongside a jump in `aspect` or
  // extent is a regression, not an improvement.
  console.log(
    `[label-overlap baseline] nodes=${overlap.labelledNodes} overlappingPairs=${overlap.pairs} ` +
    `pairsPerNode=${overlap.pairsPerNode.toFixed(3)} nodesInvolved=${overlap.nodesInvolved} ` +
    `extent=${extent.width.toFixed(0)}x${extent.height.toFixed(0)} aspect=${extent.aspect.toFixed(2)}`
  );

  assert.equal(overlap.labelledNodes, nodes.length, 'Every node in this dataset has a label.');
  // Measured on this dataset at the time of writing: 1 overlapping pair out
  // of 240 labelled nodes (pairsPerNode 0.004), extent 3430x2749, aspect
  // 1.25. The ceilings below keep roughly an order of magnitude of headroom
  // so normal tuning doesn't trip them, while still failing loudly if a
  // change stops reserving label room in the collide radius.
  assert.ok(
    overlap.pairsPerNode < 0.05,
    `Label overlap regressed: ${overlap.pairsPerNode.toFixed(3)} overlapping pairs per node (baseline 0.004).`,
  );
  assert.ok(
    extent.aspect < 2,
    `Settled layout is lopsided (aspect ${extent.aspect.toFixed(2)}, baseline 1.25) -- the "stretched out in a weird direction" symptom.`,
  );
});

test('label-overlap baseline is reproducible: the same dataset settles to the same overlap count', () => {
  const harness = inlineHarness();
  const measure = () => {
    const { nodes, links } = makeGraph({ bands: 25, membersPerBand: 4 });
    annotateLabels(nodes, harness.getNodeOuterRadius);
    runLayoutWithPositionCache(buildSim(harness, nodes, links), nodes, new Map(), { current: STAGE });
    return countLabelOverlaps(nodes).pairs;
  };
  assert.equal(measure(), measure(), 'A cold layout is deterministic, so the metric must be too.');
});
