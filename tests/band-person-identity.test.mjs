// A band and a musician with the same name are two nodes.
//
// Five acts in the data are both. Each has a band row (genre, city, years) AND
// a person row (instruments, bio), joined by a real membership:
//
//   Jeremy Enigk · Ayron Jones · LL Cool J · Randy Hansen · Sir Mix-a-Lot
//
// They are not duplicates, and the band row is not a mistake: a solo project
// named after its artist is a band, because whatever is in the band name field
// is a band name.
//
// Keyed by name alone, the two rows became ONE node. Whichever row was read
// first won the type, so Jeremy Enigk rendered as a band and his instruments
// and bio were silently discarded — and the membership joining them collapsed
// into a self-loop, which crashed the renderer outright.
//
// The rule: the BAND keeps the plain name, the person is suffixed. Only the id
// changes. Every label, card, chip and API payload uses the display name.
//
// buildMasterGraph and applyDraftToMaster are extracted from index.html by
// brace-matching, so these tests run the exact code that ships.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PERSON_ID_SUFFIX as MODULE_SUFFIX,
  displayNameForId as moduleDisplayNameForId,
  nodeLabel as moduleNodeLabel,
  resolveAnchor,
} from '../scripts/neighborhood-helpers.mjs';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8'
);

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

function extractConst(name) {
  const start = html.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `const ${name} not found in index.html`);
  return html.slice(start, html.indexOf(';', start) + 1);
}

