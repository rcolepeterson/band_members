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
