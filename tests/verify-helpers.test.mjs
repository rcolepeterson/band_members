// Unit tests for the pure helpers in netlify/functions/_verify_helpers.mjs.
//
// fetchMusicBrainz / fetchWikipedia are tested here too, but always with a
// mocked `fetchImpl` injected — never hitting real APIs. Live-API sanity
// checking was done manually against Nirvana/Soundgarden/Mudhoney per the
// PR description; see the PR report for those results. This file must be
// hermetic so it runs in CI without network access.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBandName,
  stripWikipediaDisambiguation,
  canonicalizeCountryCode,
  countryCodesMatch,
  parseYearsActive,
  editDistance,
  scoreNameMatch,
  fetchMusicBrainz,
  fetchWikipedia,
  scoreVerification,
  COUNTRY_ALPHA3_TO_ALPHA2,
} from '../netlify/functions/_verify_helpers.mjs';

// --- normalizeBandName -------------------------------------------------------

test('normalizeBandName lowercases, trims, and strips a leading "The "', () => {
  assert.equal(normalizeBandName('  The Melvins  '), 'melvins');
  assert.equal(normalizeBandName('Nirvana'), 'nirvana');
  assert.equal(normalizeBandName('the Sonics'), 'sonics');
});

test('normalizeBandName handles non-strings safely', () => {
  assert.equal(normalizeBandName(undefined), '');
  assert.equal(normalizeBandName(null), '');
  assert.equal(normalizeBandName(42), '');
});

// --- stripWikipediaDisambiguation --------------------------------------------

test('stripWikipediaDisambiguation removes a trailing parenthetical', () => {
  assert.equal(stripWikipediaDisambiguation('Nirvana (band)'), 'Nirvana');
  assert.equal(stripWikipediaDisambiguation('Nirvana (American band)'), 'Nirvana');
  assert.equal(stripWikipediaDisambiguation('Soundgarden'), 'Soundgarden');
});

test('stripWikipediaDisambiguation handles non-strings safely', () => {
  assert.equal(stripWikipediaDisambiguation(undefined), '');
  assert.equal(stripWikipediaDisambiguation(null), '');
});

// --- country code canonicalization -------------------------------------------

test('canonicalizeCountryCode passes through alpha-3 codes unchanged', () => {
  assert.equal(canonicalizeCountryCode('usa'), 'USA');
  assert.equal(canonicalizeCountryCode('GBR'), 'GBR');
});

test('canonicalizeCountryCode maps alpha-2 to alpha-3 using the lookup table', () => {
  assert.equal(canonicalizeCountryCode('us'), 'USA');
  assert.equal(canonicalizeCountryCode('GB'), 'GBR');
  assert.equal(canonicalizeCountryCode('ca'), 'CAN');
});

test('canonicalizeCountryCode returns empty string for empty/non-string input', () => {
  assert.equal(canonicalizeCountryCode(''), '');
  assert.equal(canonicalizeCountryCode(null), '');
  assert.equal(canonicalizeCountryCode(undefined), '');
});

test('countryCodesMatch matches USA<->US, GBR<->GB, CAN<->CA', () => {
  assert.equal(countryCodesMatch('USA', 'US'), true);
  assert.equal(countryCodesMatch('GBR', 'GB'), true);
  assert.equal(countryCodesMatch('CAN', 'CA'), true);
  assert.equal(countryCodesMatch('USA', 'GB'), false);
});

test('countryCodesMatch is case-insensitive and null-safe', () => {
  assert.equal(countryCodesMatch('usa', 'us'), true);
  assert.equal(countryCodesMatch('', 'US'), false);
  assert.equal(countryCodesMatch('USA', ''), false);
  assert.equal(countryCodesMatch(null, 'US'), false);
});

test('the alpha-3/alpha-2 lookup table covers at least 20 countries', () => {
  assert.ok(Object.keys(COUNTRY_ALPHA3_TO_ALPHA2).length >= 20);
});

