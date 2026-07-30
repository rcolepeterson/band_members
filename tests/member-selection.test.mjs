// Tests for PR E: clicking a band member highlights that member's bands,
// opens their card, and never moves the camera.
//
// Source of the behavior: tester feedback (Matt Ashman) -- "I don't expect
// clicking on a band member to change the graph view. Only clicking on a band
// should do that." -- and the project owner's answer: "Highlight the member's
// bands but don't recenter and open that member's card."
//
// Two layers here, because index.html is a classic (non-module) script that
// node --test cannot import:
//
//  1. BEHAVIORAL. The selection block is sliced out of index.html and run
//     inside node:vm against fake d3 selections and spies. These are real
//     executions of the shipped source, so they catch logic bugs, not just
//     renamed identifiers.
//  2. STRUCTURAL. Substring/regex assertions in the style of edit-ui.test.mjs
//     for the wiring and CSS that lives outside the sliced block.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// -----------------------------------------------------------------------
// Harness: slice the member-selection block and run it with fake d3.
// -----------------------------------------------------------------------

const BLOCK_START = "const MEMBER_HIGHLIGHT_CLASS = 'member-highlight';";
const BLOCK_END = 'if (nodeCardCloseBtn) nodeCardCloseBtn.addEventListener';

function sliceSelectionBlock() {
  const start = INDEX_HTML.indexOf(BLOCK_START);
  assert.ok(start > 0, `Expected to find "${BLOCK_START}" in index.html.`);
  const end = INDEX_HTML.indexOf(BLOCK_END, start);
  assert.ok(end > start, `Expected to find "${BLOCK_END}" after the selection block.`);
  return INDEX_HTML.slice(start, end);
}

// The block is heavily commented and the comments name the very functions
// these tests assert are never *called*, so strip them before searching.
function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, '');
}

// A stand-in for the handful of d3 selection methods the block uses:
// selectAll(sel).data() and selectAll(sel).classed(name, valueOrFn).
function makeFakeGraphGroup(nodes, links) {
  const elements = [
    ...nodes.map(datum => ({ tag: 'g', base: `node ${datum.type}`, datum, classes: new Set() })),
    ...links.map(datum => ({ tag: 'line', base: 'link', datum, classes: new Set() })),
  ];

  const matches = (el, selector) => {
    const parts = selector.split('.').filter(Boolean);
    const tag = selector.startsWith('.') ? null : parts.shift();
    if (tag && el.tag !== tag) return false;
    const own = new Set([...el.base.split(' '), ...el.classes]);
    return parts.every(cls => own.has(cls));
  };

  return {
    elements,
    selectAll(selector) {
      const hits = elements.filter(el => matches(el, selector));
      return {
        data: () => hits.map(el => el.datum),
        classed(name, value) {
          hits.forEach(el => {
            const on = typeof value === 'function' ? value(el.datum) : value;
            if (on) el.classes.add(name);
            else el.classes.delete(name);
          });
          return this;
        },
      };
    },
    highlighted(tag) {
      return elements
        .filter(el => el.classes.has('member-highlight') && (!tag || el.tag === tag))
        .map(el => el.datum);
    },
  };
}

// Graph fixture. Kurt is in two bands; one membership is written
// person -> band on purpose, to prove the direction-agnostic lookup. Dave is
// in a band that the "active filter" has excluded from the rendered set.
function makeFixture({ rendered = 'all' } = {}) {
  const masterNodes = [
    { id: 'Nirvana', type: 'band' },
    { id: 'Foo Fighters', type: 'band' },
    { id: 'Mudhoney', type: 'band' },
    { id: 'Kurt Cobain', type: 'person' },
    { id: 'Dave Grohl', type: 'person' },
    { id: 'Mark Arm', type: 'person' },
  ];
  const masterLinks = [
    { source: 'Nirvana', target: 'Kurt Cobain' },
    // Reversed on purpose: person is the link source here.
    { source: 'Kurt Cobain', target: 'Mudhoney' },
    { source: 'Nirvana', target: 'Dave Grohl' },
    { source: 'Foo Fighters', target: 'Dave Grohl' },
    { source: 'Mudhoney', target: 'Mark Arm' },
  ];

  // renderGraph() copies the filtered arrays and the simulation writes x/y
  // onto the copies; only the rendered copies carry coordinates.
  let nodes = masterNodes.map((d, i) => ({ ...d, x: 100 + i * 10, y: 200 + i * 10 }));
  let links = masterLinks.map(d => ({ ...d }));
  if (rendered === 'no-foo-fighters') {
    nodes = nodes.filter(d => d.id !== 'Foo Fighters');
    links = links.filter(d => d.source !== 'Foo Fighters' && d.target !== 'Foo Fighters');
  }

  return {
    master: { nodes: masterNodes, links: masterLinks },
    nodes,
    links,
  };
}

