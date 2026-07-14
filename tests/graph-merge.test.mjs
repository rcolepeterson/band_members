// Client-side graph-merge tests.
//
// The merge/render logic lives inline in index.html (a static, no-build page),
// so these tests extract the real functions from that file by brace-matching
// and exercise them directly. This guarantees the tests run the exact code that
// ships — no copy that can silently drift.
//
// Covers the production hotfix: duplicate band-name submissions must merge into
// a single band node, and one malformed record must never abort the rest of the
// render (per-submission error isolation).
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

// Post-schema-refactor, applyDraftToMaster calls the six location helpers.
// Pull them in too so the extracted function actually resolves its refs.
// (Same reason we already pull normalizeKey.)
const LOCATION_HELPERS = [
  'normalizeLocationField',
  'normalizeState',
  'normalizeCountry',
  'locationKey',
  'locationLabel',
  'parseLegacyScene',
];

const factory = new Function(
  [
    // LEGACY_COUNTRY_ALIASES is a const, not a function — extract it directly.
    (() => {
      const start = html.indexOf('const LEGACY_COUNTRY_ALIASES');
      assert.ok(start >= 0, 'LEGACY_COUNTRY_ALIASES not found');
      const end = html.indexOf('};', start) + 2;
      return html.slice(start, end);
    })(),
    ...LOCATION_HELPERS.map(extract),
    extract('normalizeKey'),
    extract('applyDraftToMaster'),
    extract('mergeSubmissionsIntoMaster'),
  ].join('\n') +
  '\n; return { applyDraftToMaster, mergeSubmissionsIntoMaster };'
);
const { applyDraftToMaster, mergeSubmissionsIntoMaster } = factory();

const emptyMaster = () => ({ nodes: [], links: [] });
const bandNodes = (m, name) => m.nodes.filter(n => n.type === 'band' && n.id === name);
const membersOf = (m, band) =>
  m.links.filter(l => (l.source.id || l.source) === band).map(l => l.target.id || l.target);

test('single brand-new band merges as before (baseline)', () => {
  const master = emptyMaster();
  const result = applyDraftToMaster(master, {
    band: 'Nirvana', scene: 'Seattle',
    members: [{ member: 'Kurt Cobain', instrument: 'vocals, guitar', relation: '1' }],
    mode: 'new-band-entry'
  });
  assert.equal(result.added, true);
  assert.equal(bandNodes(master, 'Nirvana').length, 1);
  assert.deepEqual(membersOf(master, 'Nirvana'), ['Kurt Cobain']);
});

test('two submissions for the SAME new band merge into one band node', () => {
  const master = emptyMaster();
  applyDraftToMaster(master, {
    band: 'Metallica', scene: 'San Francisco',
    members: [{ member: 'James Hetfield', instrument: 'vocals, guitar', relation: '1' }],
    mode: 'new-band-entry'
  });
  const second = applyDraftToMaster(master, {
    band: 'Metallica', scene: 'San Francisco',
    members: [
      { member: 'Lars Ulrich', instrument: 'drums', relation: '1' },
      { member: 'Kirk Hammett', instrument: 'guitar', relation: '1' }
    ],
    mode: 'existing-band-connection'
  });
  assert.equal(second.added, true);
  assert.equal(bandNodes(master, 'Metallica').length, 1, 'no duplicate band node');
  assert.deepEqual(membersOf(master, 'Metallica').sort(), ['James Hetfield', 'Kirk Hammett', 'Lars Ulrich']);
});

test('re-adding an already-connected member is a no-op, not a crash', () => {
  const master = emptyMaster();
  const draft = { band: 'Pearl Jam', members: [{ member: 'Eddie Vedder', relation: '1' }], mode: 'new-band-entry' };
  applyDraftToMaster(master, draft);
  const again = applyDraftToMaster(master, draft);
  assert.equal(again.added, false);
  assert.equal(membersOf(master, 'Pearl Jam').length, 1);
});

test('applyDraftToMaster does not throw on malformed records', () => {
  const master = emptyMaster();
  assert.doesNotThrow(() => applyDraftToMaster(master, { band: 'X', members: [null] }));
  assert.doesNotThrow(() => applyDraftToMaster(master, { band: 'Y', members: ['not-an-object'] }));
  assert.doesNotThrow(() => applyDraftToMaster(master, { band: 42, members: [{ member: 'A' }] }));
  assert.doesNotThrow(() => applyDraftToMaster(master, null));
  assert.doesNotThrow(() => applyDraftToMaster(master, 'garbage'));
});

test('one malformed record does NOT abort merging of the others', () => {
  const master = emptyMaster();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const failed = mergeSubmissionsIntoMaster(master, [
      { id: 'a', band: 'Good Band One', members: [{ member: 'Person A', relation: '1' }] },
      { id: 'bad', band: 'Broken', members: [{ get member() { throw new Error('boom'); } }] },
      { id: 'c', band: 'Good Band Two', members: [{ member: 'Person C', relation: '1' }] }
    ]);
    assert.equal(failed, 1, 'exactly one record failed');
    assert.ok(bandNodes(master, 'Good Band One').length === 1, 'record before the bad one applied');
    assert.ok(bandNodes(master, 'Good Band Two').length === 1, 'record AFTER the bad one still applied');
    assert.ok(warnings.some(w => String(w[0]).includes('bad')), 'warning includes the failing submission id');
  } finally {
    console.warn = originalWarn;
  }
});

test('reproduces the production snapshot: single Metallica node with all members', () => {
  const master = emptyMaster();
  const submissions = [
    { id: '1', band: 'Metallica', scene: 'San Francisco', mode: 'new-band-entry',
      members: [{ member: 'James Hetfield', instrument: 'vocals, guitar', relation: '1' }] },
    { id: '2', band: 'Metallica', scene: 'San Francisco', mode: 'existing-band-connection',
      members: [
        { member: 'Lars Ulrich', instrument: 'drums', relation: '1' },
        { member: 'Kirk Hammett', instrument: 'guitar', relation: '1' },
        { member: 'Robert Trujillo', instrument: 'bass, vocals', relation: '2' },
        { member: 'Ron McGovney', instrument: 'bass', relation: '1' },
        { member: 'Dave Mustaine', instrument: 'guitar', relation: '1' },
        { member: 'Cliff Burton', instrument: 'bass', relation: '2' },
        { member: 'Jason Newsted', instrument: 'bass, vocals', relation: '2' }
      ] },
    { id: '3', band: 'Diagnostic Test Band', scene: 'Seattle', mode: 'new-band-entry',
      members: [{ member: 'Test Person', instrument: 'Guitar', relation: '1' }] }
  ];
  const failed = mergeSubmissionsIntoMaster(master, submissions);
  assert.equal(failed, 0);
  assert.equal(bandNodes(master, 'Metallica').length, 1);
  assert.equal(membersOf(master, 'Metallica').length, 8);
  // No orphan links (would crash d3.forceLink().id()).
  const ids = new Set(master.nodes.map(n => n.id));
  const orphans = master.links.filter(l => !ids.has(l.source.id || l.source) || !ids.has(l.target.id || l.target));
  assert.equal(orphans.length, 0);
});
