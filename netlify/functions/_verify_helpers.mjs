// Shared helpers for the cross-check feature (PR 4a).
//
// Why this file exists: verify_band.mjs is the HTTP endpoint (auth, DB
// I/O, caching); everything that's pure computation or external-API
// plumbing lives here instead, so it can be unit tested without a database
// or network access (tests mock fetchMusicBrainz/fetchWikipedia's
// dependency, the global fetch, not these functions themselves).
//
// Design note on "lock" vs "cross-check": per the product design, this is
// NOT a lock that blocks edits. It's a read-only verification RESULT
// (score + breakdown) computed by comparing our band row against
// MusicBrainz (primary, structured) and Wikipedia (secondary, fuzzy
// corroboration). Nothing here mutates band data.

const MUSICBRAINZ_USER_AGENT = 'bandmembers-bot/1.0 (https://bandmembers.netlify.app; vimana17@gmail.com)';
const WIKIPEDIA_USER_AGENT = MUSICBRAINZ_USER_AGENT;

// --- Normalization utilities -------------------------------------------------
// Kept pure and dependency-free so they're trivially testable and reusable
// between scoring and the live fetch helpers.

// Lowercase + trim + strip a leading "The " — the most common source of
// spurious name mismatches between our data, MusicBrainz, and Wikipedia
// (e.g. "The Melvins" vs "Melvins").
export function normalizeBandName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/^the\s+/, '');
}

// Wikipedia titles frequently carry a disambiguation suffix like
// " (band)" or " (American band)" — strip any trailing parenthetical
// before comparing names.
export function stripWikipediaDisambiguation(title) {
  if (typeof title !== 'string') return '';
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Small ISO-3166 alpha-3 <-> alpha-2 lookup covering the top ~20 countries
// likely to appear in the source CSV (and a few more common ones for
// robustness). MusicBrainz's `country` field is alpha-2; our data stores
// alpha-3 (see bands_create.mjs's normalizeCountryCode). Not exhaustive —
// this is a hobby-scale app, not a full ISO table.
export const COUNTRY_ALPHA3_TO_ALPHA2 = {
  USA: 'US',
  GBR: 'GB',
  CAN: 'CA',
  AUS: 'AU',
  DEU: 'DE',
  IRL: 'IE',
  NOR: 'NO',
  SWE: 'SE',
  NZL: 'NZ',
  ZAF: 'ZA',
  FRA: 'FR',
  ITA: 'IT',
  ESP: 'ES',
  NLD: 'NL',
  JPN: 'JP',
  MEX: 'MX',
  BRA: 'BR',
  FIN: 'FI',
  DNK: 'DK',
  BEL: 'BE',
  CHE: 'CH',
  AUT: 'AT',
  PRT: 'PT',
  POL: 'PL',
  RUS: 'RU',
};
// Reverse lookup, derived rather than duplicated so the two tables can
// never drift apart.
export const COUNTRY_ALPHA2_TO_ALPHA3 = Object.fromEntries(
  Object.entries(COUNTRY_ALPHA3_TO_ALPHA2).map(([a3, a2]) => [a2, a3])
);

export function canonicalizeCountryCode(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return '';
  if (trimmed.length === 3) return trimmed; // already alpha-3 (our schema)
  if (trimmed.length === 2) return COUNTRY_ALPHA2_TO_ALPHA3[trimmed] || trimmed;
  return trimmed;
}

// True if an alpha-3 (ours) and alpha-2 (MusicBrainz) code refer to the
// same country.
export function countryCodesMatch(alpha3, alpha2) {
  if (!alpha3 || !alpha2) return false;
  const mapped = COUNTRY_ALPHA3_TO_ALPHA2[alpha3.trim().toUpperCase()];
  return Boolean(mapped) && mapped === alpha2.trim().toUpperCase();
}

// Parse our free-form years_active string into { start, end, present }.
// Accepts: '1987-1994', '1987–1994' (en dash), '1987-', '1987', '1987-present'.
// `end` is null when open-ended; `present` is true when explicitly marked
// ongoing (trailing '-' or the literal word 'present').
export function parseYearsActive(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/–/g, '-'); // normalize en dash to hyphen
  if (!cleaned) return null;

  const rangeMatch = /^(\d{4})\s*-\s*(\d{4}|present)?$/i.exec(cleaned);
  if (rangeMatch) {
    const start = rangeMatch[1];
    const endRaw = rangeMatch[2];
    if (!endRaw) return { start, end: null, present: true };
    if (/present/i.test(endRaw)) return { start, end: null, present: true };
    return { start, end: endRaw, present: false };
  }

  const singleYear = /^(\d{4})$/.exec(cleaned);
  if (singleYear) return { start: singleYear[1], end: null, present: false };

  return null; // unparseable — caller treats as "no data"
}

