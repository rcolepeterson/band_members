// Tests for the SVG-renderer synchronous force-layout helpers added by
// perf(graph): synchronous force layout + position cache for filter
// re-renders.
//
// Two things are exercised here:
//   1. The canonical pure-logic module (scripts/graph-render-helpers.mjs) --
//      imported directly, same convention as tests/location-helpers.test.mjs
//      and tests/pipeline-helpers.test.mjs.
//   2. The REAL inline copies in index.html, extracted by brace-matching --
//      same convention as tests/graph-merge.test.mjs. This guarantees these
//      tests exercise the exact code the browser runs, not just a copy
//      that could drift.
//
// NOTE: an earlier revision of this file also covered a canvas-based
// renderer (renderer-flag parsing, quadtree hit-testing, canvas-native PNG
// export, the zoom .filter()/drag wiring). That renderer was reverted --
// its drag/click interaction layer proved too fragile to verify without
// in-the-loop device testing -- and the canvas-only tests were removed
// along with it. Only SVG-relevant coverage remains: sync layout, the
// alpha-based early exit, and the position cache / warm-restart path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as d3 from 'd3';

import {
  runSyncForceLayout,
  snapshotNodePositions,
  applyCachedPositions,
  clearFixedPositions,
} from '../scripts/graph-render-helpers.mjs';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8'
);

// Pull a top-level `function NAME(...) { ... }` out of index.html by
// matching balanced braces from the function's opening brace. Mirrors the
// helper in tests/graph-merge.test.mjs.
function extract(name) {
  let start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found in index.html`);
  // Include a preceding `async` keyword, if present, so extracted async
  // functions keep working `await` expressions when rebuilt via `new
  // Function(...)` (dropping `async` but keeping `await` is a SyntaxError).
  const asyncPrefix = 'async ';
  if (html.slice(Math.max(0, start - asyncPrefix.length), start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  let depth = 0;
  let j = html.indexOf('{', start);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return html.slice(start, j);
}

// ---------------------------------------------------------------------
// Synchronous layout
// ---------------------------------------------------------------------
function makeSmallGraph() {
  const nodes = [
    { id: 'Band A', type: 'band', weight: 1 },
    { id: 'Alice', type: 'person', weight: 1 },
    { id: 'Bob', type: 'person', weight: 2 },
    { id: 'Band B', type: 'band', weight: 1 },
    { id: 'Carol', type: 'person', weight: 3 },
  ];
  const links = [
    { source: 'Band A', target: 'Alice', weight: 1 },
    { source: 'Band A', target: 'Bob', weight: 1 },
    { source: 'Band B', target: 'Carol', weight: 1 },
  ];
  return { nodes, links };
}

test('runSyncForceLayout produces finite, stable x/y for every node', () => {
  const { nodes, links } = makeSmallGraph();
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(300, 300))
    .force('collision', d3.forceCollide().radius(10).strength(0.9).iterations(2))
    .stop();

  runSyncForceLayout(simulation, 300);

  nodes.forEach(d => {
    assert.equal(typeof d.x, 'number');
    assert.equal(typeof d.y, 'number');
    assert.ok(Number.isFinite(d.x), `Expected finite x for ${d.id}, got ${d.x}`);
    assert.ok(Number.isFinite(d.y), `Expected finite y for ${d.id}, got ${d.y}`);
  });
});

test('runSyncForceLayout settles to stable positions (further ticks barely move nodes)', () => {
  const { nodes, links } = makeSmallGraph();
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(300, 300))
    .force('collision', d3.forceCollide().radius(10).strength(0.9).iterations(2))
    .alphaDecay(0.045)
    .stop();

  runSyncForceLayout(simulation, 300);
  const before = nodes.map(d => ({ x: d.x, y: d.y }));
  runSyncForceLayout(simulation, 20);
  const after = nodes.map(d => ({ x: d.x, y: d.y }));

  before.forEach((pos, i) => {
    const dx = Math.abs(pos.x - after[i].x);
    const dy = Math.abs(pos.y - after[i].y);
    assert.ok(dx < 1, `Expected node ${i} x to have settled, moved ${dx}`);
    assert.ok(dy < 1, `Expected node ${i} y to have settled, moved ${dy}`);
  });
});