// --- parseYearsActive ---------------------------------------------------------

test('parseYearsActive handles a closed range with a hyphen', () => {
  assert.deepEqual(parseYearsActive('1987-1994'), { start: '1987', end: '1994', present: false });
});

test('parseYearsActive handles a closed range with an en dash', () => {
  assert.deepEqual(parseYearsActive('1987–1994'), { start: '1987', end: '1994', present: false });
});

test('parseYearsActive handles an open-ended trailing hyphen', () => {
  assert.deepEqual(parseYearsActive('1987-'), { start: '1987', end: null, present: true });
});

test('parseYearsActive handles the literal word "present"', () => {
  assert.deepEqual(parseYearsActive('1987-present'), { start: '1987', end: null, present: true });
});

test('parseYearsActive handles a bare single year', () => {
  assert.deepEqual(parseYearsActive('1987'), { start: '1987', end: null, present: false });
});

test('parseYearsActive returns null for unparseable or empty input', () => {
  assert.equal(parseYearsActive(''), null);
  assert.equal(parseYearsActive('sometime in the 80s'), null);
  assert.equal(parseYearsActive(undefined), null);
  assert.equal(parseYearsActive(null), null);
});

// --- editDistance / scoreNameMatch ---------------------------------------------

test('editDistance is 0 for identical strings', () => {
  assert.equal(editDistance('nirvana', 'nirvana'), 0);
});

test('editDistance counts single-character edits correctly', () => {
  assert.equal(editDistance('cat', 'bat'), 1); // substitution
  assert.equal(editDistance('cat', 'cats'), 1); // insertion
  assert.equal(editDistance('cats', 'cat'), 1); // deletion
});

test('editDistance handles empty strings', () => {
  assert.equal(editDistance('', ''), 0);
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('', 'abc'), 3);
});

test('scoreNameMatch returns 100 for exact matches', () => {
  assert.equal(scoreNameMatch('nirvana', 'nirvana'), 100);
});

test('scoreNameMatch decays 10 points per edit-distance unit, floored at 0', () => {
  assert.equal(scoreNameMatch('soundgarden', 'soundgarde'), 90); // 1 edit
  assert.equal(scoreNameMatch('abc', 'xyz'), 70); // 3 edits -> 100 - 30
  assert.equal(scoreNameMatch('completelydifferentnamehere', 'somethingelseentirely'), 0);
});

test('scoreNameMatch returns null when either side is empty', () => {
  assert.equal(scoreNameMatch('', 'nirvana'), null);
  assert.equal(scoreNameMatch('nirvana', ''), null);
});

// --- fetchMusicBrainz (mocked fetch) -------------------------------------------

function fakeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('fetchMusicBrainz sends the required User-Agent header', async () => {
  let capturedHeaders = null;
  const fetchImpl = async (url, opts) => {
    capturedHeaders = opts.headers;
    return fakeJsonResponse(200, { artists: [] });
  };
  await fetchMusicBrainz('Nirvana', { fetchImpl });
  assert.ok(capturedHeaders['User-Agent'].includes('bandmembers-bot'));
});

test('fetchMusicBrainz prefers a Group-type match over higher-scoring non-group matches', async () => {
  const fetchImpl = async () => fakeJsonResponse(200, {
    artists: [
      { id: 'person-1', type: 'Person', name: 'Nirvana', score: 100 },
      { id: 'group-1', type: 'Group', name: 'Nirvana', score: 90 },
    ],
  });
  const result = await fetchMusicBrainz('Nirvana', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.artist.id, 'group-1');
});

test('fetchMusicBrainz falls back to the top overall result when no Group type exists', async () => {
  const fetchImpl = async () => fakeJsonResponse(200, {
    artists: [{ id: 'person-1', type: 'Person', name: 'Solo Artist', score: 100 }],
  });
  const result = await fetchMusicBrainz('Solo Artist', { fetchImpl });
  assert.equal(result.artist.id, 'person-1');
});