function loadSelection(options = {}) {
  const fixture = makeFixture(options);
  const graphGroup = makeFakeGraphGroup(fixture.nodes, fixture.links);
  const calls = { updateSelection: [], openNodeCard: [], cameraMoves: [] };

  const sandbox = {
    graphGroup,
    graphState: { master: fixture.master },
    updateSelection: (...args) => calls.updateSelection.push(args),
    openNodeCard: node => calls.openNodeCard.push(node),
    getNodeConnections: nodeId => fixture.master.links
      .filter(l => l.source === nodeId || l.target === nodeId)
      .map(l => (l.source === nodeId ? l.target : l.source)),
    // Every camera-moving entry point in index.html, wired to a spy. If the
    // selection path ever reaches for one of these, the test fails.
    fitGraph: (...args) => calls.cameraMoves.push(['fitGraph', ...args]),
    zoomBehavior: { transform: (...args) => calls.cameraMoves.push(['zoomBehavior.transform', ...args]) },
    svgSelection: {
      transition: () => { calls.cameraMoves.push(['svgSelection.transition']); return sandbox.svgSelection; },
      duration: () => sandbox.svgSelection,
      call: () => sandbox.svgSelection,
      attr: () => sandbox.svgSelection,
      node: () => ({}),
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(sliceSelectionBlock(), sandbox);
  return { ...sandbox, fixture, graphGroup, calls };
}

// -----------------------------------------------------------------------
// 1. Musician click: card + highlight, no camera move.
// -----------------------------------------------------------------------

test('clicking a musician opens that musician\'s card', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });

  assert.equal(env.calls.openNodeCard.length, 1, 'Expected exactly one card open.');
  assert.equal(env.calls.openNodeCard[0].id, 'Kurt Cobain');
  assert.equal(env.calls.updateSelection.length, 1, 'Expected the detail panel to be updated too.');
});

test('clicking a musician highlights their bands and the connecting links', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });

  const bands = env.graphGroup.highlighted('g').map(d => d.id).sort();
  assert.deepEqual(bands, ['Mudhoney', 'Nirvana'], 'Expected both of Kurt\'s bands to glow.');

  const highlightedLinks = env.graphGroup.highlighted('line');
  assert.equal(highlightedLinks.length, 2, 'Expected both membership links to glow.');
  highlightedLinks.forEach(link => {
    assert.ok(
      link.source === 'Kurt Cobain' || link.target === 'Kurt Cobain',
      'Only links touching the selected musician should be highlighted.'
    );
  });
});

test('highlighting is direction-agnostic (person may be the link source)', () => {
  const env = loadSelection();
  // Mudhoney is linked as Kurt -> Mudhoney, the reverse of the CSV pipeline's
  // band -> person convention. A source-only lookup would silently miss it.
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });

  assert.ok(
    env.graphGroup.highlighted('g').some(d => d.id === 'Mudhoney'),
    'Expected a person-as-source membership to still highlight the band.'
  );
});

test('clicking a musician highlights bands only, never other musicians', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });

  const nonBands = env.graphGroup.highlighted('g').filter(d => d.type !== 'band');
  assert.deepEqual(nonBands, [], 'Only band nodes should carry the highlight class.');
});