function extractConstObject(name) {
  const start = html.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} not found in index.html`);
  return html.slice(start, html.indexOf('};', start) + 2);
}

const LOCATION_HELPERS = [
  'normalizeLocationField',
  'normalizeState',
  'normalizeCountry',
  'normalizeGenre',
  'locationKey',
  'locationLabel',
  'parseLegacyScene',
];

const factory = new Function(
  [
    extractConstObject('LEGACY_COUNTRY_ALIASES'),
    extractConstObject('KNOWN_CITY_LOCATIONS'),
    ...LOCATION_HELPERS.map(extract),
    extract('normalizeKey'),
    extractConst('PERSON_ID_SUFFIX'),
    extract('personNodeId'),
    extract('displayNameForId'),
    extract('nodeName'),
    extract('makeRoomForBandNamed'),
    extract('buildMasterGraph'),
    extract('applyDraftToMaster'),
  ].join('\n') +
  `\n; return {
     PERSON_ID_SUFFIX, personNodeId, displayNameForId, nodeName,
     makeRoomForBandNamed, buildMasterGraph, applyDraftToMaster,
   };`
);
const {
  PERSON_ID_SUFFIX,
  personNodeId,
  displayNameForId,
  nodeName,
  makeRoomForBandNamed,
  buildMasterGraph,
  applyDraftToMaster,
} = factory();

const row = (source, target, extra = {}) => ({ source, target, ...extra });

// The real shape of the Jeremy Enigk data, in the order the rows actually
// arrive: the band row for Sunny Day Real Estate comes long before the row that
// establishes Jeremy Enigk as a band in his own right.
const soloActRows = () => [
  row('Sunny Day Real Estate', 'Jeremy Enigk', { genre: 'Emo', city: 'Seattle', 'Instrument 1': 'guitar', 'Instrument 2': 'vocals' }),
  row('Sunny Day Real Estate', 'Nate Mendel'),
  row('The Fire Theft', 'Jeremy Enigk'),
  row('Jeremy Enigk', 'Jeremy Enigk', { genre: 'Emo', city: 'Seattle' }),
  row('Foo Fighters', 'Nate Mendel'),
];

const idsOf = graph => graph.nodes.map(n => n.id).sort();
const nodeById = (graph, id) => graph.nodes.find(n => n.id === id);
const linkPairs = graph => graph.links.map(l => [
  typeof l.source === 'object' ? l.source.id : l.source,
  typeof l.target === 'object' ? l.target.id : l.target,
]);

// -------------------------------------------------------------------------
// 1. The rule itself
// -------------------------------------------------------------------------

test('the band keeps the plain name and the person is suffixed', () => {
  const isBandName = name => name === 'Jeremy Enigk';
  assert.equal(personNodeId('Jeremy Enigk', isBandName), `Jeremy Enigk${PERSON_ID_SUFFIX}`);
  assert.equal(personNodeId('Nate Mendel', isBandName), 'Nate Mendel', 'a non-colliding musician is untouched');
});

test('the rule is idempotent and trims', () => {
  const always = () => true;
  const once = personNodeId('Jeremy Enigk', always);
  assert.equal(personNodeId(once, always), once, 'applying it twice must not double the suffix');
  assert.equal(personNodeId('  Jeremy Enigk  ', always), once);
  assert.equal(personNodeId('', always), '', 'no name, no id');
});

test('the display name is recovered from a suffixed id', () => {
  assert.equal(displayNameForId(`Jeremy Enigk${PERSON_ID_SUFFIX}`), 'Jeremy Enigk');
  assert.equal(displayNameForId('Nate Mendel'), 'Nate Mendel');
  assert.equal(displayNameForId(''), '');
  assert.equal(nodeName({ id: `Jeremy Enigk${PERSON_ID_SUFFIX}`, name: 'Jeremy Enigk' }), 'Jeremy Enigk');
  assert.equal(nodeName({ id: `Jeremy Enigk${PERSON_ID_SUFFIX}` }), 'Jeremy Enigk', 'works without a name attribute');
  assert.equal(nodeName(`Jeremy Enigk${PERSON_ID_SUFFIX}`), 'Jeremy Enigk', 'accepts a bare id');
  assert.equal(nodeName(null), '');
});

test('index.html and neighborhood-helpers agree on the rule', () => {
  // index.html's main script is a classic script and cannot import, so it
  // carries a hand-synced copy. This is where a drift surfaces.
  assert.equal(PERSON_ID_SUFFIX, MODULE_SUFFIX, 'the suffix must be identical in both copies');
  [
    'Jeremy Enigk (musician)',
    'Jeremy Enigk',
    'Sir Mix-a-Lot (musician)',
    '',
    'A band (musician) with a strange name',
  ].forEach(id => {
    assert.equal(displayNameForId(id), moduleDisplayNameForId(id), `disagreement on "${id}"`);
  });
  const node = { id: 'LL Cool J (musician)', name: 'LL Cool J' };
  assert.equal(nodeName(node), moduleNodeLabel(node));
});

// -------------------------------------------------------------------------
// 2. Page load
// -------------------------------------------------------------------------

test('a solo act becomes two nodes, band and musician', () => {
  const graph = buildMasterGraph(soloActRows());
  const band = nodeById(graph, 'Jeremy Enigk');
  const person = nodeById(graph, `Jeremy Enigk${PERSON_ID_SUFFIX}`);

  assert.ok(band, 'the band must own the plain name');
  assert.equal(band.type, 'band');
  assert.ok(person, 'the musician must exist as his own node');
  assert.equal(person.type, 'person');
  assert.equal(person.name, 'Jeremy Enigk', 'and must still be called Jeremy Enigk');
});

test('the musician keeps the attributes the merged node used to discard', () => {
  // The old behaviour: the band row won the node, so instrument1/instrument2
  // were written onto a band node and never rendered anywhere.
  const person = nodeById(buildMasterGraph(soloActRows()), `Jeremy Enigk${PERSON_ID_SUFFIX}`);
  assert.equal(person.instrument1, 'guitar');
  assert.equal(person.instrument2, 'vocals');
});

test('the band keeps its own attributes', () => {
  const band = nodeById(buildMasterGraph(soloActRows()), 'Jeremy Enigk');
  assert.equal(band.genre, 'Emo');
  assert.equal(band.city, 'Seattle');
});

test('the solo membership is a real edge, not a self-loop', () => {
  const graph = buildMasterGraph(soloActRows());
  const pairs = linkPairs(graph);
  assert.ok(
    pairs.some(([s, t]) => s === 'Jeremy Enigk' && t === `Jeremy Enigk${PERSON_ID_SUFFIX}`),
    'the band must link to the musician'
  );
  assert.equal(
    pairs.filter(([s, t]) => s === t).length,
    0,
    'no self-loops: this is what crashed the renderer.'
  );
});

test('every membership of the musician points at the musician node', () => {
  // The bug that would replace the old one: the person node is split out but
  // some links still name the band, so SDRE appears to have the BAND as a
  // member and the musician floats unconnected.
  const graph = buildMasterGraph(soloActRows());
  const pairs = linkPairs(graph);
  const personId = `Jeremy Enigk${PERSON_ID_SUFFIX}`;
  ['Sunny Day Real Estate', 'The Fire Theft', 'Jeremy Enigk'].forEach(band => {
    assert.ok(
      pairs.some(([s, t]) => s === band && t === personId),
      `${band} must link to the musician node, not to the band of the same name`
    );
  });
});

test('every link endpoint resolves to a node that exists', () => {
  const graph = buildMasterGraph(soloActRows());
  const ids = new Set(graph.nodes.map(n => n.id));
  linkPairs(graph).forEach(([s, t]) => {
    assert.ok(ids.has(s), `dangling source: ${s}`);
    assert.ok(ids.has(t), `dangling target: ${t}`);
  });
});

test('row order does not change the outcome', () => {
  // The pre-pass exists for this: the person row can arrive before anything
  // reveals that the same name is also a band.
  const forward = buildMasterGraph(soloActRows());
  const reversed = buildMasterGraph(soloActRows().reverse());
  assert.deepEqual(idsOf(reversed), idsOf(forward));
});

test('a graph with no collisions is completely unchanged', () => {
  const graph = buildMasterGraph([
    row('Nirvana', 'Kurt Cobain'),
    row('Nirvana', 'Dave Grohl'),
    row('Foo Fighters', 'Dave Grohl'),
  ]);
  assert.deepEqual(idsOf(graph), ['Dave Grohl', 'Foo Fighters', 'Kurt Cobain', 'Nirvana']);
  assert.ok(
    graph.nodes.every(n => !n.id.includes(PERSON_ID_SUFFIX)),
    'the suffix must never appear where there is nothing to disambiguate'
  );
});

test('all five production solo acts split cleanly', () => {
  const names = ['Jeremy Enigk', 'Ayron Jones', 'LL Cool J', 'Randy Hansen', 'Sir Mix-a-Lot'];
  const rows = names.flatMap(name => [row(name, name), row('Some Other Band', name)]);
  const graph = buildMasterGraph(rows);
  names.forEach(name => {
    assert.equal(nodeById(graph, name).type, 'band', `${name} the band`);
    assert.equal(nodeById(graph, `${name}${PERSON_ID_SUFFIX}`).type, 'person', `${name} the musician`);
  });
  assert.equal(linkPairs(graph).filter(([s, t]) => s === t).length, 0);
});

// -------------------------------------------------------------------------
// 3. Live submissions
// -------------------------------------------------------------------------

const emptyMaster = () => ({ nodes: [], links: [] });

test('submitting a solo act splits it the same way as page load', () => {
  const master = emptyMaster();
  const result = applyDraftToMaster(master, {
    band: 'Jeremy Enigk', city: 'Seattle', country: 'USA',
    members: [{ member: 'Jeremy Enigk', instrument: 'guitar, vocals', relation: '1' }],
    mode: 'new-band-entry',
  });
  assert.equal(result.added, true);
  assert.equal(nodeById(master, 'Jeremy Enigk').type, 'band');
  assert.equal(nodeById(master, `Jeremy Enigk${PERSON_ID_SUFFIX}`).type, 'person');
  assert.deepEqual(linkPairs(master), [['Jeremy Enigk', `Jeremy Enigk${PERSON_ID_SUFFIX}`]]);
});

test('a new band named after an existing musician moves the musician aside', () => {
  // The mirror case, live-session only: the musician already holds the plain
  // id. Two nodes with one id would make Sigma throw on the duplicate.
  const master = emptyMaster();
  applyDraftToMaster(master, {
    band: 'Sunny Day Real Estate', city: 'Seattle',
    members: [{ member: 'Jeremy Enigk', instrument: 'guitar', relation: '1' }],
    mode: 'new-band-entry',
  });
  assert.ok(nodeById(master, 'Jeremy Enigk'), 'precondition: the musician holds the plain id');

  applyDraftToMaster(master, {
    band: 'Jeremy Enigk', city: 'Seattle',
    members: [{ member: 'Jeremy Enigk', instrument: 'guitar', relation: '1' }],
    mode: 'new-band-entry',
  });

  assert.equal(nodeById(master, 'Jeremy Enigk').type, 'band', 'the band now owns the plain name');
  const person = nodeById(master, `Jeremy Enigk${PERSON_ID_SUFFIX}`);
  assert.equal(person.type, 'person');
  assert.equal(person.name, 'Jeremy Enigk');
  assert.equal(
    master.nodes.filter(n => n.name === 'Jeremy Enigk').length,
    2,
    'exactly two nodes, one band and one musician'
  );
});

test('moving a musician aside carries their existing memberships', () => {
  const master = emptyMaster();
  applyDraftToMaster(master, {
    band: 'Sunny Day Real Estate',
    members: [{ member: 'Jeremy Enigk', relation: '1' }],
    mode: 'new-band-entry',
  });
  applyDraftToMaster(master, {
    band: 'The Fire Theft',
    members: [{ member: 'Jeremy Enigk', relation: '1' }],
    mode: 'new-band-entry',
  });
  applyDraftToMaster(master, {
    band: 'Jeremy Enigk',
    members: [{ member: 'Jeremy Enigk', relation: '1' }],
    mode: 'new-band-entry',
  });

  const personId = `Jeremy Enigk${PERSON_ID_SUFFIX}`;
  const pairs = linkPairs(master);
  ['Sunny Day Real Estate', 'The Fire Theft', 'Jeremy Enigk'].forEach(band => {
    assert.ok(
      pairs.some(([s, t]) => s === band && t === personId),
      `${band}'s membership must follow the renamed musician`
    );
  });
  const ids = new Set(master.nodes.map(n => n.id));
  pairs.forEach(([s, t]) => {
    assert.ok(ids.has(s) && ids.has(t), `dangling endpoint after rename: ${s} -> ${t}`);
  });
});