// --- Levenshtein-ish edit distance -------------------------------------------
// Standard dynamic-programming edit distance. Used for fuzzy name scoring
// per the spec: "100 - edit distance * 10, floored at 0".
export function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array(n + 1);
  let curRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    curRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        curRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    [prevRow, curRow] = [curRow, prevRow];
  }
  return prevRow[n];
}

// Score a pair of normalized name strings 0-100. 100 on exact match,
// otherwise decays by 10 points per edit-distance unit, floored at 0.
export function scoreNameMatch(oursNormalized, theirsNormalized) {
  if (!oursNormalized || !theirsNormalized) return null;
  if (oursNormalized === theirsNormalized) return 100;
  const dist = editDistance(oursNormalized, theirsNormalized);
  return Math.max(0, 100 - dist * 10);
}

// --- External fetch helpers ---------------------------------------------------
// Both wrapped so verify_band.mjs (and tests) can mock the single
// `fetchImpl` dependency instead of the global fetch, and so 429s get a
// consistent, greppable log line.

function logIfRateLimited(serviceName, status) {
  if (status === 429) {
    // Explicit, greppable prefix per the task's production-logging ask.
    console.error(`external service rate limited: ${serviceName} returned 429`);
  }
}

// Search MusicBrainz for a band by name (+ optional country disambiguation)
// and return the best-matching artist object, or null if nothing usable
// came back. `fetchImpl` defaults to global fetch; tests inject a mock.
export async function fetchMusicBrainz(bandName, { country, fetchImpl = fetch } = {}) {
  const name = typeof bandName === 'string' ? bandName.trim() : '';
  if (!name) return { ok: false, error: 'no band name provided' };

  let query = name;
  const alpha2 = country ? COUNTRY_ALPHA3_TO_ALPHA2[country.trim().toUpperCase()] : null;
  if (alpha2) query += ` AND country:${alpha2}`;

  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}&fmt=json&limit=5`;

  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
  } catch (err) {
    return { ok: false, error: `network error contacting musicbrainz: ${err && err.message ? err.message : err}` };
  }

  logIfRateLimited('musicbrainz', res.status);
  if (!res.ok) {
    return { ok: false, error: `musicbrainz returned ${res.status}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, error: 'musicbrainz returned invalid JSON' };
  }

  const artists = Array.isArray(data.artists) ? data.artists : [];
  if (!artists.length) return { ok: true, artist: null };

  // Match strategy: prefer the top-scoring Group-type match, then
  // Person-type (solo artists like Sir Mix-a-Lot), then the top overall
  // result. For each candidate in that order, apply the name-similarity
  // quality floor: if the top-priority Group is unrelated (e.g. "Camp
  // Hero" -> "Megadeth"), skip it and try the next candidate.
  const oursNorm = normalizeBandName(name);
  const bestGroup = artists.find(a => a && a.type === 'Group');
  const bestPerson = artists.find(a => a && a.type === 'Person');
  const orderedCandidates = [bestGroup, bestPerson, artists[0]].filter(
    (a, i, arr) => a && arr.indexOf(a) === i
  );

  for (const candidate of orderedCandidates) {
    if (!candidate.name) continue;
    const nameScore = scoreNameMatch(oursNorm, normalizeBandName(candidate.name));
    if (nameScore === null || nameScore >= MB_NAME_QUALITY_FLOOR) {
      return { ok: true, artist: candidate };
    }
  }
  // All candidates failed the quality floor -> no plausible match.
  return { ok: true, artist: null };
}

// Reject MusicBrainz candidates whose normalized-name score is below this
// floor. 40 is loose enough to accept small variants (typo, punctuation,
// missing "the") while rejecting completely different bands returned by
// MB's fuzzy search.
export const MB_NAME_QUALITY_FLOOR = 40;

// Reject Wikipedia summary-search fallbacks whose title shares no
// meaningful tokens with our band name. Wikipedia's search often returns
// unrelated but keyword-adjacent pages ("Christ on a Crutch" -> "Nate
// Mendel") which would otherwise silently poison the name score.
export function wikipediaTitleIsPlausibleMatch(bandName, title) {
  const stopwords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'to']);
  const tokenize = s => new Set(
    s.toLowerCase().split(/\W+/).filter(t => t && !stopwords.has(t))
  );
  const ours = tokenize(bandName || '');
  const theirs = tokenize(title || '');
  if (!ours.size || !theirs.size) return false;
  // Require at least one significant (non-stopword) token to overlap.
  for (const tok of ours) if (theirs.has(tok)) return true;
  return false;
}

