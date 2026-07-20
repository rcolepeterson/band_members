// Tests for the canvas renderer / synchronous force-layout helpers added by
// perf(graph): canvas renderer + synchronous force layout.
//
// Two things are exercised here:
//   1. The canonical pure-logic module (scripts/graph-render-helpers.mjs) --
//      imported directly, same convention as tests/location-helpers.test.mjs
//      and tests/pipeline-helpers.test.mjs.
//   2. The REAL inline copies in index.html, extracted by brace-matching --
//      same convention as tests/graph-merge.test.mjs. This guarantees the
//      renderer-flag parsing and PNG-export dispatch tests exercise the
//      exact code the browser runs, not just a copy that could drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as d3 from 'd3';

import {
  rendererFromSearch,
  runSyncForceLayout,
  buildNodeQuadtree,
  hitTestNode,
  computeNodeBounds,
  zoomFilterAllowsPointerdown,
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
// Renderer flag parsing -- canonical module
// ---------------------------------------------------------------------
test('rendererFromSearch: ?renderer=svg selects svg', () => {
  assert.equal(rendererFromSearch('?renderer=svg'), 'svg');
});

test('rendererFromSearch: ?renderer=canvas selects canvas', () => {
  assert.equal(rendererFromSearch('?renderer=canvas'), 'canvas');
});

test('rendererFromSearch: unrecognized value defaults to canvas', () => {
  assert.equal(rendererFromSearch('?renderer=foo'), 'canvas');
});

test('rendererFromSearch: no param defaults to canvas', () => {
  assert.equal(rendererFromSearch(''), 'canvas');
  assert.equal(rendererFromSearch('?other=1'), 'canvas');
});

// ---------------------------------------------------------------------
// Renderer flag parsing -- the REAL inline copy in index.html, extracted
// and run directly, so a drift between the two copies would fail here.
// ---------------------------------------------------------------------
test('index.html inline rendererFromSearch matches the canonical module', () => {
  const factory = new Function(
    extract('rendererFromSearch') + '\n; return rendererFromSearch;'
  );
  const inlineRendererFromSearch = factory();

  assert.equal(inlineRendererFromSearch('?renderer=svg'), 'svg');
  assert.equal(inlineRendererFromSearch('?renderer=canvas'), 'canvas');
  assert.equal(inlineRendererFromSearch('?renderer=foo'), 'canvas');
  assert.equal(inlineRendererFromSearch(''), 'canvas');
});

test('index.html declares RENDERER from rendererFromSearch(window.location.search) once at load', () => {
  assert.match(
    html,
    /const RENDERER = rendererFromSearch\(window\.location\.search\);/,
    'Expected RENDERER to be computed once, at top level, from the URL search string.'
  );
});

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
// Quadtree-based hit testing
// ---------------------------------------------------------------------
function makePositionedNodes() {
  return [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 100, y: 0 },
    { id: 'C', x: 100, y: 100 },
    { id: 'D', x: -50, y: -50 },
  ];
}

test('hitTestNode finds a node exactly at the clicked coordinates', () => {
  const nodes = makePositionedNodes();
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  const found = hitTestNode(qt, 100, 0, 20);
  assert.ok(found, 'Expected to find node B');
  assert.equal(found.id, 'B');
});

test('hitTestNode finds the nearest node within maxRadius, not exactly on it', () => {
  const nodes = makePositionedNodes();
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  // 8px away from A (0,0); well within a 20px maxRadius, and much closer to
  // A than to any other node.
  const found = hitTestNode(qt, 5, 6, 20);
  assert.ok(found, 'Expected to find the nearby node');
  assert.equal(found.id, 'A');
});

test('hitTestNode returns null when the click is far from every node', () => {
  const nodes = makePositionedNodes();
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  const found = hitTestNode(qt, 5000, 5000, 20);
  assert.equal(found, null);
});

test('hitTestNode respects maxRadius -- a node just outside the radius is not returned', () => {
  const nodes = makePositionedNodes();
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  // Node B is at (100, 0); clicking at (130, 0) is 30px away.
  const foundTight = hitTestNode(qt, 130, 0, 10);
  assert.equal(foundTight, null, 'maxRadius=10 should not reach a node 30px away');
  const foundLoose = hitTestNode(qt, 130, 0, 40);
  assert.ok(foundLoose, 'maxRadius=40 should reach a node 30px away');
  assert.equal(foundLoose.id, 'B');
});