test('makeRoomForBandNamed is a no-op when there is nothing to move', () => {
  const master = { nodes: [{ id: 'Nirvana', name: 'Nirvana', type: 'band' }], links: [] };
  assert.equal(makeRoomForBandNamed(master, 'Nirvana'), false, 'a band is not moved aside for a band');
  assert.equal(makeRoomForBandNamed(master, 'Soundgarden'), false, 'nothing named that exists');
  assert.deepEqual(master.nodes.map(n => n.id), ['Nirvana'], 'nodes untouched');
});

test('re-submitting the same solo act does not add a third node', () => {
  const master = emptyMaster();
  const draft = {
    band: 'Sir Mix-a-Lot', city: 'Seattle',
    members: [{ member: 'Sir Mix-a-Lot', instrument: 'vocals', relation: '1' }],
    mode: 'new-band-entry',
  };
  applyDraftToMaster(master, draft);
  const again = applyDraftToMaster(master, draft);
  assert.equal(again.added, false, 'the second submission is recognised as already present');
  assert.equal(master.nodes.length, 2);
  assert.equal(master.links.length, 1);
});

// -------------------------------------------------------------------------
// 4. Share links
//
// Node ids travel in ?anchor=. A link shared before this change said
// "?anchor=Jeremy Enigk" and meant the band, so it still has to mean the band.
// The musician is reachable by his own id, which reads as an explanation
// rather than as a token.
// -------------------------------------------------------------------------