// Fetch a Wikipedia summary for a band. Tries the direct summary endpoint
// with a couple of common title guesses first (fast path, no search call
// needed for the common case), then falls back to the search API to find
// the right page. Returns { ok, page } where page is null if nothing found.
export async function fetchWikipedia(bandName, { fetchImpl = fetch } = {}) {
  const name = typeof bandName === 'string' ? bandName.trim() : '';
  if (!name) return { ok: false, error: 'no band name provided' };

  const directCandidates = [`${name} (band)`, name];

  for (const candidate of directCandidates) {
    const title = candidate.replace(/\s+/g, '_');
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': WIKIPEDIA_USER_AGENT } });
    } catch (err) {
      return { ok: false, error: `network error contacting wikipedia: ${err && err.message ? err.message : err}` };
    }
    logIfRateLimited('wikipedia', res.status);
    if (res.status === 429) return { ok: false, error: 'wikipedia rate limited' };
    if (res.ok) {
      let data;
      try {
        data = await res.json();
      } catch {
        continue;
      }
      // Disambiguation pages have no useful extract; skip them.
      if (data && data.type !== 'disambiguation' && data.extract) {
        return { ok: true, page: data };
      }
    }
    // 404 or unusable payload -> try next candidate.
  }

  // Fall back to the search API to find the right page title.
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(name + ' band')}&srlimit=3`;
  let searchRes;
  try {
    searchRes = await fetchImpl(searchUrl, { headers: { 'User-Agent': WIKIPEDIA_USER_AGENT } });
  } catch (err) {
    return { ok: false, error: `network error contacting wikipedia search: ${err && err.message ? err.message : err}` };
  }
  logIfRateLimited('wikipedia', searchRes.status);
  if (!searchRes.ok) return { ok: false, error: `wikipedia search returned ${searchRes.status}` };

  let searchData;
  try {
    searchData = await searchRes.json();
  } catch {
    return { ok: false, error: 'wikipedia search returned invalid JSON' };
  }

  const hits = searchData && searchData.query && Array.isArray(searchData.query.search) ? searchData.query.search : [];
  if (!hits.length) return { ok: true, page: null };

  // Wikipedia's search likes to return keyword-adjacent but unrelated
  // pages (e.g. searching "Christ on a Crutch band" returns "Nate Mendel"
  // because he played in that band once). Skip until we find a hit whose
  // title shares a significant token with our band name, or give up.
  const plausibleHit = hits.find(h => h && h.title && wikipediaTitleIsPlausibleMatch(name, h.title));
  if (!plausibleHit) return { ok: true, page: null };

  const topTitle = plausibleHit.title;
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topTitle.replace(/\s+/g, '_'))}`;
  let summaryRes;
  try {
    summaryRes = await fetchImpl(summaryUrl, { headers: { 'User-Agent': WIKIPEDIA_USER_AGENT } });
  } catch (err) {
    return { ok: false, error: `network error contacting wikipedia: ${err && err.message ? err.message : err}` };
  }
  logIfRateLimited('wikipedia', summaryRes.status);
  if (!summaryRes.ok) return { ok: true, page: null };

  let summaryData;
  try {
    summaryData = await summaryRes.json();
  } catch {
    return { ok: true, page: null };
  }
  if (!summaryData || !summaryData.extract) return { ok: true, page: null };
  return { ok: true, page: summaryData };
}

// --- Scoring ------------------------------------------------------------------
//
// Overall philosophy per spec: each field gets an independent 0-100 score.
// A field only "contributes" to the overall average when there is
// comparable data on BOTH sides for at least one external source; fields
// where we have nothing, or where both external sources have nothing, are
// skipped (neutral, not penalized).

function tokenOverlapScore(a, b) {
  const at = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const bt = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!at.size || !bt.size) return 0;
  for (const tok of at) if (bt.has(tok)) return 40;
  return 0;
}

