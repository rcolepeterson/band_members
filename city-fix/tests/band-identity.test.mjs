// Unit tests for the band-identity rule (name + city + country).
//
// Covers the pure helpers in netlify/functions/_bands_write.mjs that back
// the duplicate-band check. index.html mirrors the same rule client-side
// for the add-band dialog (see the "Mirrors _bands_write.mjs" comment
// there); the two implementations must stay in sync.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIdentityKey,
  citiesMatch,
  sameBandIdentity,
} from '../netlify/functions/_bands_write.mjs';

test('normalizeIdentityKey folds case, punctuation, and whitespace', () => {
  assert.equal(normalizeIdentityKey("Tom's River, NJ"), 'toms river nj');
  assert.equal(normalizeIdentityKey('Toms River NJ'), 'toms river nj');
  assert.equal(normalizeIdentityKey('  SEATTLE  '), 'seattle');
  assert.equal(normalizeIdentityKey('Seattle, WA'), 'seattle wa');
  assert.equal(normalizeIdentityKey(null), '');
  assert.equal(normalizeIdentityKey(undefined), '');
});

test('citiesMatch treats "Seattle" and "Seattle, WA" as the same place', () => {
  assert.equal(citiesMatch('Seattle', 'Seattle, WA'), true);
  assert.equal(citiesMatch('Seattle, WA', 'Seattle'), true);
  assert.equal(citiesMatch("Tom's River, NJ", 'Toms River'), true);
});

test('citiesMatch distinguishes genuinely different cities', () => {
  assert.equal(citiesMatch('Toms River', 'Seattle'), false);
  assert.equal(citiesMatch('Aberdeen, WA', 'Toms River, NJ'), false);
});

test('citiesMatch treats a bare city as matching its qualified form; country is the backstop', () => {
  // "London" vs "London, Ontario" match on city tokens alone — the country
  // comparison in sameBandIdentity is what keeps London, UK apart from
  // London, Canada.
  assert.equal(citiesMatch('London', 'London, Ontario'), true);
});

test('citiesMatch is conservative when a city is missing', () => {
  assert.equal(citiesMatch('', 'Seattle'), true);
  assert.equal(citiesMatch('Seattle', ''), true);
  assert.equal(citiesMatch('', ''), true);
});

test('sameBandIdentity: the two Skid Rows are different bands', () => {
  const nj = { name: 'Skid Row', city: "Tom's River, NJ", country: 'USA' };
  const sea = { name: 'Skid Row', city: 'Aberdeen', country: 'USA' };
  assert.equal(sameBandIdentity(nj, sea), false);
  assert.equal(sameBandIdentity(sea, nj), false);
});

test('sameBandIdentity: same name + same city (soft city) is the same band', () => {
  const a = { name: 'Nirvana', city: 'Aberdeen', country: 'USA' };
  const b = { name: 'nirvana', city: 'Aberdeen, WA', country: 'USA' };
  assert.equal(sameBandIdentity(a, b), true);
});

test('sameBandIdentity: different names never match', () => {
  assert.equal(
    sameBandIdentity(
      { name: 'Nirvana', city: 'Aberdeen', country: 'USA' },
      { name: 'Pearl Jam', city: 'Aberdeen', country: 'USA' }
    ),
    false
  );
});

test('sameBandIdentity: country breaks the tie (London, UK vs London, CA)', () => {
  const uk = { name: 'The Verve', city: 'London', country: 'GBR' };
  const ca = { name: 'The Verve', city: 'London', country: 'CAN' };
  assert.equal(sameBandIdentity(uk, ca), false);
});

test('sameBandIdentity: a missing country does not force a fork', () => {
  const a = { name: 'Nirvana', city: 'Aberdeen', country: '' };
  const b = { name: 'Nirvana', city: 'Aberdeen', country: 'USA' };
  assert.equal(sameBandIdentity(a, b), true);
});

test('sameBandIdentity: a missing city never silently forks', () => {
  const a = { name: 'Nirvana', city: '', country: 'USA' };
  const b = { name: 'Nirvana', city: 'Aberdeen', country: 'USA' };
  assert.equal(sameBandIdentity(a, b), true);
});