test('runSyncForceLayout on a larger graph (300 nodes) stays finite', () => {
  const nodes = [];
  const links = [];
  for (let i = 0; i < 50; i++) {
    nodes.push({ id: `Band ${i}`, type: 'band', weight: 1 });
  }
  for (let i = 0; i < 250; i++) {
    const bandIdx = i % 50;
    nodes.push({ id: `Member ${i}`, type: 'person', weight: 1 + (i % 3) });
    links.push({ source: `Band ${bandIdx}`, target: `Member ${i}`, weight: 1 });
  }

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(90).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('center', d3.forceCenter(800, 600))
    .force('collision', d3.forceCollide().radius(10).strength(0.9).iterations(2))
    .stop();

  runSyncForceLayout(simulation, 300);

  let finiteCount = 0;
  nodes.forEach(d => {
    if (Number.isFinite(d.x) && Number.isFinite(d.y)) finiteCount++;
  });
  assert.equal(finiteCount, nodes.length, 'Every node must have finite x/y after sync layout.');
});

// ---------------------------------------------------------------------
// runSyncForceLayout early exit -- canonical module
// ---------------------------------------------------------------------
test('runSyncForceLayout early-exits once alpha drops below minAlpha, using fewer than `ticks` calls', () => {
  const { nodes, links } = makeSmallGraph();
  let tickCalls = 0;
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(300, 300))
    .force('collision', d3.forceCollide().radius(10).strength(0.9).iterations(2))
    .alphaDecay(0.05)
    .stop();
  const realTick = simulation.tick.bind(simulation);
  simulation.tick = (...args) => { tickCalls++; return realTick(...args); };

  runSyncForceLayout(simulation, 300, 0.02);

  assert.ok(tickCalls < 300, `Expected early exit before the full 300-tick budget, used ${tickCalls}`);
  assert.ok(simulation.alpha() < 0.02, `Expected alpha to have dropped below the threshold, got ${simulation.alpha()}`);
});

test('runSyncForceLayout runs the full tick budget when minAlpha is unreachable (alphaDecay 0)', () => {
  const { nodes, links } = makeSmallGraph();
  let tickCalls = 0;
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .alphaDecay(0) // alpha never decays -- early exit should never trigger
    .stop();
  const realTick = simulation.tick.bind(simulation);
  simulation.tick = (...args) => { tickCalls++; return realTick(...args); };

  runSyncForceLayout(simulation, 25, 0.02);

  assert.equal(tickCalls, 25, 'With alphaDecay(0), alpha never drops below minAlpha, so all 25 ticks should run.');
});

test('runSyncForceLayout defaults minAlpha to 0.02 when not provided', () => {
  const { nodes, links } = makeSmallGraph();
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .alphaDecay(0.05)
    .stop();
  runSyncForceLayout(simulation, 300);
  assert.ok(simulation.alpha() < 0.02);
});

// ---------------------------------------------------------------------
// runSyncForceLayout early exit -- the REAL inline copy in index.html
// ---------------------------------------------------------------------
test('index.html inline runSyncForceLayout also early-exits on low alpha', () => {
  const fn = extract('runSyncForceLayout');
  assert.match(fn, /if\s*\(simulation\.alpha\(\)\s*<\s*minAlpha\)\s*break;/);
});

test('index.html SIMULATION_TICKS was reduced from 300 to 120', () => {
  assert.match(html, /const SIMULATION_TICKS = 120;/);
});

test('index.html bumps alphaDecay for faster convergence', () => {
  assert.match(html, /\.alphaDecay\(0\.05\)/);
});

