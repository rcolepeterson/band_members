// Island disclosure tests -- a band whose members play nowhere else.
//
// Aaron, 2026-11-15: today's Rawkle was Walk the Moon. "See in graph"
// opened a band he had never heard of, Expand silently did nothing, and
// nothing on screen could tell him the band simply has no connections --
// it read as a hung page or dead wifi. Walk the Moon is a true island:
// 4 members (Petricca, Ray, Waugaman, Maiman), none in any other band,
// component = 5 nodes, frontier empty.
//
// The fix names the state in the graph footer and on the band card --
// "An island in the universe -- no threads to other bands yet" -- keeps
// Expand enabled so it can answer by pulsing that row, and turns the dead
// end into the contribution on-ramp ("Know a connection? Add it" opens
// the same edit flow the card's pencil opens).
//
// isIslandView lives in the explorer's GOVERNOR-SECTION (pure helpers, no
// DOM), so it is extracted and executed here exactly like
// graph-governor-client.test.mjs does; the DOM wiring is covered by
// static assertions, the repo's standing pattern for this module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXPLORER = readFileSync(join(ROOT, 'scripts', 'sigma-explorer.mjs'), 'utf8');
const INDEX_HTML = readFileSync(join(ROOT, 'graph', 'index.html'), 'utf8');

function loadIslandHelper() {
  const start = EXPLORER.indexOf('// GOVERNOR-SECTION-START');
  const end = EXPLORER.indexOf('// GOVERNOR-SECTION-END');
  assert.ok(start >= 0 && end > start, 'governor section markers must exist in sigma-explorer.mjs');
  const section = EXPLORER.slice(start, end).replace(/^export /gm, '');
  const factory = new Function(`${section}; return { isIslandView };`);
  return factory().isIslandView;
}

const isIslandView = loadIslandHelper();

const band = (name) => ({ id: name, name, type: 'band' });
const person = (name) => ({ id: name, name, type: 'person' });

// ---------------------------------------------------------------------------
// The detection rule
// ---------------------------------------------------------------------------

test('isIslandView: Walk the Moon -- one band, its members, nothing beyond', () => {
  assert.equal(isIslandView({
    anchorType: 'band',
    nodes: [band('Walk the Moon'), person('Nicholas Petricca'), person('Kevin Ray'),
      person('Sean Waugaman'), person('Eli Maiman')],
    frontier: [],
    truncated: false,
  }), true);
});

test('isIslandView: a band with nodes still beyond the view is not (yet) an island', () => {
  assert.equal(isIslandView({
    anchorType: 'band',
    nodes: [band('Fleetwood Mac'), person('Stevie Nicks')],
    frontier: ['Christine McVie'],
    truncated: false,
  }), false);
});

test('isIslandView: a second band on screen ends the question', () => {
  assert.equal(isIslandView({
    anchorType: 'band',
    nodes: [band('Fleetwood Mac'), person('Stevie Nicks'), band('Solo Stevie')],
    frontier: [],
    truncated: false,
  }), false);
});

test('isIslandView: a musician anchor is never an island', () => {
  assert.equal(isIslandView({
    anchorType: 'person',
    nodes: [person('Nicholas Petricca'), band('Walk the Moon')],
    frontier: [],
    truncated: false,
  }), false);
});

test('isIslandView: a truncated view proves nothing', () => {
  assert.equal(isIslandView({
    anchorType: 'band',
    nodes: [band('Walk the Moon'), person('Nicholas Petricca')],
    frontier: [],
    truncated: true,
  }), false);
});

test('isIslandView: a band with no members at all is an island too', () => {
  assert.equal(isIslandView({
    anchorType: 'band',
    nodes: [band('Ricky Vac and the Rock-a-Ways')],
    frontier: [],
    truncated: false,
  }), true);
});

test('isIslandView: missing pieces are not an island', () => {
  assert.equal(isIslandView({}), false);
  assert.equal(isIslandView({ anchorType: 'band', nodes: null, frontier: [] }), false);
  assert.equal(isIslandView({ anchorType: 'band', nodes: [band('X')], frontier: null }), false);
});

// ---------------------------------------------------------------------------
// Explorer wiring: footer row, published state, Expand's answer
// ---------------------------------------------------------------------------

test('the stage template carries the island row with the approved copy', () => {
  assert.ok(EXPLORER.includes('<p class="sigma-island" hidden>'), 'Expected the island row in the stage template.');
  assert.ok(
    EXPLORER.includes('An island in the universe — no threads to other bands yet. This is the whole constellation.'),
    'Expected the footer island sentence.'
  );
  assert.ok(EXPLORER.includes('Know a connection? Add it'), 'Expected the Add-it button in the island row.');
});

test('updateChrome shows the row only on an island and publishes the state', () => {
  assert.ok(EXPLORER.includes('islandEl.hidden = !currentIsland'), 'Expected updateChrome to toggle the island row.');
  assert.ok(EXPLORER.includes("'rbft:sigma-island'"), 'Expected the island state to be published for the page.');
  assert.ok(
    EXPLORER.includes('expandBtn.disabled = !remaining && !currentIsland'),
    'Expected Expand to stay enabled on an island so it can answer.'
  );
});

test('Expand answers an island with the pulse instead of a re-render', () => {
  assert.ok(
    EXPLORER.includes('if (currentIsland) { pulseIsland(); return; }'),
    'Expected expand() to short-circuit on an island.'
  );
  assert.ok(EXPLORER.includes("islandEl.classList.add('sigma-island--pulse')"), 'Expected the pulse to light the island row.');
});

test('the island button announces its intent for the page to answer', () => {
  assert.ok(EXPLORER.includes("'rbft:sigma-island-add'"), 'Expected the Add-it intent event.');
});

// ---------------------------------------------------------------------------
// Page wiring: the card note and the Add-it move
// ---------------------------------------------------------------------------

test('the node card carries the island note with the approved copy', () => {
  assert.ok(INDEX_HTML.includes('id="node-card-island"'), 'Expected the island note element on the node card.');
  assert.ok(
    INDEX_HTML.includes('An island in the universe — no threads to other bands yet.'),
    'Expected the card island sentence.'
  );
  assert.ok(INDEX_HTML.includes('id="node-card-island-add"'), 'Expected the card Add-it button.');
});

test('populateNodeCard renders the island note', () => {
  assert.ok(INDEX_HTML.includes('renderIslandNote(node);'), 'Expected populateNodeCard to call renderIslandNote.');
  assert.ok(INDEX_HTML.includes('function renderIslandNote(node)'), 'Expected renderIslandNote to exist.');
});

test('the page tracks the published island state and answers Add-it', () => {
  assert.ok(INDEX_HTML.includes("addEventListener('rbft:sigma-island'"), 'Expected the page to track island state.');
  assert.ok(INDEX_HTML.includes("addEventListener('rbft:sigma-island-add'"), 'Expected the page to answer the footer Add-it.');
});