function scoreNameField(ours, mbArtist, wikiPage) {
  const oursNorm = normalizeBandName(ours);
  if (!oursNorm) return null; // no data on our side -> skip

  const result = { ours: ours || null, musicbrainz: null, wikipedia: null, notes: '' };
  const notes = [];
  const scores = [];

  if (mbArtist && mbArtist.name) {
    const mbNorm = normalizeBandName(mbArtist.name);
    const s = scoreNameMatch(oursNorm, mbNorm);
    if (s !== null) {
      scores.push(s);
      result.musicbrainz = mbArtist.name;
      notes.push(s === 100 ? 'exact match vs MusicBrainz' : `fuzzy match vs MusicBrainz (score ${s})`);
    }
  }
  if (wikiPage && wikiPage.title) {
    const wikiNorm = normalizeBandName(stripWikipediaDisambiguation(wikiPage.title));
    const s = scoreNameMatch(oursNorm, wikiNorm);
    if (s !== null) {
      scores.push(s);
      result.wikipedia = wikiPage.title;
      notes.push(s === 100 ? 'exact match vs Wikipedia title' : `fuzzy match vs Wikipedia title (score ${s})`);
    }
  }

  if (!scores.length) return null; // neither source had comparable data
  result.score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  result.notes = notes.join('; ');
  return result;
}

function scoreCountryField(ours, mbArtist) {
  const oursCode = canonicalizeCountryCode(ours);
  if (!oursCode) return null; // no data on our side

  const result = { ours: ours || null, musicbrainz: null, wikipedia: null, notes: '' };
  if (!mbArtist || !mbArtist.country) return null; // no comparable external data (wikipedia country not parsed per instructions)

  result.musicbrainz = mbArtist.country;
  const match = countryCodesMatch(oursCode, mbArtist.country);
  result.score = match ? 100 : 0;
  result.notes = match
    ? `matches MusicBrainz country code ${mbArtist.country}`
    : `our country (${oursCode}) does not match MusicBrainz (${mbArtist.country})`;
  return result;
}

function scoreCityField(ours, mbArtist, wikiPage) {
  const oursCity = typeof ours === 'string' ? ours.trim() : '';
  if (!oursCity) return null; // no data on our side

  const mbAreaName = mbArtist && mbArtist['begin-area'] && mbArtist['begin-area'].name
    ? mbArtist['begin-area'].name
    : (mbArtist && mbArtist.area && mbArtist.area.name ? mbArtist.area.name : null);

  const result = { ours: oursCity, musicbrainz: mbAreaName || null, wikipedia_mentions: null, notes: '' };

  if (mbAreaName && mbAreaName.toLowerCase().includes(oursCity.toLowerCase())) {
    result.score = 100;
    result.notes = `our city appears in MusicBrainz area "${mbAreaName}"`;
    return result;
  }

  if (wikiPage && wikiPage.extract) {
    const mentioned = wikiPage.extract.toLowerCase().includes(oursCity.toLowerCase());
    result.wikipedia_mentions = mentioned;
    if (mentioned) {
      result.score = 80;
      result.notes = 'our city is mentioned in the Wikipedia extract (weaker signal)';
      return result;
    }
  }

  // We had comparable data (MB area name or a Wikipedia extract) but no
  // match found in either -> score 0, still contributes.
  if (mbAreaName || (wikiPage && wikiPage.extract)) {
    result.score = 0;
    result.notes = 'our city was not found in MusicBrainz area or Wikipedia extract';
    return result;
  }

  return null; // both external sources gave nothing usable -> skip
}

function scoreGenreField(ours, mbArtist, wikiPage) {
  const oursGenre = typeof ours === 'string' ? ours.trim() : '';
  if (!oursGenre) return null; // no data on our side

  const tags = mbArtist && Array.isArray(mbArtist.tags) ? mbArtist.tags.map(t => t.name).filter(Boolean) : [];
  const result = { ours: oursGenre, musicbrainz_tags: tags.length ? tags : null, wikipedia_mentions: null, notes: '' };
  const oursLower = oursGenre.toLowerCase();

  if (tags.length) {
    let best = 0;
    for (const tag of tags) {
      const tagLower = tag.toLowerCase();
      let s;
      if (tagLower === oursLower) s = 100;
      else if (tagLower.includes(oursLower) || oursLower.includes(tagLower)) s = 80;
      else s = tokenOverlapScore(oursLower, tagLower);
      if (s > best) best = s;
    }
    if (best > 0) {
      result.score = best;
      result.notes = `best fuzzy match against MusicBrainz tags (score ${best})`;
      return result;
    }
  }

  if (wikiPage && wikiPage.extract && wikiPage.extract.toLowerCase().includes(oursLower)) {
    result.wikipedia_mentions = true;
    result.score = 60;
    result.notes = 'our genre is mentioned in the Wikipedia extract (fallback signal)';
    return result;
  }

  if (tags.length || (wikiPage && wikiPage.extract)) {
    result.score = 0;
    result.notes = 'no match found among MusicBrainz tags or Wikipedia extract';
    if (wikiPage && wikiPage.extract) result.wikipedia_mentions = false;
    return result;
  }

  return null; // both sources gave nothing -> skip
}

