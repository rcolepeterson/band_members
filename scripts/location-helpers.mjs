// ---------------------------------------------------------------------------
// Location schema helpers
//
// Nodes carry three location fields: city (plain text), state (USPS
// 2-letter uppercase for US rows; blank for non-US), and country (ISO
// 3166-1 alpha-3 for every row, e.g. USA, GBR, NZL, AUS).
//
// This replaces the old single 'scene' field. The helpers below are the
// single source of truth for how city/state/country are displayed and
// filtered anywhere in the UI, so a change in format only has to happen
// in one place.
//
// This module is shared, browser-side, pure logic only (no DOM access, no
// fetch) so it can be imported directly by index.html (as an ES module) and
// by the test suite (tests/graph-merge.test.mjs) without any bundler.
//
// NOTE: netlify/functions/bands.mjs keeps its OWN small hand-copy of the
// normalizeCountry/normalizeState/parseLegacyScene logic rather than
// importing this file, because Netlify Functions run in a separate
// server-side runtime/process from the browser and can't import a
// browser-served /scripts/ path. Keep the two copies in sync by hand if the
// rules here ever change.
// ---------------------------------------------------------------------------

// Trim + normalize a raw field value. Empty/missing -> ''.
export function normalizeLocationField(raw) {
  return String(raw || '').trim();
}

// USPS-style state normalization: uppercase, US-only 2-letter code.
// Non-US rows should always have blank state; enforce that at ingest so
// downstream code never has to worry about 'EN' vs 'GBR' vs blank.
export function normalizeState(rawState, country) {
  const state = normalizeLocationField(rawState).toUpperCase();
  if (!state) return '';
  if (country && country !== 'USA') return ''; // discard non-US state values
  return state.slice(0, 2); // USPS is always 2 letters
}

// ISO-3 country normalization: uppercase, 3 letters. Empty -> ''.
export function normalizeCountry(rawCountry) {
  const country = normalizeLocationField(rawCountry).toUpperCase();
  if (!country) return '';
  return country.slice(0, 3);
}

// Build a stable identity key for a node's location. Used by the filter
// to group nodes by scene without depending on display formatting.
// Format: "country|state|city" — always three pipe-delimited parts even
// if state is blank. Empty location -> ''.
export function locationKey(node) {
  if (!node) return '';
  const city = normalizeLocationField(node.city);
  const state = normalizeLocationField(node.state);
  const country = normalizeLocationField(node.country);
  if (!city && !state && !country) return '';
  return `${country}|${state}|${city}`;
}

// Human-readable label for a location. Rules:
//   - US rows -> 'City, ST'    (e.g. 'Seattle, WA')
//   - Non-US rows -> 'City, CTRY' (e.g. 'London, GBR')
//   - Missing city -> just the country or ''
// Used in filter dropdowns, detail panels, and (conditionally) node labels.
export function locationLabel(node) {
  if (!node) return '';
  const city = normalizeLocationField(node.city);
  const state = normalizeLocationField(node.state);
  const country = normalizeLocationField(node.country);
  if (country === 'USA') {
    if (city && state) return `${city}, ${state}`;
    return city || state || 'USA';
  }
  if (city && country) return `${city}, ${country}`;
  return city || country || '';
}

// Legacy-scene parser. Old user submissions (before this refactor) stored
// a single 'scene' string like 'Seattle, WA' or bare 'Seattle'. This
// splits such a string into { city, state, country } on the fly so those
// submissions keep rendering correctly without a data migration.
//
// Rules:
//   - Two comma parts + second is 2 letters -> treat as US 'City, ST'
//   - Two comma parts + second is 3 letters -> treat as 'City, CTRY'
//   - One part matching a known country name -> country only
//   - Otherwise -> city only, country defaults to USA (the historical
//     default for bare 'Seattle' etc.)
export const LEGACY_COUNTRY_ALIASES = {
  // Old two-letter scene suffixes we saw in the pre-refactor CSV/data.
  // Anything not on this list is assumed to be a US state.
  'NZ': 'NZL',
  'AU': 'AUS',
  'EN': 'GBR',
  'SCT': 'GBR', // Scotland -> UK
  'UK': 'GBR',
};

// Known-city lookup: for pre-refactor submissions where the user typed just
// a bare city name ('Seattle' rather than 'Seattle, WA'), fill in the correct
// state and country so their locationKey matches the CSV rows for the same
// scene. This is what makes Parc Boys ('scene: "Seattle"' in Netlify Blobs)
// show up when the mobile default filter is 'USA|WA|Seattle'.
//
// City name lookup is case-insensitive. Only cities that appear in the CSV
// are listed; typing an unknown city still returns { city, state: '',
// country: 'USA' } as a safe default.
export const KNOWN_CITY_LOCATIONS = {
  // US cities
  'seattle':       { state: 'WA', country: 'USA' },
  'tacoma':        { state: 'WA', country: 'USA' },
  'issaquah':      { state: 'WA', country: 'USA' },
  'portland':      { state: 'OR', country: 'USA' },
  'los angeles':   { state: 'CA', country: 'USA' },
  'venice':        { state: 'CA', country: 'USA' },
  'palm desert':   { state: 'CA', country: 'USA' },
  'san francisco': { state: 'CA', country: 'USA' },
  'new york':      { state: 'NY', country: 'USA' },
  'berkeley heights': { state: 'NJ', country: 'USA' },
  'chicago':       { state: 'IL', country: 'USA' },
  'champaign':     { state: 'IL', country: 'USA' },
  'rockford':      { state: 'IL', country: 'USA' },
  'cleveland':     { state: 'OH', country: 'USA' },
  'coral springs': { state: 'FL', country: 'USA' },
  'kansas city':   { state: 'MO', country: 'USA' },
  'oklahoma city': { state: 'OK', country: 'USA' },
  // Non-US cities (state is always blank)
  'auckland':      { state: '', country: 'NZL' },
  'sydney':        { state: '', country: 'AUS' },
  'melbourne':     { state: '', country: 'AUS' },
  'london':        { state: '', country: 'GBR' },
  'birmingham':    { state: '', country: 'GBR' },
  'manchester':    { state: '', country: 'GBR' },
  'glasgow':       { state: '', country: 'GBR' },
};

export function parseLegacyScene(raw) {
  const trimmed = normalizeLocationField(raw);
  if (!trimmed) return { city: '', state: '', country: '' };
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[0];
    const suffix = parts[1].toUpperCase();
    // Try country alias first (NZ, AU, EN, SCT, UK).
    if (LEGACY_COUNTRY_ALIASES[suffix]) {
      return { city, state: '', country: LEGACY_COUNTRY_ALIASES[suffix] };
    }
    // 3-letter suffix -> already ISO-3 country.
    if (suffix.length === 3) {
      return { city, state: '', country: suffix };
    }
    // 2-letter suffix -> assume USPS state, country USA.
    if (suffix.length === 2) {
      return { city, state: suffix, country: 'USA' };
    }
    // Anything else -> keep the whole thing as city, default country USA.
    return { city: trimmed, state: '', country: 'USA' };
  }
  // Single part: look up the city in the known-city table so the resulting
  // locationKey matches the CSV. Falls back to city-only + USA if unknown.
  const rawCity = parts[0] || '';
  const known = KNOWN_CITY_LOCATIONS[rawCity.toLowerCase()];
  if (known) {
    return { city: rawCity, state: known.state, country: known.country };
  }
  return { city: rawCity, state: '', country: 'USA' };
}