// ---------------------------------------------------------------------
// Position caching across filter changes -- canonical module
// ---------------------------------------------------------------------
test('snapshotNodePositions records finite x/y for every node into the cache map', () => {
  const cache = new Map();
  const nodes = [{ id: 'A', x: 10, y: 20 }, { id: 'B', x: 30, y: 40 }];
  snapshotNodePositions(nodes, cache);
  assert.deepEqual(cache.get('A'), { x: 10, y: 20 });
  assert.deepEqual(cache.get('B'), { x: 30, y: 40 });
});

test('snapshotNodePositions skips nodes with non-finite positions', () => {
  const cache = new Map();
  const nodes = [{ id: 'A', x: NaN, y: 20 }, { id: 'B', x: 30, y: 40 }];
  snapshotNodePositions(nodes, cache);
  assert.equal(cache.has('A'), false);
  assert.equal(cache.get('B').x, 30);
});

test('applyCachedPositions seeds x/y from the cache for matching ids, leaves others untouched', () => {
  const cache = new Map([['A', { x: 111, y: 222 }]]);
  const nodes = [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 0, y: 0 }];
  const seeded = applyCachedPositions(nodes, cache);
  assert.equal(seeded, 1);
  assert.equal(nodes[0].x, 111);
  assert.equal(nodes[0].y, 222);
  assert.equal(nodes[1].x, 0, 'Node B has no cache entry, so it should be untouched.');
});

test('applyCachedPositions with pin:true also sets fx/fy so the simulation treats the node as fixed', () => {
  const cache = new Map([['A', { x: 111, y: 222 }]]);
  const nodes = [{ id: 'A', x: 0, y: 0 }];
  applyCachedPositions(nodes, cache, { pin: true });
  assert.equal(nodes[0].fx, 111);
  assert.equal(nodes[0].fy, 222);
});

test('clearFixedPositions nulls out fx/fy on every node', () => {
  const nodes = [{ id: 'A', fx: 1, fy: 2 }, { id: 'B', fx: 3, fy: 4 }];
  clearFixedPositions(nodes);
  nodes.forEach(n => {
    assert.equal(n.fx, null);
    assert.equal(n.fy, null);
  });
});

test('position cache end-to-end: a second layout with cached positions starts from cached x/y, not a fresh random init', () => {
  const { nodes: firstNodes, links: firstLinks } = makeSmallGraph();
  const simulation1 = d3.forceSimulation(firstNodes)
    .force('link', d3.forceLink(firstLinks).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(300, 300))
    .force('collision', d3.forceCollide().radius(10).strength(0.9).iterations(2))
    .alphaDecay(0.05)
    .stop();
  runSyncForceLayout(simulation1, 300);

  const cache = new Map();
  snapshotNodePositions(firstNodes, cache);
  assert.ok(cache.size === firstNodes.length, 'Expected every node to be cached after the first layout.');

  // Build a brand-new nodes/links copy (same ids -- simulating a filter
  // change that keeps the same node set) with d3-force's default random
  // initial positions -- i.e. do NOT set x/y ourselves.
  const { nodes: secondNodes, links: secondLinks } = makeSmallGraph();
  secondNodes.forEach(n => { assert.equal(n.x, undefined); }); // sanity: no positions set yet

  const seeded = applyCachedPositions(secondNodes, cache, { pin: true });
  assert.equal(seeded, secondNodes.length, 'Every node in the new array shares an id with the cache, so all should be seeded.');

  // Before running any ticks, seeded positions should already match the
  // cached (converged) positions from the first layout -- proving this
  // is a warm start, not a random init.
  secondNodes.forEach(n => {
    const cached = cache.get(n.id);
    assert.equal(n.x, cached.x);
    assert.equal(n.y, cached.y);
  });

  const simulation2 = d3.forceSimulation(secondNodes)
    .force('link', d3.forceLink(secondLinks).id(d => d.id).distance(80).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(300, 300))
    .force('collision', d3.forceCollide().radius(10).strength(0.9).iterations(2))
    .alphaDecay(0.05)
    .stop();

  // A short "warm" tick budget (much less than the 300 used cold) should
  // be enough to stay essentially where the cache put it, since the
  // layout had already converged.
  runSyncForceLayout(simulation2, 40);
  clearFixedPositions(secondNodes);

  secondNodes.forEach(n => {
    const cached = cache.get(n.id);
    const dx = Math.abs(n.x - cached.x);
    const dy = Math.abs(n.y - cached.y);
    assert.ok(dx < 5, `Expected warm-started node ${n.id} to stay close to its cached x, moved ${dx}`);
    assert.ok(dy < 5, `Expected warm-started node ${n.id} to stay close to its cached y, moved ${dy}`);
  });
});

