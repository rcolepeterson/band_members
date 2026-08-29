// The importer must read the role, not assume it.
//
// proposedRowsForBand hardcoded `weight: 2` for every membership it created, so
// every band MusicBrainz has ever supplied arrived as a wall of plain members:
// 387 of the 499 bands in the seed snapshot have no founder recorded at all,
// Black Sabbath, Iron Maiden and King Crimson among them. The signal was in the
// payload the client was already fetching and this code was discarding —
// MusicBrainz marks a founding member with the `original` relationship
// attribute, in the same array that carries the instruments the four Intrument
// columns were also left empty for.
//
// Verified against the live API while writing this:
//
//   The Dillinger Escape Plan — begins 1997-03
//     Ben Weinman   attrs=["guitar","keyboard","original","piano"]
//     Adam Doll     attrs=["bass guitar","original"]
//     Brian Benoit  attrs=["guitar"]              (joined 1998)
//
// scripts/ingest-batch.mjs runs main() at import time, so proposeEnrichments
// cannot be imported. Its body is extracted and evaluated against stubs — the
// technique tests/clean-root-url.test.mjs uses on the Sigma module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeNameKey,
  formatTenure,
  weightFromMbAttributes,
  instrumentsFromMbAttributes,
  instrumentColumns,
  MB_ROLE_ATTRIBUTES,
} from '../scripts/pipeline-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INGEST = readFileSync(join(__dirname, '..', 'scripts', 'ingest-batch.mjs'), 'utf8');

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

test("MusicBrainz's 'original' attribute means founder", () => {
  assert.equal(weightFromMbAttributes(['guitar', 'keyboard', 'original', 'piano']), 1);
  assert.equal(weightFromMbAttributes(['bass guitar', 'original']), 1);
});

test('a membership with no original marker is a plain member', () => {
  assert.equal(weightFromMbAttributes(['guitar']), 2);
  assert.equal(weightFromMbAttributes([]), 2);
});

test('touring is never inferred, because MusicBrainz does not model it', () => {
  // Weight 3 is a human judgement made through the add-band form's select.
  // Guessing it from an absent field is how the tier vanished in the first place.
  for (const attrs of [[], ['guitar'], ['original'], ['lead vocals', 'original']]) {
    assert.notEqual(weightFromMbAttributes(attrs), 3);
  }
  assert.deepEqual(MB_ROLE_ATTRIBUTES, ['original']);
});

test('the role marker is matched case- and whitespace-insensitively', () => {
  assert.equal(weightFromMbAttributes(['  Original  ']), 1);
  assert.equal(weightFromMbAttributes(['ORIGINAL']), 1);
});

test('a malformed attribute list cannot crash a 3,800-row ingest', () => {
  for (const bad of [null, undefined, 'original', 42, {}]) {
    assert.equal(weightFromMbAttributes(bad), 2, `${JSON.stringify(bad)} should be inert`);
  }
  assert.deepEqual(instrumentsFromMbAttributes(null), []);
  assert.deepEqual(instrumentsFromMbAttributes([null, '', '   ']), []);
});

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

test('instruments come out of the same array, without the role marker', () => {
  assert.deepEqual(
    instrumentsFromMbAttributes(['guitar', 'keyboard', 'original', 'piano']),
    ['Guitar', 'Keyboard', 'Piano'],
  );
});

test("MusicBrainz's disambiguating parenthetical is stripped", () => {
  // "drums (drum set)" is noise in a chip beside a musician's name.
  assert.deepEqual(
    instrumentsFromMbAttributes(['background vocals', 'drums (drum set)', 'original']),
    ['Background vocals', 'Drums'],
  );
});

test('order is preserved, since MusicBrainz lists the primary instrument first', () => {
  assert.deepEqual(instrumentsFromMbAttributes(['lead vocals', 'guitar']), ['Lead vocals', 'Guitar']);
});

test('duplicates collapse and the list is capped at four columns', () => {
  assert.deepEqual(instrumentsFromMbAttributes(['guitar', 'Guitar', 'guitar']), ['Guitar']);
  assert.equal(
    instrumentsFromMbAttributes(['guitar', 'bass guitar', 'piano', 'drums', 'banjo', 'sitar']).length,
    4,
  );
});

test('every row keeps an identical column set, filled or not', () => {
  assert.deepEqual(instrumentColumns(['Guitar', 'Piano']), {
    'Intrument 1': 'Guitar',
    'Intrument 2': 'Piano',
    'Intrument 3': '',
    'Intrument 4': '',
  });
  assert.deepEqual(Object.keys(instrumentColumns([])).length, 4);
});