const anchorNodes = [
  { id: 'Sunny Day Real Estate', name: 'Sunny Day Real Estate', type: 'band' },
  { id: 'Jeremy Enigk', name: 'Jeremy Enigk', type: 'band' },
  { id: `Jeremy Enigk${MODULE_SUFFIX}`, name: 'Jeremy Enigk', type: 'person' },
];
const anchorLinks = [
  { source: 'Sunny Day Real Estate', target: `Jeremy Enigk${MODULE_SUFFIX}` },
  { source: 'Jeremy Enigk', target: `Jeremy Enigk${MODULE_SUFFIX}` },
];

test('a plain name in a share link still opens the band', () => {
  const resolved = resolveAnchor({
    search: '?anchor=Jeremy%20Enigk',
    nodes: anchorNodes,
    links: anchorLinks,
  });
  assert.equal(resolved.anchorId, 'Jeremy Enigk');
  assert.equal(resolved.source, 'deep-link');
});

test('the musician is reachable by his own id', () => {
  const resolved = resolveAnchor({
    search: `?anchor=${encodeURIComponent(`Jeremy Enigk${MODULE_SUFFIX}`)}`,
    nodes: anchorNodes,
    links: anchorLinks,
  });
  assert.equal(resolved.anchorId, `Jeremy Enigk${MODULE_SUFFIX}`);
  assert.equal(resolved.source, 'deep-link');
});