test('clicking a musician does NOT move the camera', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });

  assert.deepEqual(
    env.calls.cameraMoves,
    [],
    'Selecting a musician must not pan, zoom, or refit — see Matt Ashman\'s feedback.'
  );
});

test('musician selection resolves to the rendered node so the card anchors to it', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });

  const anchored = env.calls.openNodeCard[0];
  assert.ok(
    Number.isFinite(anchored.x) && Number.isFinite(anchored.y),
    'Expected the card to be anchored to the node object carrying live x/y.'
  );
});

// -----------------------------------------------------------------------
// 2. Member chip == graph click.
// -----------------------------------------------------------------------

test('a member chip click produces the same result as a graph click', () => {
  const fromGraph = loadSelection();
  fromGraph.selectGraphNode('Kurt Cobain', { source: 'graph' });

  // A chip passes the master node object (no x/y) rather than an id, which is
  // exactly what renderBandMemberButtons / appendTenureChip hand over.
  const fromChip = loadSelection();
  const masterNode = fromChip.fixture.master.nodes.find(n => n.id === 'Kurt Cobain');
  fromChip.selectMemberNode(masterNode, { source: 'chip' });

  assert.deepEqual(
    fromChip.graphGroup.highlighted('g').map(d => d.id).sort(),
    fromGraph.graphGroup.highlighted('g').map(d => d.id).sort(),
    'Chip and graph clicks must highlight the same bands.'
  );
  assert.equal(fromChip.calls.openNodeCard.length, 1, 'A chip click must open the card too.');
  assert.equal(
    fromChip.calls.openNodeCard[0].id,
    fromGraph.calls.openNodeCard[0].id,
    'Chip and graph clicks must open the same card.'
  );
  assert.deepEqual(fromChip.calls.cameraMoves, [], 'A chip click must not move the camera either.');
});

test('selectMemberNode refuses band nodes so chips cannot cross-wire', () => {
  const env = loadSelection();
  assert.equal(env.selectMemberNode('Nirvana', { source: 'chip' }), null);
  assert.deepEqual(env.calls.openNodeCard, [], 'A band must not be opened through the musician path.');
});

// -----------------------------------------------------------------------
// 3. Band click: unchanged, and it clears the highlight.
// -----------------------------------------------------------------------

test('clicking a band opens its card and does not highlight (behavior unchanged)', () => {
  const env = loadSelection();
  env.selectGraphNode('Nirvana', { source: 'graph' });

  assert.equal(env.calls.openNodeCard.length, 1);
  assert.equal(env.calls.openNodeCard[0].id, 'Nirvana');
  assert.deepEqual(env.graphGroup.highlighted(), [], 'A band click adds no member highlight.');
});

test('clicking a band still passes its member list to the detail panel', () => {
  const env = loadSelection();
  env.selectGraphNode('Nirvana', { source: 'graph' });

  const [, , linkedNames, members] = env.calls.updateSelection[0];
  // Array.from re-homes the vm realm's arrays into this one so deepEqual can
  // compare them (cross-realm arrays are never reference-equal by prototype).
  assert.deepEqual(Array.from(members, m => m.id).sort(), ['Dave Grohl', 'Kurt Cobain']);
  assert.deepEqual(Array.from(linkedNames).sort(), ['Dave Grohl', 'Kurt Cobain']);
});

test('clicking a band clears a musician highlight left over from before', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });
  assert.ok(env.graphGroup.highlighted().length > 0, 'Precondition: something is highlighted.');

  env.selectGraphNode('Nirvana', { source: 'graph' });
  assert.deepEqual(env.graphGroup.highlighted(), [], 'Expected the band click to clear the highlight.');
});

test('selecting a different musician replaces the previous highlight', () => {
  const env = loadSelection();
  env.selectGraphNode('Kurt Cobain', { source: 'graph' });
  env.selectGraphNode('Mark Arm', { source: 'graph' });

  assert.deepEqual(
    env.graphGroup.highlighted('g').map(d => d.id),
    ['Mudhoney'],
    'Expected only the newly selected musician\'s bands to glow.'
  );
});

