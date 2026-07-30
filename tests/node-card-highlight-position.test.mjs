// Node-card placement while a member highlight is active.
//
// Tester feedback after #68-#75 (project owner, test case: Duff McKagan):
// clicking a musician glows the bands they played in with amber #ffb454
// connection lines (PR E / #72), but the card opens anchored directly over
// the source node -- so the amber lines run underneath the card and are
// hidden by the very panel that is supposed to explain them.
//
// The fix moves the card rather than making it transparent or re-stacking
// the edges above it: the card is dense text on a near-opaque panel, and
// dropping its contrast to reveal lines behind it just trades an obscured
// highlight for an unreadable card. When a highlight is active the card
// docks to whichever stage corner covers the least of it.
//
// These tests run the REAL inline code from index.html (extracted by
// brace-matching and evaluated in a vm sandbox), same approach as
// tests/graph-layout-settle.test.mjs and tests/member-selection.test.mjs --
// the runner is `node --test` with no browser, so the DOM/d3 surface
// positionNodeCard() touches is stubbed rather than emulated.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// Pull a top-level `function NAME(...) { ... }` out of index.html. Skips the
// parameter list by paren-matching first so destructured options arguments
// (`{ stageW, stageH }`) don't terminate the brace scan early.
function extract(name) {
  const start = INDEX_HTML.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found in index.html`);

  let parens = 0;
  let i = INDEX_HTML.indexOf('(', start);
  for (; i < INDEX_HTML.length; i++) {
    if (INDEX_HTML[i] === '(') parens++;
    else if (INDEX_HTML[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }

  let depth = 0;
  let j = INDEX_HTML.indexOf('{', i);
  for (; j < INDEX_HTML.length; j++) {
    if (INDEX_HTML[j] === '{') depth++;
    else if (INDEX_HTML[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return INDEX_HTML.slice(start, j);
}

function extractConst(name) {
  const match = INDEX_HTML.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(match, `const ${name} not found in index.html`);
  return match[0];
}

// Comments in this file explain the call order they enforce, so an
// indexOf-based ordering check has to look at code only.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Objects built inside the vm realm have a different Object.prototype, which
// assert.deepEqual treats as a mismatch. Re-home them before comparing.
function plain(obj) {
  return obj === null || obj === undefined ? obj : { ...obj };
}

const STAGE_W = 1440;
const STAGE_H = 900;
const CARD_W = 300;
const CARD_H = 180;

// Builds a runnable copy of the real placement code with the DOM, d3 and
// graph-selection surface stubbed. `highlighted` is the band node data that
// would be carrying the member-highlight class in the live SVG.
function loadPlacement({
  node = { id: 'Duff McKagan', type: 'person', x: 700, y: 440 },
  highlighted = [],
  stageW = STAGE_W,
  stageH = STAGE_H,
  cardW = CARD_W,
  cardH = CARD_H,
  mobile = false,
} = {}) {
  const nodeCardEl = {
    hidden: false,
    offsetWidth: cardW,
    offsetHeight: cardH,
    style: {},
    classes: new Set(),
    classList: {
      toggle(name, on) {
        if (on) nodeCardEl.classes.add(name);
        else nodeCardEl.classes.delete(name);
      },
    },
  };

  const sandbox = {
    MEMBER_HIGHLIGHT_CLASS: 'member-highlight',
    nodeCardEl,
    nodeCardState: { node },
    svgSelection: { node: () => ({}) },
    // Only the highlighted-node query matters here; anything else returns
    // an empty data set.
    graphGroup: {
      selectAll: selector => ({
        data: () => (selector.includes('member-highlight') ? highlighted : []),
      }),
    },
    // Identity zoom transform: graph coords == screen coords, which keeps
    // the geometry assertions readable.
    d3: { zoomTransform: () => ({ applyX: x => x, applyY: y => y }) },
    document: {
      querySelector: () => ({
        getBoundingClientRect: () => ({ width: stageW, height: stageH }),
      }),
    },
    window: { matchMedia: () => ({ matches: mobile }) },
  };

  const src = `
    ${extractConst('NODE_CARD_ANCHOR_OFFSET')}
    ${extractConst('NODE_CARD_SOURCE_CLEARANCE')}
    ${extract('rectOverlapArea')}
    ${extract('nodeCardBox')}
    ${extract('nodeCardDockPlacements')}
    ${extract('chooseNodeCardDock')}
    ${extract('memberHighlightExtent')}
    ${extract('positionNodeCard')}
  `;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  vm.runInContext('this.__api = { positionNodeCard, memberHighlightExtent, chooseNodeCardDock, nodeCardBox, rectOverlapArea, nodeCardDockPlacements, NODE_CARD_ANCHOR_OFFSET, NODE_CARD_SOURCE_CLEARANCE };', sandbox);

  return { ...sandbox.__api, nodeCardEl, node, stageW, stageH, cardW, cardH };
}

// The card's rendered box from what positionNodeCard() wrote to the element.
function renderedCardBox(env) {
  const left = parseFloat(env.nodeCardEl.style.left);
  const top = parseFloat(env.nodeCardEl.style.top);
  assert.ok(Number.isFinite(left) && Number.isFinite(top), 'Expected the card to be positioned.');
  return env.nodeCardBox(left, top, env.nodeCardEl.classes.has('node-card--below'), env.cardW, env.cardH);
}

function sourceClearanceBox(env) {
  const pad = env.NODE_CARD_SOURCE_CLEARANCE;
  return {
    x0: env.node.x - pad, y0: env.node.y - pad,
    x1: env.node.x + pad, y1: env.node.y + pad,
  };
}

// ---------------------------------------------------------------------
// 1. The reported bug: the card must clear the clicked musician.
// ---------------------------------------------------------------------

test('a highlighted member card does not overlap the source node region', () => {
  const env = loadPlacement({
    node: { id: 'Duff McKagan', type: 'person', x: 700, y: 440 },
    highlighted: [
      { id: "Guns N' Roses", type: 'band', x: 500, y: 300 },
      { id: 'Velvet Revolver', type: 'band', x: 900, y: 520 },
      { id: 'Loaded', type: 'band', x: 760, y: 610 },
    ],
  });
  env.positionNodeCard();

  const overlap = env.rectOverlapArea(renderedCardBox(env), sourceClearanceBox(env));
  assert.equal(overlap, 0, 'The card must not cover the musician it describes.');
});

test('the card clears the source node from every position on the stage', () => {
  // A highlight bbox is derived from the source plus its bands, so sweeping
  // the source across the stage also sweeps the region to avoid. This is the
  // case that regressed: a single anchored position works for a node in the
  // middle and fails near the edges (and vice versa).
  const positions = [];
  for (let x = 100; x <= STAGE_W - 100; x += 130) {
    for (let y = 80; y <= STAGE_H - 80; y += 100) positions.push({ x, y });
  }

  positions.forEach(({ x, y }) => {
    const env = loadPlacement({
      node: { id: 'Musician', type: 'person', x, y },
      highlighted: [
        { id: 'Band A', type: 'band', x: x - 180, y: y - 120 },
        { id: 'Band B', type: 'band', x: x + 200, y: y + 140 },
      ],
    });
    env.positionNodeCard();

    const overlap = env.rectOverlapArea(renderedCardBox(env), sourceClearanceBox(env));
    assert.equal(overlap, 0, `Card covered the source node at (${x}, ${y}).`);
  });
});

test('a highlight spanning the whole stage still yields a card clear of the source', () => {
  // Heavily-connected musicians produce a highlight bbox covering the whole
  // stage, so every corner overlaps it. Scoring on overlap area alone would
  // then be indifferent and could dock straight back onto the node.
  const env = loadPlacement({
    node: { id: 'Prolific', type: 'person', x: 720, y: 450 },
    highlighted: [
      { id: 'TL', type: 'band', x: 20, y: 20 },
      { id: 'BR', type: 'band', x: STAGE_W - 20, y: STAGE_H - 20 },
    ],
  });
  env.positionNodeCard();

  assert.equal(
    env.rectOverlapArea(renderedCardBox(env), sourceClearanceBox(env)),
    0,
    'Source-node clearance must outrank raw highlight-overlap area.'
  );
});

// ---------------------------------------------------------------------
// 2. Docking picks the least-obstructive corner and stays on stage.
// ---------------------------------------------------------------------

test('the card docks away from the highlighted cluster', () => {
  // Highlight sits in the top-left quadrant, so the far corner should win.
  const env = loadPlacement({
    node: { id: 'Musician', type: 'person', x: 240, y: 180 },
    highlighted: [
      { id: 'Band A', type: 'band', x: 160, y: 120 },
      { id: 'Band B', type: 'band', x: 320, y: 260 },
    ],
  });
  env.positionNodeCard();

  const box = renderedCardBox(env);
  assert.ok(box.x1 > STAGE_W / 2, 'Expected the card on the far (right) side of the stage.');
  assert.ok(box.y1 > STAGE_H / 2, 'Expected the card on the far (bottom) side of the stage.');
});

test('a docked card stays fully inside the stage', () => {
  const corners = [
    { x: 60, y: 60 }, { x: STAGE_W - 60, y: 60 },
    { x: 60, y: STAGE_H - 60 }, { x: STAGE_W - 60, y: STAGE_H - 60 },
  ];
  corners.forEach(({ x, y }) => {
    const env = loadPlacement({
      node: { id: 'Musician', type: 'person', x, y },
      highlighted: [{ id: 'Band', type: 'band', x: STAGE_W / 2, y: STAGE_H / 2 }],
    });
    env.positionNodeCard();

    const box = renderedCardBox(env);
    assert.ok(box.x0 >= 0, `Card ran off the left edge from (${x}, ${y}).`);
    assert.ok(box.y0 >= 0, `Card ran off the top edge from (${x}, ${y}).`);
    assert.ok(box.x1 <= STAGE_W, `Card ran off the right edge from (${x}, ${y}).`);
    assert.ok(box.y1 <= STAGE_H, `Card ran off the bottom edge from (${x}, ${y}).`);
  });
});

test('ties resolve to a bottom corner, not a top one', () => {
  // The top of the stage carries the header auth strip, the graph toolbar
  // and the stats HUD; the bottom is comparatively free.
  const env = loadPlacement({
    node: { id: 'Musician', type: 'person', x: STAGE_W / 2, y: STAGE_H / 2 },
    highlighted: [{ id: 'Band', type: 'band', x: STAGE_W / 2, y: STAGE_H / 2 }],
  });
  env.positionNodeCard();

  const box = renderedCardBox(env);
  assert.ok(box.y0 > STAGE_H / 2, 'Expected a bottom-corner dock on a tie.');
});

// ---------------------------------------------------------------------
// 3. Band clicks (no highlight) keep the existing anchored behavior.
// ---------------------------------------------------------------------

test('with no highlight the card still anchors to the node', () => {
  const env = loadPlacement({
    node: { id: 'Nirvana', type: 'band', x: 700, y: 440 },
    highlighted: [],
  });
  env.positionNodeCard();

  assert.equal(
    parseFloat(env.nodeCardEl.style.left),
    700,
    'A band card must stay horizontally anchored on its node (PR E behavior).'
  );
  assert.equal(
    parseFloat(env.nodeCardEl.style.top),
    440,
    'A band card must stay vertically anchored on its node (PR E behavior).'
  );
});

test('the no-highlight path still clamps a node near the stage edge', () => {
  const env = loadPlacement({
    node: { id: 'Edge Band', type: 'band', x: 4, y: 400 },
    highlighted: [],
  });
  env.positionNodeCard();

  const left = parseFloat(env.nodeCardEl.style.left);
  assert.ok(left >= CARD_W / 2, 'Expected the pre-existing horizontal clamp to still apply.');
});

test('a node with no coordinates is still centered rather than docked', () => {
  // Reachable via a member chip for someone the active filter excluded.
  const env = loadPlacement({
    node: { id: 'Filtered Out', type: 'band' },
    highlighted: [],
  });
  env.positionNodeCard();

  assert.equal(parseFloat(env.nodeCardEl.style.left), STAGE_W / 2);
});

test('band selection clears the member highlight, so band cards take the anchored path', () => {
  const src = extract('selectBandNode');
  assert.ok(
    src.includes('clearMemberHighlight()'),
    'selectBandNode must clear the highlight, otherwise band cards would dock to a corner.'
  );
});

// ---------------------------------------------------------------------
// 4. Wiring / ordering invariants.
// ---------------------------------------------------------------------

test('the highlight is applied before the card is opened', () => {
  // openNodeCard() positions the card, and positionNodeCard() reads the
  // highlight to decide whether to dock. With the calls the other way round
  // the first placement sees no highlight and anchors over the node -- and
  // on a settled graph no further tick ever corrects it.
  const src = stripComments(extract('selectMemberNode'));
  const highlightIdx = src.indexOf('highlightMemberBands(');
  const openIdx = src.indexOf('openNodeCard(');
  assert.ok(highlightIdx >= 0, 'Expected selectMemberNode to highlight the bands.');
  assert.ok(openIdx >= 0, 'Expected selectMemberNode to open the card.');
  assert.ok(
    highlightIdx < openIdx,
    'highlightMemberBands() must run before openNodeCard() so the card can dock clear of it.'
  );
  // updateSelection() may re-render, which would wipe the highlight classes.
  assert.ok(
    src.indexOf('updateSelection(') < highlightIdx,
    'updateSelection() must still run first — a re-render there would drop the highlight.'
  );
});

test('mobile keeps the bottom-sheet card and skips all JS placement', () => {
  const env = loadPlacement({
    node: { id: 'Duff McKagan', type: 'person', x: 700, y: 440 },
    highlighted: [{ id: 'Band', type: 'band', x: 200, y: 200 }],
    mobile: true,
  });
  env.positionNodeCard();

  assert.equal(env.nodeCardEl.style.left, undefined, 'Mobile must not write left/top (PR #44 bottom sheet).');
  assert.equal(env.nodeCardEl.style.top, undefined, 'Mobile must not write left/top (PR #44 bottom sheet).');
});

test('memberHighlightExtent reports nothing when no band is highlighted', () => {
  const env = loadPlacement({ highlighted: [] });
  assert.equal(env.memberHighlightExtent(), null);
});

test('memberHighlightExtent spans the source musician and every highlighted band', () => {
  const env = loadPlacement({
    node: { id: 'Musician', type: 'person', x: 700, y: 440 },
    highlighted: [
      { id: 'Band A', type: 'band', x: 300, y: 200 },
      { id: 'Band B', type: 'band', x: 1000, y: 700 },
    ],
  });
  assert.deepEqual(plain(env.memberHighlightExtent()), { x0: 300, y0: 200, x1: 1000, y1: 700 });
});

test('memberHighlightExtent ignores bands the layout gave no coordinates', () => {
  const env = loadPlacement({
    node: { id: 'Musician', type: 'person', x: 700, y: 440 },
    highlighted: [{ id: 'Band A', type: 'band', x: 300, y: 200 }, { id: 'Coordless', type: 'band' }],
  });
  assert.deepEqual(plain(env.memberHighlightExtent()), { x0: 300, y0: 200, x1: 700, y1: 440 });
});

// ---------------------------------------------------------------------
// 5. Drift guards.
// ---------------------------------------------------------------------

test('the anchor offset matches the 18px in the .node-card CSS transforms', () => {
  const offset = Number(extractConst('NODE_CARD_ANCHOR_OFFSET').match(/=\s*(\d+)/)[1]);
  assert.ok(
    INDEX_HTML.includes(`transform: translate(-50%, calc(-100% - ${offset}px));`),
    `Expected .node-card to offset by ${offset}px above the anchor.`
  );
  assert.ok(
    INDEX_HTML.includes(`transform: translate(-50%, ${offset}px);`),
    `Expected .node-card--below to offset by ${offset}px below the anchor.`
  );
});

test('placement never touches the empty-state overlay', () => {
  // .graph-empty-state (PR C) is centered by CSS and must not be dragged
  // into the card's positioning logic.
  const src = extract('positionNodeCard');
  assert.ok(!src.includes('graph-empty-state'), 'positionNodeCard() must leave the empty-state overlay alone.');
});

test('placement does not reheat the layout or re-render', () => {
  // PR #65 moved the force layout to a single synchronous pass; a card
  // placement is not worth a multi-second freeze on the full graph.
  const src = extract('positionNodeCard') + extract('memberHighlightExtent') + extract('chooseNodeCardDock');
  ['renderGraph(', 'simulation.alpha', '.restart()'].forEach(forbidden => {
    assert.ok(!src.includes(forbidden), `Card placement must not call ${forbidden}.`);
  });
});

test('the highlight colour is untouched', () => {
  assert.ok(INDEX_HTML.includes('#ffb454'), "PR E's amber highlight colour must survive this change.");
});