test('hitTestNode returns null for a null/undefined quadtree', () => {
  assert.equal(hitTestNode(null, 0, 0, 10), null);
});

// ---------------------------------------------------------------------
// Bounds computation (used by the canvas fitGraph variant)
// ---------------------------------------------------------------------
test('computeNodeBounds returns the padded bounding box over nodes', () => {
  const nodes = [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    { x: -20, y: 80 },
  ];
  const bounds = computeNodeBounds(nodes, () => 5);
  assert.equal(bounds.minX, -25);
  assert.equal(bounds.maxX, 105);
  assert.equal(bounds.minY, -5);
  assert.equal(bounds.maxY, 85);
});

test('computeNodeBounds on an empty array returns a degenerate zero box', () => {
  const bounds = computeNodeBounds([]);
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

// ---------------------------------------------------------------------
// PNG export dispatch: RENDERER === 'canvas' routes to the canvas-native
// export branch instead of the SVG-serializing path. We can't easily run
// renderGraphPngBlob() itself under Node (it touches document/canvas/Image
// APIs that don't exist outside a browser), but we CAN assert the dispatch
// exists verbatim in the shipped source, which is the behavior this test
// is meant to guard.
// ---------------------------------------------------------------------
test('renderGraphPngBlob short-circuits to the canvas export when RENDERER is canvas', () => {
  const fn = extract('renderGraphPngBlob');
  assert.match(
    fn,
    /if\s*\(RENDERER === 'canvas'\)\s*return renderGraphPngBlobCanvas\(\);/,
    'Expected renderGraphPngBlob to dispatch to renderGraphPngBlobCanvas() when RENDERER is canvas.'
  );
});

test('renderGraphPngBlobCanvas exists and uses canvas.toBlob for the export', () => {
  const fn = extract('renderGraphPngBlobCanvas');
  assert.match(fn, /canvas\.toBlob\(resolve, 'image\/png'\)/);
  assert.match(fn, /getElementById\('graph-canvas'\)/);
});

test('renderGraphPngBlobCanvas fills a background before compositing (avoids a white/transparent gap)', () => {
  const fn = extract('renderGraphPngBlobCanvas');
  assert.match(fn, /fillStyle = '#0b1118'/);
});

// Functional dispatch test: build both functions with a mocked `document`/
// `window`/`canvas.toBlob` and confirm that with RENDERER === 'canvas',
// calling renderGraphPngBlob() actually invokes the mocked toBlob (i.e. the
// canvas path), never touching the SVG/Image machinery.
test('renderGraphPngBlob dispatch (mocked canvas.toBlob): canvas path is used when RENDERER is canvas', async () => {
  let toBlobCalls = 0;
  let getElementByIdCalls = [];

  function makeMockCtx() {
    return {
      fillStyle: null,
      textAlign: null,
      textBaseline: null,
      font: null,
      createLinearGradient() { return { addColorStop() {} }; },
      fillRect() {},
      fillText() {},
      drawImage() {},
    };
  }

  function makeMockCanvas(width, height) {
    return {
      width, height,
      getContext() { return makeMockCtx(); },
      toBlob(cb) { toBlobCalls++; cb({ mocked: true, size: 123, type: 'image/png' }); },
      getBoundingClientRect() { return { width: 390, height: 520 }; },
    };
  }

  const mockDocument = {
    getElementById(id) {
      getElementByIdCalls.push(id);
      if (id === 'graph-canvas') return makeMockCanvas(390, 520);
      if (id === 'graph-svg') return null; // SVG path must not be reached.
      return null;
    },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return makeMockCanvas(0, 0);
    },
  };
  const mockWindow = { location: { origin: 'https://bandmembers.netlify.app', pathname: '/' } };

  const factory = new Function(
    'document', 'window', 'RENDERER',
    extract('renderGraphPngBlobCanvas') +
    '\n' +
    extract('renderGraphPngBlob') +
    '\n; return renderGraphPngBlob;'
  );
  const mockedRenderGraphPngBlob = factory(mockDocument, mockWindow, 'canvas');

  const blob = await mockedRenderGraphPngBlob();

  assert.equal(toBlobCalls, 1, 'Expected the canvas-native toBlob() to be invoked exactly once.');
  assert.deepEqual(blob, { mocked: true, size: 123, type: 'image/png' });
  assert.ok(
    getElementByIdCalls.includes('graph-canvas'),
    'Expected the canvas export path to look up #graph-canvas.'
  );
  assert.ok(
    !getElementByIdCalls.includes('graph-svg'),
    'Canvas dispatch must short-circuit before ever looking up #graph-svg.'
  );
});

// ---------------------------------------------------------------------
// zoom.filter() logic: zoomFilterAllowsPointerdown -- canonical module
// ---------------------------------------------------------------------
test('zoomFilterAllowsPointerdown: wheel events always pass through (zoom must still work)', () => {
  const qt = buildNodeQuadtree(d3.quadtree, [{ id: 'A', x: 0, y: 0 }]);
  const toWorld = (x, y) => [x, y];
  const allowed = zoomFilterAllowsPointerdown({ type: 'wheel' }, qt, toWorld, 40);
  assert.equal(allowed, true);
});

test('zoomFilterAllowsPointerdown: returns false when a mousedown hits a node (pan must defer to drag)', () => {
  const nodes = [{ id: 'A', x: 100, y: 100 }];
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  // toWorld is an identity mock: screen coords === world coords for this test.
  const toWorld = (x, y) => [x, y];
  const event = { type: 'mousedown', clientX: 105, clientY: 102 };
  const allowed = zoomFilterAllowsPointerdown(event, qt, toWorld, 40);
  assert.equal(allowed, false, 'A mousedown on a node must not be allowed to start a zoom pan.');
});

test('zoomFilterAllowsPointerdown: returns true when a mousedown misses every node (pan is fine)', () => {
  const nodes = [{ id: 'A', x: 100, y: 100 }];
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  const toWorld = (x, y) => [x, y];
  const event = { type: 'mousedown', clientX: 5000, clientY: 5000 };
  const allowed = zoomFilterAllowsPointerdown(event, qt, toWorld, 40);
  assert.equal(allowed, true, 'A mousedown far from any node should be allowed to start a pan.');
});

test('zoomFilterAllowsPointerdown: touchstart on a node is also declined (mobile parity)', () => {
  const nodes = [{ id: 'A', x: 50, y: 50 }];
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  const toWorld = (x, y) => [x, y];
  const event = { type: 'touchstart', touches: [{ clientX: 52, clientY: 49 }] };
  const allowed = zoomFilterAllowsPointerdown(event, qt, toWorld, 40);
  assert.equal(allowed, false);
});

test('zoomFilterAllowsPointerdown: a null quadtree (nothing rendered yet) allows panning', () => {
  const toWorld = (x, y) => [x, y];
  const event = { type: 'mousedown', clientX: 10, clientY: 10 };
  assert.equal(zoomFilterAllowsPointerdown(event, null, toWorld, 40), true);
});

// ---------------------------------------------------------------------
// zoom.filter() logic -- the REAL inline copy in index.html
// ---------------------------------------------------------------------
test('index.html defines canvasZoomBehavior with a .filter() that consults zoomFilterAllowsPointerdown', () => {
  assert.match(
    html,
    /canvasZoomBehavior = d3\.zoom\(\)\s*\.scaleExtent\(\[0\.25, 3\]\)\s*\.filter\(event => zoomFilterAllowsPointerdown\(/,
    'Expected canvasZoomBehavior to be configured with a .filter() guarding against node pointerdowns.'
  );
});

test('index.html routes per-node dragging through a real d3.drag() behavior (canvasDragBehavior)', () => {
  assert.match(
    html,
    /canvasDragBehavior = d3\.drag\(\)/,
    'Expected canvasDragBehavior to be a d3.drag() instance, not raw mousedown/mousemove listeners.'
  );
  assert.match(
    html,
    /d3\.select\(canvasEl\)\.call\(canvasZoomBehavior\);\s*\n\s*d3\.select\(canvasEl\)\.call\(canvasDragBehavior\);/,
    'Expected zoom to be .call()ed before drag on the canvas element.'
  );
});

test('index.html no longer attaches a raw mousedown listener for canvas node-dragging', () => {
  assert.doesNotMatch(
    html,
    /canvasEl\.addEventListener\('mousedown'/,
    'The old mousedown/mousemove/mouseup drag implementation should be replaced by d3.drag().'
  );
});

test('index.html inline zoomFilterAllowsPointerdown matches the canonical module behavior', () => {
  const factory = new Function(
    'hitTestNode', 'canvasEl',
    extract('zoomFilterAllowsPointerdown') + '\n; return zoomFilterAllowsPointerdown;'
  );
  // The inline copy closes over hitTestNode and canvasEl as free variables
  // (defined elsewhere in the page's module scope) -- inject the
  // canonical implementation and a getBoundingClientRect-only mock so
  // this test exercises the inline logic in isolation.
  const mockCanvasEl = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const inlineFn = factory(hitTestNode, mockCanvasEl);
  const nodes = [{ id: 'A', x: 100, y: 100 }];
  const qt = buildNodeQuadtree(d3.quadtree, nodes);
  const toWorld = (x, y) => [x, y];
  assert.equal(inlineFn({ type: 'wheel' }, qt, toWorld, 40), true);
  assert.equal(inlineFn({ type: 'mousedown', clientX: 101, clientY: 99 }, qt, toWorld, 40), false);
  assert.equal(inlineFn({ type: 'mousedown', clientX: 9000, clientY: 9000 }, qt, toWorld, 40), true);
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

test('index.html renderGraphSvg and renderGraphCanvas both call runLayoutWithPositionCache (not a bare runSyncForceLayout call)', () => {
  const svgFn = extract('renderGraphSvg');
  const canvasFn = extract('renderGraphCanvas');
  assert.match(svgFn, /runLayoutWithPositionCache\(simulation, nodes\)/);
  assert.match(canvasFn, /runLayoutWithPositionCache\(simulation, nodes\)/);
});

// ---------------------------------------------------------------------
// Regression: document-level click-outside listener must not fight the
// canvas renderer's own open/close logic.
//
// Bug found while manually verifying Bug A's fix (d3.drag/zoom.filter):
// handleCanvasPick() already opens the card on a node hit and closes it
// on an empty-canvas miss (both via #graph-canvas's own click listener,
// which fires before document-level listeners during bubbling). A
// second, older document-level click listener unconditionally called
// closeNodeCard() whenever e.target === the canvas element -- true for
// EVERY canvas click, hit or miss -- which immediately closed the card
// handleCanvasPick had just opened on the same click. This was invisible
// before Bug A was fixed because clicks never reached handleCanvasPick
// in the first place (canvas always started a pan instead).
// ---------------------------------------------------------------------
test('index.html document click-outside listener does not act on canvas clicks (handleCanvasPick already owns open/close for canvas)', () => {
  const start = html.indexOf("document.addEventListener('click', e => {\n      if (!nodeCardState.node) return;");
  assert.ok(start >= 0, 'Expected to find the click-outside-closes-card document listener');
  const end = html.indexOf('\n    });', start) + '\n    });'.length;
  const listenerSrc = html.slice(start, end);

  // Must still close the card for the SVG renderer's empty-background click.
  assert.match(listenerSrc, /RENDERER !== 'canvas'[\s\S]*?closeNodeCard\(\)/);

  // Must NOT reference the canvas element / RENDERER === 'canvas' branch
  // that used to unconditionally close the card on every canvas click.
  assert.doesNotMatch(listenerSrc, /RENDERER === 'canvas'/);
  assert.doesNotMatch(listenerSrc, /getElementById\('graph-canvas'\)/);
});

test('index.html handleCanvasPick is the sole owner of open/close for canvas clicks (opens on hit, closes on miss)', () => {
  const fn = extract('handleCanvasPick');
  assert.match(fn, /if \(!found\) \{\s*\n\s*if \(nodeCardState\.node\) closeNodeCard\(\);/);
  assert.match(fn, /openCanvasNodeCard\(found\)/);
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