test('fetchMusicBrainz returns artist:null when there are no matches', async () => {
  const fetchImpl = async () => fakeJsonResponse(200, { artists: [] });
  const result = await fetchMusicBrainz('Some Unknown Band', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.artist, null);
});

test('fetchMusicBrainz appends country disambiguation to the query when provided', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return fakeJsonResponse(200, { artists: [] });
  };
  await fetchMusicBrainz('Nirvana', { country: 'USA', fetchImpl });
  assert.ok(decodeURIComponent(capturedUrl).includes('country:US'));
});

test('fetchMusicBrainz reports failure on non-2xx response', async () => {
  const fetchImpl = async () => fakeJsonResponse(500, {});
  const result = await fetchMusicBrainz('Nirvana', { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('500'));
});

test('fetchMusicBrainz reports failure on network error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const result = await fetchMusicBrainz('Nirvana', { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('ECONNRESET'));
});

test('fetchMusicBrainz logs a rate-limited message on 429', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const fetchImpl = async () => fakeJsonResponse(429, {});
    await fetchMusicBrainz('Nirvana', { fetchImpl });
    assert.ok(logs.some(l => l.includes('external service rate limited') && l.includes('musicbrainz')));
  } finally {
    console.error = originalError;
  }
});

// --- fetchWikipedia (mocked fetch) ---------------------------------------------

test('fetchWikipedia returns the summary page on the first "(band)" candidate', async () => {
  const fetchImpl = async (url) => {
    if (decodeURIComponent(url).includes('Nirvana_(band)')) {
      return fakeJsonResponse(200, { title: 'Nirvana (band)', extract: 'Nirvana was an American rock band formed in Aberdeen, Washington, in 1987.' });
    }
    return fakeJsonResponse(404, {});
  };
  const result = await fetchWikipedia('Nirvana', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.page.title, 'Nirvana (band)');
});

test('fetchWikipedia falls back to the bare name when "(band)" 404s', async () => {
  const fetchImpl = async (url) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes('Soundgarden_(band)')) return fakeJsonResponse(404, {});
    if (decoded.includes('page/summary/Soundgarden')) {
      return fakeJsonResponse(200, { title: 'Soundgarden', extract: 'Soundgarden was an American rock band formed in Seattle in 1984.' });
    }
    return fakeJsonResponse(404, {});
  };
  const result = await fetchWikipedia('Soundgarden', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.page.title, 'Soundgarden');
});

test('fetchWikipedia falls back to search API when direct candidates fail', async () => {
  const fetchImpl = async (url) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes('page/summary/')) return fakeJsonResponse(404, {});
    if (decoded.includes('list=search')) {
      return fakeJsonResponse(200, { query: { search: [{ title: 'Mudhoney' }] } });
    }
    return fakeJsonResponse(404, {});
  };
  // Note: this mock never succeeds on the summary fetch even for the
  // search-derived title, so the final result should be page:null but
  // still ok:true (a "found nothing" outcome, not an error).
  const result = await fetchWikipedia('Mudhoney', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.page, null);
});

test('fetchWikipedia skips disambiguation pages', async () => {
  const fetchImpl = async (url) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes('_(band)')) {
      return fakeJsonResponse(200, { type: 'disambiguation', title: 'Nirvana (band)' });
    }
    if (decoded.includes('page/summary/Nirvana')) {
      return fakeJsonResponse(200, { title: 'Nirvana', extract: 'Nirvana is a school of thought in Buddhism.' });
    }
    return fakeJsonResponse(404, {});
  };
  const result = await fetchWikipedia('Nirvana', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.page.title, 'Nirvana');
});