function scoreYearsActiveField(ours, mbArtist, wikiPage) {
  const parsed = parseYearsActive(ours);
  if (!parsed) return null; // no usable data on our side

  const lifeSpan = mbArtist && mbArtist['life-span'] ? mbArtist['life-span'] : null;
  const result = {
    ours: ours || null,
    musicbrainz_life_span: lifeSpan ? { begin: lifeSpan.begin || null, end: lifeSpan.end || null } : null,
    wikipedia_mentions: null,
    notes: '',
  };

  if (lifeSpan && (lifeSpan.begin || lifeSpan.end || typeof lifeSpan.ended === 'boolean')) {
    const scores = [];
    const notes = [];

    if (parsed.start && lifeSpan.begin) {
      const oursYear = parseInt(parsed.start, 10);
      const mbYear = parseInt(String(lifeSpan.begin).slice(0, 4), 10);
      if (Number.isFinite(oursYear) && Number.isFinite(mbYear)) {
        const s = oursYear === mbYear ? 100 : Math.max(0, 100 - Math.abs(oursYear - mbYear) * 10);
        scores.push(s);
        notes.push(`start year ${s === 100 ? 'matches' : `off by ${Math.abs(oursYear - mbYear)}`}`);
      }
    }

    if (parsed.present || parsed.end === null) {
      // We believe the band is still active / open-ended.
      if (lifeSpan.ended === false) {
        scores.push(100);
        notes.push('both sources agree band is still active');
      } else if (lifeSpan.end) {
        // MB says it ended but we think it's ongoing -> mismatch.
        scores.push(0);
        notes.push('we show ongoing but MusicBrainz has an end date');
      }
    } else if (parsed.end && lifeSpan.end) {
      const oursYear = parseInt(parsed.end, 10);
      const mbYear = parseInt(String(lifeSpan.end).slice(0, 4), 10);
      if (Number.isFinite(oursYear) && Number.isFinite(mbYear)) {
        const s = oursYear === mbYear ? 100 : Math.max(0, 100 - Math.abs(oursYear - mbYear) * 10);
        scores.push(s);
        notes.push(`end year ${s === 100 ? 'matches' : `off by ${Math.abs(oursYear - mbYear)}`}`);
      }
    } else if (parsed.end && lifeSpan.ended === false) {
      // We show an end date but MB says still active -> mismatch.
      scores.push(0);
      notes.push('we show an end date but MusicBrainz shows the band as still active');
    }

    if (scores.length) {
      result.score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      result.notes = notes.join('; ');
      return result;
    }
  }

  // Fall back to Wikipedia: does the extract mention our start year?
  if (wikiPage && wikiPage.extract && parsed.start) {
    const mentioned = wikiPage.extract.includes(parsed.start);
    result.wikipedia_mentions = mentioned;
    if (mentioned) {
      result.score = 50;
      result.notes = 'start year mentioned in Wikipedia extract (fallback signal)';
      return result;
    }
    result.score = 0;
    result.notes = 'start year not found in MusicBrainz life-span or Wikipedia extract';
    return result;
  }

  return null; // no comparable data anywhere -> skip
}

// Compute the full breakdown + overall score for a band against whatever
// external data was found. `band` is the DB row (name, city, country,
// genre, years_active, ...). `mbArtist` and `wikiPage` may be null when
// that source found nothing / failed.
export function scoreVerification(band, mbArtist, wikiPage) {
  const breakdown = {};

  const name = scoreNameField(band.name, mbArtist, wikiPage);
  if (name) breakdown.name = name;

  const country = scoreCountryField(band.country, mbArtist);
  if (country) breakdown.country = country;

  const city = scoreCityField(band.city, mbArtist, wikiPage);
  if (city) breakdown.city = city;

  const genre = scoreGenreField(band.genre, mbArtist, wikiPage);
  if (genre) breakdown.genre = genre;

  const years = scoreYearsActiveField(band.years_active, mbArtist, wikiPage);
  if (years) breakdown.years_active = years;

  const contributing = Object.values(breakdown).filter(f => typeof f.score === 'number');
  const overall = contributing.length
    ? Math.round(contributing.reduce((sum, f) => sum + f.score, 0) / contributing.length)
    : 0;

  return { overall_score: overall, breakdown };
}