test('the column name keeps the live data\u2019s spelling', () => {
  // "Intrument" is missing an 's' in the CSV header, the add-band form and the
  // database. Correcting it here would silently drop the column on ingest.
  const cols = instrumentColumns(['Guitar']);
  assert.ok('Intrument 1' in cols);
  assert.ok(!('Instrument 1' in cols));
});

// ---------------------------------------------------------------------------
// The importer writes what it read
// ---------------------------------------------------------------------------

test('proposedRowsForBand no longer hardcodes a weight', () => {
  const fn = INGEST.slice(
    INGEST.indexOf('function proposedRowsForBand('),
    INGEST.indexOf('function proposeEnrichments('),
  );
  assert.match(fn, /weight: weightFromMbAttributes\(rel\.attributes\)/);
  assert.doesNotMatch(fn, /weight: 2/);
  // And the four empty Intrument columns are gone with it.
  assert.match(fn, /\.\.\.instrumentColumns\(instrumentsFromMbAttributes\(rel\.attributes\)\)/);
  assert.doesNotMatch(fn, /'Intrument 1': ''/);
});

// ---------------------------------------------------------------------------
// The enrichment pass, which could not run at all
// ---------------------------------------------------------------------------

function extractProposeEnrichments() {
  const start = INGEST.indexOf('function proposeEnrichments(');
  assert.ok(start > 0, 'Expected proposeEnrichments() in scripts/ingest-batch.mjs.');
  let depth = 0;
  for (let i = INGEST.indexOf('{', start); i < INGEST.length; i += 1) {
    if (INGEST[i] === '{') depth += 1;
    else if (INGEST[i] === '}') {
      depth -= 1;
      if (depth === 0) return INGEST.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced braces while extracting proposeEnrichments().');
}

const proposeEnrichments = new Function(
  'toIso3', 'formatTenure', 'normalizeNameKey',
  'weightFromMbAttributes', 'instrumentsFromMbAttributes',
  `${extractProposeEnrichments()}; return proposeEnrichments;`,
)(
  iso2 => (iso2 === 'US' ? 'USA' : ''),
  formatTenure, normalizeNameKey, weightFromMbAttributes, instrumentsFromMbAttributes,
);

function emptyRow(overrides = {}) {
  return {
    target: 'Ben Weinman',
    city: '', state: '', country: '', genre: '', weight: '2',
    'Years Active': '', Tenure: '',
    'Intrument 1': '', 'Intrument 2': '', 'Intrument 3': '', 'Intrument 4': '',
    ...overrides,
  };
}

function mbDetail(relations = [], selfOverrides = {}) {
  return {
    self: {
      beginArea: 'Morris Plains',
      country: 'US',
      tags: [{ name: 'mathcore', count: 9 }],
      begin: '1997-03',
      end: '',
      ended: false,
      ...selfOverrides,
    },
    relations,
  };
}

const BEN = { relatedName: 'Ben Weinman', attributes: ['guitar', 'keyboard', 'original', 'piano'] };

test('the enrichment pass runs at all', () => {
  // It read `detail`, the name the variable has in main()'s loop, from inside a
  // function whose parameter is `mbDetail`. Not a global, so every --enrich run
  // threw ReferenceError on its first band with rows, which is every band.
  assert.doesNotThrow(() => proposeEnrichments({ rows: [emptyRow()], rowIndex: [0] }, mbDetail([BEN])));
});

test('years_active is finally proposed', () => {
  const out = proposeEnrichments({ rows: [emptyRow()], rowIndex: [7] }, mbDetail([BEN]));
  const years = out.find(p => p.field === 'years_active');
  assert.ok(years, 'expected a years_active proposal');
  assert.equal(years.newValue, '1997-present');
  assert.equal(years.rowIndex, 7);
});

test('a plain member is upgraded to founder when MusicBrainz says original', () => {
  const out = proposeEnrichments({ rows: [emptyRow()], rowIndex: [0] }, mbDetail([BEN]));
  const weight = out.find(p => p.field === 'weight');
  assert.ok(weight, 'expected a weight proposal');
  assert.equal(weight.oldValue, '2');
  assert.equal(weight.newValue, '1');
  assert.equal(weight.source, 'musicbrainz-original-attribute');
});

test('a human-marked founder or touring member is never contradicted', () => {
  for (const existing of ['1', '3']) {
    const out = proposeEnrichments(
      { rows: [emptyRow({ weight: existing })], rowIndex: [0] },
      mbDetail([BEN]),
    );
    assert.equal(out.filter(p => p.field === 'weight').length, 0, `weight ${existing} must be left alone`);
  }
});

test('a founder is never downgraded to a member', () => {
  const hiredHand = { relatedName: 'Ben Weinman', attributes: ['guitar'] };
  const out = proposeEnrichments(
    { rows: [emptyRow({ weight: '1' })], rowIndex: [0] },
    mbDetail([hiredHand]),
  );
  assert.equal(out.filter(p => p.field === 'weight').length, 0);
});

test('instruments are proposed for a row that has none', () => {
  const out = proposeEnrichments({ rows: [emptyRow()], rowIndex: [0] }, mbDetail([BEN]));
  const instruments = out.filter(p => p.field.startsWith('instrument_'));
  assert.deepEqual(
    instruments.map(p => [p.field, p.newValue]),
    [['instrument_1', 'Guitar'], ['instrument_2', 'Keyboard'], ['instrument_3', 'Piano']],
  );
});

test('a row a human partly filled is left alone', () => {
  // Filling column 3 beside a human's column 1 would interleave two sources.
  const out = proposeEnrichments(
    { rows: [emptyRow({ 'Intrument 1': 'Guitar' })], rowIndex: [0] },
    mbDetail([BEN]),
  );
  assert.equal(out.filter(p => p.field.startsWith('instrument_')).length, 0);
});

test('a row whose person is absent from MusicBrainz gets no per-member proposal', () => {
  const out = proposeEnrichments(
    { rows: [emptyRow({ target: 'Someone Local' })], rowIndex: [0] },
    mbDetail([BEN]),
  );
  assert.equal(out.filter(p => p.field === 'weight').length, 0);
  assert.equal(out.filter(p => p.field.startsWith('instrument_')).length, 0);
  // Band-level fields still apply — the band is the same band.
  assert.ok(out.find(p => p.field === 'city'));
});

test('people are matched on the pipeline\u2019s own normalized key', () => {
  const out = proposeEnrichments(
    { rows: [emptyRow({ target: "the ben weinman" })], rowIndex: [0] },
    mbDetail([{ relatedName: 'The Ben Weinman', attributes: ['original'] }]),
  );
  assert.ok(out.find(p => p.field === 'weight'), 'normalizeNameKey should bridge the two spellings');
});

test('city, country and genre backfills still work', () => {
  const out = proposeEnrichments({ rows: [emptyRow()], rowIndex: [0] }, mbDetail([BEN]));
  assert.equal(out.find(p => p.field === 'city').newValue, 'Morris Plains');
  assert.equal(out.find(p => p.field === 'country').newValue, 'USA');
  assert.equal(out.find(p => p.field === 'genre').newValue, 'mathcore');
});

test('a filled row proposes nothing at all', () => {
  const filled = emptyRow({
    city: 'Morris Plains', country: 'USA', genre: 'mathcore', weight: '1',
    'Years Active': '1997-present', 'Intrument 1': 'Guitar',
  });
  assert.deepEqual(proposeEnrichments({ rows: [filled], rowIndex: [0] }, mbDetail([BEN])), []);
});

test('every relation for one person is merged, not just the first', () => {
  // MusicBrainz emits a relation per instrument and per stint. Black Sabbath
  // returns 46 relations for 24 people; Ozzy Osbourne arrives twice, once for
  // lead vocals and once for harmonica. Reading only the first row would record
  // him as a singer who never touched a harmonica.
  const out = proposeEnrichments(
    { rows: [emptyRow({ target: 'Ozzy Osbourne' })], rowIndex: [0] },
    mbDetail([
      { relatedName: 'Ozzy Osbourne', attributes: ['lead vocals'] },
      { relatedName: 'Ozzy Osbourne', attributes: ['harmonica', 'original'] },
    ]),
  );
  assert.deepEqual(
    out.filter(p => p.field.startsWith('instrument_')).map(p => p.newValue),
    ['Lead vocals', 'Harmonica'],
  );
  // And 'original' on the SECOND row still makes him a founder.
  assert.equal(out.find(p => p.field === 'weight').newValue, '1');
});

test('a founding stint listed after a later one is still found', () => {
  const out = proposeEnrichments(
    { rows: [emptyRow({ target: 'Bill Ward' })], rowIndex: [0] },
    mbDetail([
      { relatedName: 'Bill Ward', attributes: ['drums (drum set)'] },
      { relatedName: 'Bill Ward', attributes: ['background vocals', 'original'] },
    ]),
  );
  assert.equal(out.find(p => p.field === 'weight').newValue, '1');
  assert.deepEqual(
    out.filter(p => p.field.startsWith('instrument_')).map(p => p.newValue),
    ['Drums', 'Background vocals'],
  );
});