// ---------------------------------------------------------------------
// Position caching -- the REAL inline copy in index.html
// ---------------------------------------------------------------------
test('index.html declares a module-level lastNodePositions cache Map', () => {
  assert.match(html, /const lastNodePositions = new Map\(\);/);
});

test('index.html defines runLayoutWithPositionCache wiring warm/cold layouts through the shared cache', () => {
  const fn = extract('runLayoutWithPositionCache');
  assert.match(fn, /applyCachedPositions\(nodes, \{ pin: true \}\)/);
  assert.match(fn, /WARM_SIMULATION_TICKS/);
  assert.match(fn, /snapshotNodePositions\(nodes\)/);
});

test('index.html renderGraph calls runLayoutWithPositionCache (not a bare runSyncForceLayout call)', () => {
  const fn = extract('renderGraph');
  assert.match(fn, /runLayoutWithPositionCache\(simulation, nodes\)/);
});

test('index.html WARM_SIMULATION_TICKS is tuned low (<=20) since pinned/seeded nodes do not move regardless of tick count', () => {
  const match = html.match(/const WARM_SIMULATION_TICKS = (\d+);/);
  assert.ok(match, 'Expected to find WARM_SIMULATION_TICKS constant declaration');
  const value = Number(match[1]);
  // Measured on the full ~3200-node graph: fx/fy-pinned nodes never move
  // regardless of tick count, so a warm re-layout's cost is pure
  // per-tick Barnes-Hut overhead across ALL nodes (pinned or not), not
  // work proportional to how much settling is needed. 40 ticks measured
  // ~1.3s on this graph; 10 ticks was sufficient even with 20% of nodes
  // freshly unpinned. Guard against regressing back to an overly large
  // budget that reintroduces the multi-second filter-change freeze.
  assert.ok(value <= 20, `Expected WARM_SIMULATION_TICKS <= 20 for near-instant filter changes on the full graph, got ${value}`);
  assert.ok(value >= 5, `Expected WARM_SIMULATION_TICKS >= 5 for enough settling headroom on newly-unpinned nodes, got ${value}`);
});

// ---------------------------------------------------------------------
// Regression: the document-level click-outside listener must still
// close the node card on an empty-SVG-background click. (An earlier
// canvas-renderer revision added a RENDERER-gated branch here; the
// canvas renderer was reverted and this listener is back to its
// original SVG-only form.)
// ---------------------------------------------------------------------
test('index.html document click-outside listener closes the card on an empty-SVG-background click', () => {
  const start = html.indexOf("document.addEventListener('click', e => {\n      if (!nodeCardState.node) return;");
  assert.ok(start >= 0, 'Expected to find the click-outside-closes-card document listener');
  const end = html.indexOf('\n    });', start) + '\n    });'.length;
  const listenerSrc = html.slice(start, end);

  assert.match(listenerSrc, /e\.target === svg[\s\S]*?closeNodeCard\(\)/);
  assert.doesNotMatch(listenerSrc, /RENDERER/);
  assert.doesNotMatch(listenerSrc, /getElementById\('graph-canvas'\)/);
});
