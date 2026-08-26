// Regression tests for the destructive-wipe bug in renderGraph().
//
// Source: beta tester Matt Ashman -- "when clicking on certain people nodes,
// the graph can disappear in some cases."
//
// `graphGroup.selectAll('*').remove()` is the only code path in index.html
// that can blank #graph-svg. It used to run BEFORE renderGraph()'s early
// returns, so any render that bailed (empty filtered node set, or a throw
// while measuring the stage) erased the graph with nothing left to repaint.
// These tests pin the fixed ordering: every early return is now
// non-destructive, and the wipe is the last statement before the first
// append.
//
// The real renderGraph() source is extracted from index.html by
// brace-matching and executed against stubs -- same convention as
// tests/graph-render-helpers.test.mjs and tests/graph-merge.test.mjs -- so
// these assertions exercise the exact code the browser runs rather than a
// copy that could drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8'
);

// Pull a top-level `function NAME(...) { ... }` out of index.html by matching
// balanced braces from the function's opening brace.
function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found in index.html`);
  let depth = 0;
  let j = html.indexOf('{', start);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return html.slice(start, j);
}

const RENDER_GRAPH_SRC = extract('renderGraph');
// Comment-free view, so structural assertions can't be satisfied (or broken)
// by prose that merely mentions the code being asserted about.
const RENDER_GRAPH_CODE = RENDER_GRAPH_SRC.replace(/^\s*\/\/.*$/gm, '');

// Every free identifier renderGraph() reads before its first append. Passing
// them as function parameters shadows the globals, so the extracted source
// runs unmodified outside a browser.
const DEPS = [
  'graphState', 'svgSelection', 'graphGroup', 'closeNodeCard', 'nodeCardState',
  'getFilteredGraph', 'metricNodes', 'metricLinks', 'metricScenes', 'locationKey',
  'graphTotalChip', 'currentScene', 'currentGenre', 'currentSearch',
  'graphBadge', 'noteLeft', 'document', 'console',
  // The Recently-added filter and the "No Rawk Found" empty state both read
  // free identifiers above the early returns. Omitting any of them makes
  // renderGraph throw a ReferenceError before reaching the code under test.
  'recentOnly', 'describeRecentSelection', 'selectRecentBandIds',
  'syncSearchEmptyState',
];

// A stand-in for the d3 selection wrapping the <g> that holds the painted
// graph. `children` is the thing under test: it must survive a bailed render.
function makeGraphGroup(initialChildren) {
  const group = {
    children: initialChildren.slice(),
    selectAll(selector) {
      return {
        remove() { if (selector === '*') group.children.length = 0; },
        data() { return this; },
        join() { return this; },
      };
    },
    append() { group.children.push('appended'); return group; },
    attr() { return group; },
  };
  return group;
}

function runRenderGraph({
  nodes = [],
  links = [],
  stage = { width: 1200, height: 800 },
  graphGroup,
  // Real boot: setupSvgRenderer() runs only off the Sigma path (see 53fe918),
  // so svgSelection is null on the constellation and non-null on ?renderer=svg.
  svgSelection = { attr() { return this; } },
  sigmaBoot = false,
} = {}) {
  const warnings = [];
  const textSink = () => ({ textContent: '' });
  const metricNodes = textSink();
  const graphBadge = textSink();
  const env = {
    graphState: { master: { nodes: [], links: [] } },
    svgSelection,
    graphGroup,
    closeNodeCard: () => {},
    nodeCardState: { node: null },
    getFilteredGraph: () => ({ nodes, links }),
    metricNodes,
    metricLinks: textSink(),
    metricScenes: textSink(),
    locationKey: () => '',
    graphTotalChip: textSink(),
    currentScene: 'all',
    currentGenre: 'all',
    currentSearch: '',
    graphBadge,
    noteLeft: textSink(),
    recentOnly: false,
    describeRecentSelection: () => '',
    selectRecentBandIds: () => [],
    syncSearchEmptyState: () => {},
    // syncFilterBtn and the scene-label lookup both null-check their reads.
    document: {
      // Absent by default (sigmaBoot: false), matching every pre-existing
      // test here: `document.body && ...` is falsy, so those tests keep
      // running the SVG-drawing tail exactly as before.
      body: sigmaBoot ? { classList: { contains: cls => cls === 'rbft-sigma-boot' } } : undefined,
      getElementById: () => null,
      querySelector: () => (stage ? { getBoundingClientRect: () => stage } : null),
    },
    console: { warn: (...args) => warnings.push(args) },
  };
  const factory = new Function(...DEPS, `return (${RENDER_GRAPH_SRC});`);
  factory(...DEPS.map(name => env[name]))();
  return { warnings, metricNodes, graphBadge };
}

// ---------------------------------------------------------------------
// The bug: a bailed render must not erase the painted graph.
// ---------------------------------------------------------------------

test('renderGraph with an empty node set leaves the existing SVG contents intact', () => {
  const graphGroup = makeGraphGroup(['node-a', 'node-b', 'link-layer']);
  runRenderGraph({ nodes: [], links: [], graphGroup });
  assert.deepEqual(
    graphGroup.children,
    ['node-a', 'node-b', 'link-layer'],
    'An empty filtered node set must return without wiping the already-painted graph.'
  );
});

test('renderGraph warns (with the active filter state) when it bails on an empty node set', () => {
  const graphGroup = makeGraphGroup(['node-a']);
  const { warnings } = runRenderGraph({ nodes: [], links: [], graphGroup });
  assert.equal(warnings.length, 1, 'Expected exactly one console.warn on the empty-node bail.');
  const [message, context] = warnings[0];
  assert.match(String(message), /no nodes after filtering/i);
  assert.deepEqual(
    Object.keys(context).sort(),
    ['genre', 'recentOnly', 'scene', 'search'],
    'The warn payload must carry the filter combination so a tester can report it back. ' +
      'The retired per-type `filter` was replaced by `recentOnly` — see ' +
      'tests/toolbar-ui-cleanup.test.mjs, which forbids reading currentFilter at all.'
  );
});

test('renderGraph leaves the SVG intact when .graph-stage cannot be found', () => {
  const graphGroup = makeGraphGroup(['node-a', 'node-b']);
  const { warnings } = runRenderGraph({
    nodes: [{ id: 'Band A', type: 'band' }],
    links: [],
    stage: null,
    graphGroup,
  });
  assert.deepEqual(
    graphGroup.children,
    ['node-a', 'node-b'],
    'A missing .graph-stage must bail without wiping (it used to throw AFTER the wipe).'
  );
  assert.equal(warnings.length, 1, 'Expected a console.warn when the stage is missing.');
  assert.match(String(warnings[0][0]), /graph-stage is missing/i);
});

// ---------------------------------------------------------------------
// Structural guards: keep the wipe below every early return, and keep the
// unreachable measurement check deleted.
// ---------------------------------------------------------------------

test('the SVG wipe sits below every early return in renderGraph', () => {
  const wipeIdx = RENDER_GRAPH_CODE.indexOf("graphGroup.selectAll('*').remove()");
  assert.ok(wipeIdx > 0, "Expected the graphGroup.selectAll('*').remove() wipe in renderGraph.");

  const emptyNodesIdx = RENDER_GRAPH_CODE.indexOf('if (!nodes.length)');
  assert.ok(emptyNodesIdx > 0, 'Expected the empty-node early return in renderGraph.');
  assert.ok(
    emptyNodesIdx < wipeIdx,
    'The empty-node early return must come BEFORE the wipe, or a bailed render blanks the graph.'
  );

  const stageGuardIdx = RENDER_GRAPH_CODE.indexOf('if (!stage)');
  assert.ok(stageGuardIdx > 0, 'Expected a null guard on the .graph-stage lookup.');
  assert.ok(
    stageGuardIdx < wipeIdx,
    'The stage measurement (and its guard) must happen BEFORE the wipe.'
  );
});

// ---------------------------------------------------------------------
// The scene/genre/search regression: svgSelection stays null forever on the
// constellation (setupSvgRenderer() only runs off the Sigma path, see
// 53fe918), so gating the WHOLE function on it silently broke every Scene,
// Genre, Recently-added, and search change for every visitor on the default
// renderer -- the initial graph looked fine because it never goes through
// renderGraph() at all. Reported live by a beta tester.
// ---------------------------------------------------------------------

test('renderGraph still filters and updates chrome when svgSelection was never set up (Sigma boot)', () => {
  const graphGroup = makeGraphGroup(['stale-svg-node']);
  const { metricNodes, graphBadge } = runRenderGraph({
    nodes: [{ id: 'Band A', type: 'band' }],
    links: [],
    graphGroup,
    svgSelection: null,
    sigmaBoot: true,
  });
  assert.equal(metricNodes.textContent, 1, 'metrics must update even without an SVG renderer');
  assert.equal(graphBadge.textContent, 'Full graph', 'chrome must update even without an SVG renderer');
  // And it must still stop before touching the (nonexistent) SVG.
  assert.deepEqual(
    graphGroup.children,
    ['stale-svg-node'],
    'must not attempt to draw into the SVG on the Sigma path'
  );
});

test('the top-level guard no longer bails the whole function on a missing svgSelection', () => {
  assert.doesNotMatch(
    RENDER_GRAPH_CODE,
    /if \(!graphState \|\| !svgSelection\) return;/,
    'svgSelection must not gate the whole function -- the Sigma path never sets it up, ' +
      'so this silently broke every filter and search change on the default renderer.'
  );
  assert.match(
    RENDER_GRAPH_CODE,
    /if \(!graphState\) return;/,
    'graphState is still a legitimate "not loaded yet" guard.'
  );
});

// A node tap on mobile must land on the same handler as a desktop click --
// otherwise the disappearance investigation above only covers one platform.
test('graph nodes have exactly one click handler and no touch/pointer variant', () => {
  const clickHandlers = html.match(/node\.on\('click',/g) || [];
  assert.equal(
    clickHandlers.length,
    1,
    'Expected exactly one node click handler, so mobile taps and desktop clicks share a code path.'
  );
  ['touchstart', 'touchend', 'pointerdown', 'pointerup'].forEach(event => {
    assert.ok(
      !html.includes(`'${event}'`) && !html.includes(`"${event}"`),
      `Found a ${event} handler -- graph node interaction must stay on the single click path for mobile parity.`
    );
  });
});

test('the unreachable degenerate-measurement check is gone from renderGraph', () => {
  assert.ok(
    !/width\s*<\s*50\s*\|\|\s*height\s*<\s*50/.test(RENDER_GRAPH_CODE),
    'The `width < 50 || height < 50` bail is unreachable (both are Math.max-clamped to 420/520) and must stay deleted.'
  );
  assert.match(
    RENDER_GRAPH_CODE,
    /Math\.max\(rect\.width,\s*420\)/,
    'Expected the 420 width clamp that makes the deleted check unreachable.'
  );
  assert.match(
    RENDER_GRAPH_CODE,
    /Math\.max\(rect\.height,\s*520\)/,
    'Expected the 520 height clamp that makes the deleted check unreachable.'
  );
});