test('clearMemberHighlight removes every highlight class', () => {
  const env = loadSelection();
  env.selectGraphNode('Dave Grohl', { source: 'graph' });
  assert.ok(env.graphGroup.highlighted().length > 0, 'Precondition: something is highlighted.');

  env.clearMemberHighlight();
  assert.deepEqual(env.graphGroup.highlighted(), []);
});

// -----------------------------------------------------------------------
// 4. Active filters.
// -----------------------------------------------------------------------

test('highlighting only ever glows bands present in the filtered render', () => {
  // Foo Fighters is filtered out of the rendered set but still in master.
  const env = loadSelection({ rendered: 'no-foo-fighters' });
  env.selectGraphNode('Dave Grohl', { source: 'graph' });

  assert.deepEqual(
    env.graphGroup.highlighted('g').map(d => d.id),
    ['Nirvana'],
    'A band excluded by the active filter must not be highlighted.'
  );
});

test('member selection still works when the member is filtered out of the view', () => {
  const env = loadSelection({ rendered: 'no-foo-fighters' });
  const masterNode = env.fixture.master.nodes.find(n => n.id === 'Foo Fighters');
  // Reverse case: a chip for a node the filter removed. It must still open a
  // card (falling back to the master node) rather than throwing or no-oping.
  const result = env.selectBandNode(masterNode, { source: 'chip' });

  assert.ok(result, 'Expected a filtered-out node to still resolve.');
  assert.equal(env.calls.openNodeCard.length, 1);
  assert.deepEqual(env.calls.cameraMoves, []);
});

// -----------------------------------------------------------------------
// 5. Structural: wiring, duplicate removal, CSS, clearing conditions.
// -----------------------------------------------------------------------

function countDefinitions(name) {
  const pattern = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
  return (INDEX_HTML.match(pattern) || []).length;
}

test('renderBandMemberButtons is defined exactly once', () => {
  assert.equal(
    countDefinitions('renderBandMemberButtons'),
    1,
    'renderBandMemberButtons was defined twice identically; only one definition may remain.'
  );
});

test('the other functions that shipped duplicated are each defined once', () => {
  // These sat in the same copy-pasted block as renderBandMemberButtons. The
  // second updateSelection was the one that actually won at runtime, and it
  // dropped the linkedNames / bandMembers arguments its caller passed.
  ['updateSelection', 'renderConnectionChips', 'getBandMembers'].forEach(name => {
    assert.equal(countDefinitions(name), 1, `Expected exactly one definition of ${name}.`);
  });
});

test('the surviving updateSelection accepts the arguments its callers pass', () => {
  assert.ok(
    INDEX_HTML.includes('function updateSelection(node, degree = 0, linkedNames = null, bandMembers = null)'),
    'Expected the four-parameter updateSelection (the one that honors its caller) to be the survivor.'
  );
});

test('the graph node click handler delegates to the unified selection function', () => {
  assert.ok(
    /node\.on\('click',\s*\(_, d\)\s*=>\s*selectGraphNode\(d,\s*\{\s*source:\s*'graph'\s*\}\)\)/.test(INDEX_HTML),
    'Expected the D3 node click handler to be a single delegation to selectGraphNode.'
  );
});

test('both member-chip renderers route through selectMemberNode', () => {
  const chipCalls = (INDEX_HTML.match(/selectMemberNode\(person, \{ source: 'chip' \}\)/g) || []).length;
  assert.equal(
    chipCalls,
    2,
    'Expected both the detail-panel member chips and the node-card member chips to call selectMemberNode.'
  );
});

test('band chips inside a musician card route through selectBandNode', () => {
  assert.ok(
    INDEX_HTML.includes("selectBandNode(band, { source: 'chip' })"),
    'Expected the node card\'s band chips to go through selectBandNode so the highlight clears.'
  );
});

test('no selection path calls a camera-moving function', () => {
  const code = stripLineComments(sliceSelectionBlock());
  ['fitGraph', 'zoomBehavior', 'zoomIdentity', '.transition('].forEach(needle => {
    assert.ok(
      !code.includes(needle),
      `The member-selection block must not reference ${needle} — selecting a member never moves the camera.`
    );
  });
});

