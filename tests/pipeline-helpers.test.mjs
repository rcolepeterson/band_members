// Unit tests for the ingestion pipeline's pure helpers.
//
// The pipeline itself hits MusicBrainz + Wikipedia, so end-to-end tests
// are impractical in CI. Instead we cover the logic that decides which
// bands to merge: scoring, name normalization, and CSV emission. If
// these are right, the pipeline's decisions are auditable regardless of
// what the network returned.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeNameKey,
  formatTenure,
  scoreCandidate,
  CONFIDENCE_TIERS,
  csvEscape,
  csvRow,
} from '../scripts/pipeline-helpers.mjs';

// ---------------------------------------------------------------------
// normalizeNameKey
// ---------------------------------------------------------------------
test('normalizeNameKey lowercases and trims', () => {
  assert.equal(normalizeNameKey('  Pearl Jam  '), 'pearl jam');
});

test('normalizeNameKey strips leading "The"', () => {
  assert.equal(normalizeNameKey('The Beatles'), 'beatles');
  assert.equal(normalizeNameKey('the who'), 'who');
});

test('normalizeNameKey strips punctuation and curly quotes', () => {
  assert.equal(normalizeNameKey("Guns N' Roses"), 'guns n roses');
  assert.equal(normalizeNameKey('AC/DC'), 'ac/dc');
  assert.equal(normalizeNameKey('L\u2019Trimm'), 'ltrimm');
});

test('normalizeNameKey collapses whitespace', () => {
  assert.equal(normalizeNameKey('Pearl   Jam'), 'pearl jam');
});

test('normalizeNameKey handles null and empty', () => {
  assert.equal(normalizeNameKey(null), '');
  assert.equal(normalizeNameKey(''), '');
  assert.equal(normalizeNameKey(undefined), '');
});

// ---------------------------------------------------------------------
// formatTenure — must produce the same range strings the node card
// renders, so the pipeline output is display-ready.
// ---------------------------------------------------------------------
test('formatTenure handles year-only ranges', () => {
  assert.equal(formatTenure({ begin: '1990', end: '1994', ended: true }), '1990-1994');
});

test('formatTenure uses "present" when the tenure is ongoing', () => {
  assert.equal(formatTenure({ begin: '1994', end: '', ended: false }), '1994-present');
  assert.equal(formatTenure({ begin: '1994', end: null, ended: false }), '1994-present');
});

test('formatTenure extracts year from full ISO dates', () => {
  // Dave Krusen: 1990-09-22 to 1991-05-22
  assert.equal(formatTenure({ begin: '1990-09-22', end: '1991-05-22', ended: true }), '1990-1991');
});

test('formatTenure collapses same-year ranges to a single year', () => {
  // A brief guest stint — show one year, not "1991-1991"
  assert.equal(formatTenure({ begin: '1991-07-02', end: '1991-08-03', ended: true }), '1991');
});

test('formatTenure returns empty string when nothing is known', () => {
  assert.equal(formatTenure({}), '');
  assert.equal(formatTenure({ begin: '', end: '', ended: false }), '');
});

test('formatTenure handles end-only tenure', () => {
  assert.equal(formatTenure({ begin: '', end: '1994', ended: true }), '1994');
});

test('formatTenure treats begin-only + ended=true as a single-year stint', () => {
  // MB sometimes has just a start year with ended=true when the person
  // left but the exact end wasn't recorded. Better to show the year alone
  // than to say "1990-present" for an ended stint.
  assert.equal(formatTenure({ begin: '1990', end: '', ended: true }), '1990');
});

// ---------------------------------------------------------------------
// scoreCandidate — the heart of the auto-merge policy
// ---------------------------------------------------------------------
test('scoreCandidate: perfect band lands in high tier', () => {
  const result = scoreCandidate({
    existingConnections: 5,
    memberCount: 4,
    hasWikipediaArticle: true,
    hasBeginArea: true,
    hasBeginYear: true,
  });
  assert.equal(result.tier, 'high');
  assert.equal(result.score, 9);
  assert.equal(result.signals.bridge, true);
  assert.equal(result.signals.multiBridge, true);
  assert.equal(result.signals.wikipedia, true);
});

