// Tests for the duplicate-band monitor in cron_verify_stale_bands.mjs.
//
// `findDuplicatePairs` is pure: group bands by the compact normalized name,
// then apply sameBandIdentity pairwise — so same-name/different-city bands
// (the two Skid Rows) are NEVER flagged, while true duplicates (the
// Sep-2026 Sweet Water double) are. `scanDuplicateBands` takes an explicit
// `sql` argument, so tests pass a hand-written fake — no real Postgres.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findDuplicatePairs,
  scanDuplicateBands,
} from '../netlify/functions/cron_verify_stale_bands.mjs';

const CANONICAL_SW = {
  id: 'a8c8d9e2-806d-4241-8b3a-4ce70f61f083',
  name: 'Sweet Water',
  city: 'Seattle',
  country: 'USA',
};
const DUP_SW = {
  id: '9dcd9cd0-a34b-4304-ba75-cd38139c5e30',
  name: 'Sweet Water',
  city: null,
  country: null,
};
const SKID_NJ = { id: 'skid-nj', name: 'Skid Row', city: "Tom's River, NJ", country: 'USA' };
const SKID_AB = { id: 'skid-ab', name: 'Skid Row', city: 'Aberdeen', country: 'USA' };

test('findDuplicatePairs: flags the Sep-2026 Sweet Water double', () => {
  const pairs = findDuplicatePairs([CANONICAL_SW, DUP_SW]);
  assert.equal(pairs.length, 1);
  // Ids are ordered lexicographically (a < b) for a stable pair key —
  // '9dcd…' sorts before 'a8c8…'.
  assert.deepEqual(pairs[0], { a: DUP_SW.id, b: CANONICAL_SW.id });
});

test('findDuplicatePairs: catches punctuation/whitespace spelling variants', () => {
  const bands = [
    { id: 'a', name: 'Sweet Water', city: 'Seattle', country: 'USA' },
    { id: 'b', name: 'Sweet-Water', city: 'Seattle', country: 'USA' },
    { id: 'c', name: 'sweet  water', city: 'Seattle', country: 'USA' },
  ];
  const pairs = findDuplicatePairs(bands);
  assert.equal(pairs.length, 3); // every pair among the three
});

test('findDuplicatePairs: never flags the two Skid Rows', () => {
  assert.deepEqual(findDuplicatePairs([SKID_NJ, SKID_AB]), []);
  assert.deepEqual(findDuplicatePairs([CANONICAL_SW, SKID_NJ, SKID_AB]), []);
});

test('findDuplicatePairs: same name in different countries is not a duplicate', () => {
  const bands = [
    { id: 'a', name: 'The Verve', city: 'London', country: 'GBR' },
    { id: 'b', name: 'The Verve', city: 'London', country: 'CAN' },
  ];
  assert.deepEqual(findDuplicatePairs(bands), []);
});

test('findDuplicatePairs: empty and singleton inputs yield no pairs', () => {
  assert.deepEqual(findDuplicatePairs([]), []);
  assert.deepEqual(findDuplicatePairs([CANONICAL_SW]), []);
  assert.deepEqual(findDuplicatePairs(null), []);
});

test('findDuplicatePairs: bands with blank names are ignored', () => {
  const bands = [
    { id: 'a', name: '', city: 'Seattle', country: 'USA' },
    { id: 'b', name: null, city: 'Seattle', country: 'USA' },
  ];
  assert.deepEqual(findDuplicatePairs(bands), []);
});

// Fake `sql` for scanDuplicateBands: the bands select returns the configured
// rows, the open-flags select returns the configured unresolved flags (or
// throws when the duplicate_flags table doesn't exist yet), and inserts are
// recorded.
function makeScanSql({ bands, openFlags = [], throwOnFlags = false, inserted = [] } = {}) {
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('from bands')) return Promise.resolve(bands);
    if (text.includes('from duplicate_flags')) {
      if (throwOnFlags) return Promise.reject(new Error('relation "duplicate_flags" does not exist'));
      return Promise.resolve(openFlags);
    }
    if (text.includes('insert into duplicate_flags')) {
      inserted.push(values);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return sql;
}

test('scanDuplicateBands: inserts one flag per new duplicate pair', async () => {
  const inserted = [];
  const sql = makeScanSql({ bands: [CANONICAL_SW, DUP_SW, SKID_NJ, SKID_AB], inserted });
  const summary = await scanDuplicateBands(sql);
  assert.equal(summary.pairs_found, 1);
  assert.equal(summary.new_flags, 1);
  assert.equal(summary.skipped, false);
  assert.equal(inserted.length, 1);
  // band_ids are stored [a, b] in lexicographic order ('9dcd…' < 'a8c8…').
  assert.deepEqual(inserted[0][0], [DUP_SW.id, CANONICAL_SW.id]);
});

test('scanDuplicateBands: does not re-flag an already-unresolved pair', async () => {
  const inserted = [];
  const sql = makeScanSql({
    bands: [CANONICAL_SW, DUP_SW],
    openFlags: [{ band_ids: [DUP_SW.id, CANONICAL_SW.id] }], // stored order may vary
    inserted,
  });
  const summary = await scanDuplicateBands(sql);
  assert.equal(summary.pairs_found, 1);
  assert.equal(summary.new_flags, 0);
  assert.equal(inserted.length, 0);
});

test('scanDuplicateBands: flags only the new pair when one is already open', async () => {
  const other1 = { id: 'other-1', name: 'Nirvana', city: 'Aberdeen', country: 'USA' };
  const other2 = { id: 'other-2', name: 'Nirvana', city: 'Aberdeen', country: 'USA' };
  const inserted = [];
  const sql = makeScanSql({
    bands: [CANONICAL_SW, DUP_SW, other1, other2],
    openFlags: [{ band_ids: [CANONICAL_SW.id, DUP_SW.id] }],
    inserted,
  });
  const summary = await scanDuplicateBands(sql);
  assert.equal(summary.pairs_found, 2);
  assert.equal(summary.new_flags, 1);
  assert.deepEqual(inserted[0][0], ['other-1', 'other-2']);
});

test('scanDuplicateBands: a clean database inserts nothing', async () => {
  const inserted = [];
  const sql = makeScanSql({ bands: [CANONICAL_SW, SKID_NJ, SKID_AB], inserted });
  const summary = await scanDuplicateBands(sql);
  assert.equal(summary.pairs_found, 0);
  assert.equal(summary.new_flags, 0);
  assert.equal(inserted.length, 0);
});

test('scanDuplicateBands: waits for the migration instead of crashing', async () => {
  const inserted = [];
  const sql = makeScanSql({ bands: [CANONICAL_SW, DUP_SW], throwOnFlags: true, inserted });
  const summary = await scanDuplicateBands(sql);
  assert.equal(summary.skipped, true);
  assert.equal(summary.new_flags, 0);
  assert.equal(inserted.length, 0);
});