test('fitGraph is only reachable from render and the explicit Fit action', () => {
  // Guards the regression Matt Ashman reported: a selection must never end up
  // calling the refit. Every call site is enumerated here on purpose, so
  // adding one to a click path forces this test to be revisited.
  const callSites = (INDEX_HTML.match(/^\s*(?:setTimeout\(\(\) => )?fitGraph\(\d/gm) || []).length;
  assert.equal(
    callSites,
    3,
    'Expected exactly 3 fitGraph() calls: renderGraph\'s tail, the Fit chip, and the post-load settle.'
  );
});

test('closing the node card clears the member highlight', () => {
  const idx = INDEX_HTML.indexOf('function closeNodeCard()');
  assert.ok(idx > 0, 'Expected closeNodeCard to exist.');
  const body = INDEX_HTML.slice(idx, INDEX_HTML.indexOf('\n    }', idx));
  assert.ok(
    body.includes('clearMemberHighlight()'),
    'closeNodeCard must clear the highlight — that is what makes Escape, the X button, and the '
      + 'empty-space click all clear it.'
  );
});

test('Escape and empty-space clicks reach closeNodeCard', () => {
  assert.ok(
    /if \(e\.key === 'Escape' && nodeCardState\.node\) closeNodeCard\(\)/.test(INDEX_HTML),
    'Expected Escape to close the card (and therefore clear the highlight).'
  );
  assert.ok(
    /if \(e\.target === svg\) closeNodeCard\(\)/.test(INDEX_HTML),
    'Expected a bare-SVG background click to close the card (and therefore clear the highlight).'
  );
});

test('the Clear / Reset view action tears the highlight down via renderGraph', () => {
  // Reset view (PR B) and the existing Clear chip both end in renderGraph(),
  // which closes the card (clearing the highlight) and rebuilds the SVG.
  const idx = INDEX_HTML.indexOf("if (chip.dataset.action === 'clear')");
  assert.ok(idx > 0, 'Expected the Clear action branch to exist.');
  const branch = INDEX_HTML.slice(idx, idx + 700);
  assert.ok(branch.includes('renderGraph();'), 'Expected the Clear action to re-render.');

  const renderIdx = INDEX_HTML.indexOf('function renderGraph()');
  const renderHead = INDEX_HTML.slice(renderIdx, renderIdx + 900);
  assert.ok(
    renderHead.includes('closeNodeCard()'),
    'renderGraph must close the card, which is what clears the highlight on Reset view.'
  );
});

// -----------------------------------------------------------------------
// 6. Structural: highlight styling.
// -----------------------------------------------------------------------

test('the highlight is styled by CSS class, not by re-rendering', () => {
  assert.ok(
    INDEX_HTML.includes('.node.member-highlight .node-core'),
    'Expected a CSS rule for highlighted band nodes.'
  );
  assert.ok(
    INDEX_HTML.includes('.link.member-highlight'),
    'Expected a CSS rule for highlighted membership links.'
  );
  const code = stripLineComments(sliceSelectionBlock());
  assert.ok(
    !code.includes('renderGraph(') && !code.includes('simulation'),
    'Highlighting must not re-render or reheat the simulation (PR #65 performance strategy).'
  );
  const block = sliceSelectionBlock();
  assert.ok(
    block.includes('.classed(MEMBER_HIGHLIGHT_CLASS'),
    'Expected the highlight to be applied with a d3 class toggle.'
  );
});

test('the highlight color is distinct from verified-band silver and selection cyan', () => {
  const idx = INDEX_HTML.indexOf('.node.member-highlight .node-core');
  const rules = INDEX_HTML.slice(idx, idx + 400).toLowerCase();
  assert.ok(rules.includes('#ffb454'), 'Expected the amber highlight color #ffb454.');
  assert.ok(!rules.includes('#c0c0c0'), 'The highlight must not reuse the verification star\'s silver.');
  assert.ok(!rules.includes('#8fe8f6'), 'The highlight must not reuse the selection/band cyan.');
});