test('fetchWikipedia reports failure on network error', async () => {
  const fetchImpl = async () => { throw new Error('DNS failure'); };
  const result = await fetchWikipedia('Nirvana', { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('DNS failure'));
});

test('fetchWikipedia reports failure immediately on 429', async () => {
  const fetchImpl = async () => fakeJsonResponse(429, {});
  const result = await fetchWikipedia('Nirvana', { fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('rate limited'));
});

// --- scoreVerification (the field-by-field scoring engine) ---------------------

const mbNirvana = {
  id: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
  name: 'Nirvana',
  type: 'Group',
  country: 'US',
  area: { name: 'United States' },
  'begin-area': { name: 'Aberdeen' },
  'life-span': { begin: '1987', end: '1994-04-05', ended: true },
  tags: [{ name: 'rock' }, { name: 'alternative rock' }, { name: 'grunge' }],
};

const wikiNirvana = {
  title: 'Nirvana (band)',
  extract: 'Nirvana was an American rock band formed in Aberdeen, Washington, in 1987.',
};

test('scoreVerification produces a high overall score for a well-matched band (Nirvana smoke case)', () => {
  const band = { name: 'Nirvana', city: 'Aberdeen', country: 'USA', genre: 'grunge', years_active: '1987-1994' };
  const result = scoreVerification(band, mbNirvana, wikiNirvana);
  assert.equal(result.breakdown.name.score, 100);
  assert.equal(result.breakdown.country.score, 100);
  assert.equal(result.breakdown.city.score, 100);
  assert.equal(result.breakdown.genre.score, 100);
  assert.equal(result.breakdown.years_active.score, 100);
  assert.equal(result.overall_score, 100);
});

test('scoreVerification skips fields where we have no data on our side (no genre)', () => {
  const band = { name: 'Nirvana', city: 'Aberdeen', country: 'USA', genre: '', years_active: '1987-1994' };
  const result = scoreVerification(band, mbNirvana, wikiNirvana);
  assert.equal('genre' in result.breakdown, false);
});

test('scoreVerification skips fields where both external sources have nothing', () => {
  const band = { name: 'Nirvana', city: 'Aberdeen', country: 'USA', genre: 'grunge', years_active: '1987-1994' };
  const bareMb = { id: 'x', name: 'Nirvana', type: 'Group' }; // no country, no area, no tags, no life-span
  const result = scoreVerification(band, bareMb, null);
  assert.equal('country' in result.breakdown, false);
  assert.equal('city' in result.breakdown, false);
  assert.equal('genre' in result.breakdown, false);
  assert.equal('years_active' in result.breakdown, false);
  assert.ok('name' in result.breakdown); // MB still had a name to compare
});

test('scoreVerification handles a total absence of external data (returns overall 0, empty breakdown)', () => {
  const band = { name: 'Some Band', city: 'Nowhere', country: 'USA', genre: 'punk', years_active: '2000-2005' };
  const result = scoreVerification(band, null, null);
  assert.deepEqual(result.breakdown, {});
  assert.equal(result.overall_score, 0);
});

test('scoreVerification city field falls back to Wikipedia mention at score 80', () => {
  const band = { name: 'Soundgarden', city: 'Seattle', country: 'USA' };
  const mb = { id: 'x', name: 'Soundgarden', type: 'Group' }; // no area
  const wiki = { title: 'Soundgarden', extract: 'Soundgarden was formed in Seattle, Washington.' };
  const result = scoreVerification(band, mb, wiki);
  assert.equal(result.breakdown.city.score, 80);
  assert.equal(result.breakdown.city.wikipedia_mentions, true);
});

test('scoreVerification city field scores 0 when neither source mentions the city but data exists', () => {
  const band = { name: 'Soundgarden', city: 'Seattle', country: 'USA' };
  const mb = { id: 'x', name: 'Soundgarden', type: 'Group', area: { name: 'United States' } };
  const wiki = { title: 'Soundgarden', extract: 'A band with no location mentioned.' };
  const result = scoreVerification(band, mb, wiki);
  assert.equal(result.breakdown.city.score, 0);
});

test('scoreVerification genre field: exact tag match scores 100, substring scores 80, token overlap scores 40', () => {
  const bandExact = { name: 'X', genre: 'grunge' };
  const mbExact = { id: 'x', name: 'X', tags: [{ name: 'grunge' }] };
  assert.equal(scoreVerification(bandExact, mbExact, null).breakdown.genre.score, 100);

  const bandSubstring = { name: 'X', genre: 'rock' };
  const mbSubstring = { id: 'x', name: 'X', tags: [{ name: 'alternative rock' }] };
  assert.equal(scoreVerification(bandSubstring, mbSubstring, null).breakdown.genre.score, 80);

  const bandOverlap = { name: 'X', genre: 'punk rock' };
  const mbOverlap = { id: 'x', name: 'X', tags: [{ name: 'rock and indie' }] };
  assert.equal(scoreVerification(bandOverlap, mbOverlap, null).breakdown.genre.score, 40);
});

test('scoreVerification genre field falls back to Wikipedia extract mention at score 60', () => {
  const band = { name: 'X', genre: 'grunge' };
  const wiki = { title: 'X', extract: 'X is widely regarded as a grunge band from Seattle.' };
  const result = scoreVerification(band, null, wiki);
  assert.equal(result.breakdown.genre.score, 60);
});

test('scoreVerification years_active handles open-ended "present" bands correctly', () => {
  const band = { name: 'Mudhoney', years_active: '1988-present' };
  const mbStillActive = { id: 'x', name: 'Mudhoney', 'life-span': { begin: '1988', end: null, ended: false } };
  const result = scoreVerification(band, mbStillActive, null);
  assert.equal(result.breakdown.years_active.score, 100);
});

test('scoreVerification years_active penalizes a mismatch between ongoing and ended', () => {
  const band = { name: 'X', years_active: '1990-present' };
  const mbEnded = { id: 'x', name: 'X', 'life-span': { begin: '1990', end: '1999', ended: true } };
  const result = scoreVerification(band, mbEnded, null);
  assert.ok(result.breakdown.years_active.score < 100);
});

test('scoreVerification years_active partial credit decays by 10 points per year of difference', () => {
  const band = { name: 'X', years_active: '1984-1997' };
  const mb = { id: 'x', name: 'X', 'life-span': { begin: '1984', end: '1997' } }; // exact match to sanity check
  assert.equal(scoreVerification(band, mb, null).breakdown.years_active.score, 100);

  const mbOff = { id: 'x', name: 'X', 'life-span': { begin: '1984', end: '2017' } }; // 20 years off
  const resultOff = scoreVerification(band, mbOff, null);
  assert.equal(resultOff.breakdown.years_active.score, 50); // avg(100 start, 0 end floored)
});

test('scoreVerification country field matches USA against MusicBrainz US', () => {
  const band = { name: 'X', country: 'USA' };
  const mb = { id: 'x', name: 'X', country: 'US' };
  assert.equal(scoreVerification(band, mb, null).breakdown.country.score, 100);
});

test('scoreVerification country field scores 0 on mismatch', () => {
  const band = { name: 'X', country: 'USA' };
  const mb = { id: 'x', name: 'X', country: 'GB' };
  assert.equal(scoreVerification(band, mb, null).breakdown.country.score, 0);
});

test('scoreVerification overall_score is the rounded average of only contributing fields', () => {
  const band = { name: 'X', country: 'USA' }; // only name + country have data
  const mb = { id: 'x', name: 'Y', country: 'US' }; // name mismatch (1 edit -> 90), country match (100)
  const result = scoreVerification(band, mb, null);
  assert.equal(Object.keys(result.breakdown).length, 2);
  assert.equal(result.overall_score, Math.round((result.breakdown.name.score + 100) / 2));
});
