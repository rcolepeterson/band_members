// Unit tests for the location schema helpers.
//
// These import directly from the standalone ES module (the canonical source
// of truth) rather than extracting from index.html. index.html carries a
// hand-synced inline copy for browser use; if the two ever drift, this
// file is where a mismatch will surface.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeLocationField,
  normalizeState,
  normalizeCountry,
  locationKey,
  locationLabel,
  parseLegacyScene,
  LEGACY_COUNTRY_ALIASES,
} from '../scripts/location-helpers.mjs';

test('normalizeLocationField trims and coerces to string', () => {
  assert.equal(normalizeLocationField('  Seattle  '), 'Seattle');
  assert.equal(normalizeLocationField(''), '');
  assert.equal(normalizeLocationField(null), '');
  assert.equal(normalizeLocationField(undefined), '');
  assert.equal(normalizeLocationField(42), '42');
});

test('normalizeState uppercases and limits US-only 2-letter codes', () => {
  assert.equal(normalizeState('wa', 'USA'), 'WA');
  assert.equal(normalizeState(' ca ', 'USA'), 'CA');
  assert.equal(normalizeState('WASHINGTON', 'USA'), 'WA', 'over-long state truncates to 2 letters');
  assert.equal(normalizeState('', 'USA'), '', 'empty state stays empty');
});

test('normalizeState discards state for non-US countries', () => {
  assert.equal(normalizeState('EN', 'GBR'), '', 'legacy EN suffix should not survive');
  assert.equal(normalizeState('NSW', 'AUS'), '', 'Australian state discarded');
  assert.equal(normalizeState('WA', ''), 'WA', 'blank country leaves state alone (US assumed)');
});

test('normalizeCountry uppercases and limits to 3 letters', () => {
  assert.equal(normalizeCountry('usa'), 'USA');
  assert.equal(normalizeCountry(' gbr '), 'GBR');
  assert.equal(normalizeCountry('AUSTRALIA'), 'AUS', 'over-long country truncates to 3 letters');
  assert.equal(normalizeCountry(''), '');
  assert.equal(normalizeCountry(null), '');
});

test('locationKey builds stable country|state|city identity', () => {
  assert.equal(
    locationKey({ city: 'Seattle', state: 'WA', country: 'USA' }),
    'USA|WA|Seattle'
  );
  assert.equal(
    locationKey({ city: 'London', state: '', country: 'GBR' }),
    'GBR||London'
  );
  assert.equal(
    locationKey({ city: '', state: '', country: '' }),
    '',
    'fully-blank node has no key'
  );
  assert.equal(locationKey(null), '', 'null-safe');
  assert.equal(locationKey(undefined), '', 'undefined-safe');
});

test('locationLabel formats US rows as "City, ST"', () => {
  assert.equal(locationLabel({ city: 'Seattle', state: 'WA', country: 'USA' }), 'Seattle, WA');
  assert.equal(locationLabel({ city: 'Berkeley Heights', state: 'NJ', country: 'USA' }), 'Berkeley Heights, NJ');
});

test('locationLabel formats non-US rows as "City, CTRY"', () => {
  assert.equal(locationLabel({ city: 'London', state: '', country: 'GBR' }), 'London, GBR');
  assert.equal(locationLabel({ city: 'Sydney', state: '', country: 'AUS' }), 'Sydney, AUS');
  assert.equal(locationLabel({ city: 'Auckland', state: '', country: 'NZL' }), 'Auckland, NZL');
});

test('locationLabel degrades gracefully for missing fields', () => {
  assert.equal(locationLabel({ city: 'Seattle', state: '', country: 'USA' }), 'Seattle', 'no state suffix');
  assert.equal(locationLabel({ city: '', state: '', country: 'USA' }), 'USA', 'country-only fallback');
  assert.equal(locationLabel(null), '', 'null-safe');
});

test('parseLegacyScene splits US 2-letter suffixes correctly', () => {
  assert.deepEqual(parseLegacyScene('Seattle, WA'), { city: 'Seattle', state: 'WA', country: 'USA' });
  assert.deepEqual(parseLegacyScene('Berkeley Heights, NJ'), { city: 'Berkeley Heights', state: 'NJ', country: 'USA' });
});

test('parseLegacyScene handles legacy country aliases (NZ, AU, EN, SCT, UK)', () => {
  assert.deepEqual(parseLegacyScene('Auckland, NZ'), { city: 'Auckland', state: '', country: 'NZL' });
  assert.deepEqual(parseLegacyScene('Sydney, AU'), { city: 'Sydney', state: '', country: 'AUS' });
  assert.deepEqual(parseLegacyScene('London, EN'), { city: 'London', state: '', country: 'GBR' });
  assert.deepEqual(parseLegacyScene('Glasgow, SCT'), { city: 'Glasgow', state: '', country: 'GBR' });
});

test('parseLegacyScene recognizes already-ISO-3 country suffixes', () => {
  assert.deepEqual(parseLegacyScene('London, GBR'), { city: 'London', state: '', country: 'GBR' });
  assert.deepEqual(parseLegacyScene('Tokyo, JPN'), { city: 'Tokyo', state: '', country: 'JPN' });
});

test('parseLegacyScene falls back to US city for bare inputs', () => {
  assert.deepEqual(parseLegacyScene('Seattle'), { city: 'Seattle', state: '', country: 'USA' });
  assert.deepEqual(parseLegacyScene(''), { city: '', state: '', country: '' });
  assert.deepEqual(parseLegacyScene(null), { city: '', state: '', country: '' });
});

test('LEGACY_COUNTRY_ALIASES covers the known pre-refactor suffixes', () => {
  assert.equal(LEGACY_COUNTRY_ALIASES.NZ, 'NZL');
  assert.equal(LEGACY_COUNTRY_ALIASES.AU, 'AUS');
  assert.equal(LEGACY_COUNTRY_ALIASES.EN, 'GBR');
  assert.equal(LEGACY_COUNTRY_ALIASES.SCT, 'GBR');
  assert.equal(LEGACY_COUNTRY_ALIASES.UK, 'GBR');
});