test('scoreCandidate: single bridge + notability + city -> medium', () => {
  // 1 existing member, 3-member band, city known, no Wikipedia, no year
  const result = scoreCandidate({
    existingConnections: 1,
    memberCount: 3,
    hasWikipediaArticle: false,
    hasBeginArea: true,
    hasBeginYear: false,
  });
  // 2 (bridge) + 2 (notability) + 1 (city) = 5
  assert.equal(result.score, 5);
  assert.equal(result.tier, 'medium');
});

test('scoreCandidate: no bridge -> low regardless of other signals', () => {
  // A band with Wikipedia + city + years but zero connection to graph:
  // Wikipedia (2) + city (1) + year (1) + no notability (0) + no bridge (0) = 4.
  // Even without the bridge signal, a band with Wikipedia and full data
  // can reach medium tier. That's fine — the pipeline still won't merge
  // it until human review, since no-bridge candidates are outside
  // "bridge-fill" scope by definition.
  const result = scoreCandidate({
    existingConnections: 0,
    memberCount: 2,
    hasWikipediaArticle: true,
    hasBeginArea: true,
    hasBeginYear: true,
  });
  assert.equal(result.score, 4);
  assert.equal(result.tier, 'medium');
  assert.equal(result.signals.bridge, undefined);
});

test('scoreCandidate: empty candidate scores 0', () => {
  const result = scoreCandidate({});
  assert.equal(result.score, 0);
  assert.equal(result.tier, 'low');
  assert.deepEqual(result.signals, {});
});

test('scoreCandidate: existing connections >= 3 add multi-bridge signal', () => {
  const one = scoreCandidate({ existingConnections: 1 });
  const three = scoreCandidate({ existingConnections: 3 });
  assert.equal(one.signals.multiBridge, undefined);
  assert.equal(three.signals.multiBridge, true);
  assert.equal(three.score - one.score, 1);
});

test('scoreCandidate: memberCount < 3 loses notability signal', () => {
  const two = scoreCandidate({ memberCount: 2 });
  const three = scoreCandidate({ memberCount: 3 });
  assert.equal(two.signals.notability, undefined);
  assert.equal(three.signals.notability, true);
});

test('CONFIDENCE_TIERS thresholds match scoreCandidate boundaries', () => {
  // Guard against silent drift between the score function and the
  // documented tier boundaries.
  assert.equal(CONFIDENCE_TIERS.high.minScore, 7);
  assert.equal(CONFIDENCE_TIERS.medium.minScore, 4);
  assert.equal(CONFIDENCE_TIERS.low.minScore, 0);
});

// ---------------------------------------------------------------------
// CSV emission — must produce output that graphState.master ingestion
// can round-trip without corruption.
// ---------------------------------------------------------------------
test('csvEscape passes plain values through unchanged', () => {
  assert.equal(csvEscape('Pearl Jam'), 'Pearl Jam');
  assert.equal(csvEscape('Seattle'), 'Seattle');
  assert.equal(csvEscape(1990), '1990');
});

test('csvEscape wraps and escapes values containing commas or quotes', () => {
  assert.equal(csvEscape('Crosby, Stills, Nash & Young'), '"Crosby, Stills, Nash & Young"');
  assert.equal(csvEscape('Weird "Al" Yankovic'), '"Weird ""Al"" Yankovic"');
});

test('csvEscape handles null and undefined as empty strings', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvRow assembles values in header order', () => {
  const headers = ['source', 'target', 'city'];
  const row = csvRow(headers, { target: 'Dave Grohl', source: 'Foo Fighters', city: 'Seattle' });
  assert.equal(row, 'Foo Fighters,Dave Grohl,Seattle');
});

test('csvRow leaves missing fields empty', () => {
  const headers = ['source', 'target', 'city', 'state'];
  const row = csvRow(headers, { source: 'X', target: 'Y' });
  assert.equal(row, 'X,Y,,');
});
