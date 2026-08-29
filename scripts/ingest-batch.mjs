#!/usr/bin/env node
// -----------------------------------------------------------------------
// Batch ingestion runner (PR 2). Different from ingest-musicbrainz.mjs:
//
//   ingest-musicbrainz.mjs = "sweep the whole graph" (all seed persons)
//   ingest-batch.mjs       = "process this specific list" (both persons
//                             and bands, from a JSON config)
//
// Two ingestion modes:
//   1. PERSONS  -> bridge-fill: their other bands become candidates
//   2. BANDS    -> direct-fill: the band + all its MB members become
//                  proposed new rows (band not yet in the graph)
//
// Both modes score with the same confidence tiers and route to the same
// output CSV format so the operator sees one review pile, not two.
//
// Enrichment mode (opt-in, --enrich):
//   For EXISTING bands in the seed CSV, fetch their MB detail and
//   propose backfills for city/genre/yearsActive where the seed row
//   has an empty value and MB has a better one. Enrichment rows go to
//   candidates-enrichment.csv so they're visually distinct from new
//   band proposals.
//
// Usage:
//   node scripts/ingest-batch.mjs --config scripts/data/batch-1-seed.json
//        [--seed seattle_band_members-2-2.csv]
//        [--out scripts/output/batch-1]
//        [--enrich]
// -----------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  searchArtist,
  getArtistMembers,
} from './musicbrainz.mjs';
import { hasWikipediaArticle } from './wikipedia.mjs';
import {
  normalizeNameKey,
  formatTenure,
  scoreCandidate,
  csvRow,
} from './pipeline-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    config: null,
    seed: join(REPO_ROOT, 'seattle_band_members-2-2.csv'),
    out: null,
    enrich: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--seed') args.seed = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--enrich') args.enrich = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: ingest-batch.mjs --config <path> [--seed <path>] [--out <dir>] [--enrich]');
      process.exit(0);
    }
  }
  if (!args.config) {
    console.error('ERROR: --config is required');
    process.exit(1);
  }
  if (!args.out) {
    // Default output dir named after the config file's basename.
    const base = args.config.replace(/\.json$/, '').split('/').pop();
    args.out = join(__dirname, 'output', base);
  }
  return args;
}

// ---------------------------------------------------------------------
// CSV parser (same minimal parser as ingest-musicbrainz.mjs — kept
// duplicated so this script doesn't depend on that one)
// ---------------------------------------------------------------------
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] || ''; });
    return obj;
  });
}
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// ---------------------------------------------------------------------
// Seed indexing — need three views:
//   bands:   Map<normKey, {displayName, rows[], rowIndex[]}>  (for enrichment)
//   persons: Map<normKey, displayName>                        (for bridge detection)
//   fullRows: original CSV rows preserved for enrichment diffing
// ---------------------------------------------------------------------
function buildSeedIndex(rows) {
  const bands = new Map();
  const persons = new Map();
  rows.forEach((r, i) => {
    if (r.source_type === 'band' && r.source) {
      const k = normalizeNameKey(r.source);
      if (!bands.has(k)) bands.set(k, { displayName: r.source, rows: [], rowIndex: [] });
      bands.get(k).rows.push(r);
      bands.get(k).rowIndex.push(i);
    }
    if (r.target_type === 'person' && r.target) {
      persons.set(normalizeNameKey(r.target), r.target);
    }
    // Occasional band-band or person-person rows exist for safety
    if (r.source_type === 'person' && r.source) {
      persons.set(normalizeNameKey(r.source), r.source);
    }
  });
  return { bands, persons };
}

// ---------------------------------------------------------------------
// MB overrides loader
// ---------------------------------------------------------------------
async function loadOverrides() {
  const path = join(__dirname, 'data', 'mbid-overrides.json');
  if (!existsSync(path)) return {};
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------
// Resolved-MBID cache: name -> MBID pairs learned during previous runs.
// This lets us do MB detail fetches on future runs without redoing the
// search step (which is ~180 requests for a full seed sweep).
// The cache lives at scripts/data/resolved-mbids.json; it's committed
// so all operators share the same resolution history.
// ---------------------------------------------------------------------
const RESOLVED_CACHE_PATH = join(__dirname, 'data', 'resolved-mbids.json');

async function loadResolvedCache() {
  if (!existsSync(RESOLVED_CACHE_PATH)) {
    return { bands: {}, persons: {}, generatedAt: null };
  }
  try {
    return JSON.parse(await readFile(RESOLVED_CACHE_PATH, 'utf8'));
  } catch {
    return { bands: {}, persons: {}, generatedAt: null };
  }
}

async function saveResolvedCache(cache) {
  cache.generatedAt = new Date().toISOString();
  await writeFile(RESOLVED_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');
}

// Only cache high-confidence matches. Anything below the strong-match
// threshold could be a genuine wrong artist (common name collisions,
// disambiguation traps). Overrides are the only mechanism for those.
const CACHE_MIN_SCORE = 95;

function cachePersonResolution(cache, name, resolved, stats) {
  if (!cache.persons) cache.persons = {};
  if (resolved.source === 'override') return; // don't shadow overrides
  if (resolved.source === 'cache') { stats.hits += 1; return; } // already cached
  if (typeof resolved.score === 'number' && resolved.score < CACHE_MIN_SCORE) return;
  const key = normalizeNameKey(name);
  if (cache.persons[key]?.mbid === resolved.mbid) { stats.hits += 1; return; }
  cache.persons[key] = {
    mbid: resolved.mbid,
    name,
    score: resolved.score,
    resolvedAt: new Date().toISOString(),
  };
  stats.additions += 1;
}

function cacheBandResolution(cache, name, resolved, stats) {
  if (!cache.bands) cache.bands = {};
  if (resolved.source === 'override') return;
  if (resolved.source === 'cache') { stats.hits += 1; return; }
  if (typeof resolved.score === 'number' && resolved.score < CACHE_MIN_SCORE) return;
  const key = normalizeNameKey(name);
  if (cache.bands[key]?.mbid === resolved.mbid) { stats.hits += 1; return; }
  cache.bands[key] = {
    mbid: resolved.mbid,
    name,
    score: resolved.score,
    resolvedAt: new Date().toISOString(),
  };
  stats.additions += 1;
}

async function resolveMbid(name, overrides, { type, log, cache = null }) {
  if (overrides[name]) {
    return { mbid: overrides[name].mbid, source: 'override', score: 100 };
  }
  // Check the shared resolved-MBID cache before hitting MB search.
  if (cache) {
    const key = normalizeNameKey(name);
    const bucket = type === 'Person' ? cache.persons : cache.bands;
    const hit = bucket?.[key];
    if (hit?.mbid) {
      log(`  cache hit: ${hit.mbid} (score ${hit.score} @ ${hit.resolvedAt})`);
      return { mbid: hit.mbid, source: 'cache', score: hit.score };
    }
  }
  const hits = await searchArtist(name, { type, limit: 3, log });
  if (hits.length === 0) return null;
  const top = hits[0];
  if (top.score < 95) {
    return { mbid: null, source: 'ambiguous', score: top.score, candidates: hits };
  }
  return { mbid: top.mbid, source: 'search', score: top.score };
}

// ---------------------------------------------------------------------
// Convert an MB country code (ISO 3166-1 alpha-2) to alpha-3 for the
// locked schema. This is a small pragmatic map — the seed uses "USA",
// "GBR" etc. so we need to translate.
// ---------------------------------------------------------------------
const ISO2_TO_ISO3 = {
  US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS', DE: 'DEU', FR: 'FRA',
  IE: 'IRL', SE: 'SWE', NO: 'NOR', DK: 'DNK', NL: 'NLD', BE: 'BEL',
  JP: 'JPN', NZ: 'NZL', IT: 'ITA', ES: 'ESP', BR: 'BRA', MX: 'MEX',
  FI: 'FIN', IS: 'ISL', PL: 'POL', CZ: 'CZE', AT: 'AUT', CH: 'CHE',
  PT: 'PRT', HU: 'HUN', GR: 'GRC', RU: 'RUS', UA: 'UKR', ZA: 'ZAF',
  AR: 'ARG', CL: 'CHL', IL: 'ISR', KR: 'KOR',
};
function toIso3(iso2) {
  return ISO2_TO_ISO3[iso2] || iso2 || '';
}

// USPS state extraction — MB gives us a city and country; state is
// only inferable for US bands, and only from the area chain. For the
// batch runner we punt (empty state) unless the MB city name maps to a
// known US city; the seed's own migration handled state assignment via
// KNOWN_CITY_LOCATIONS in location-helpers.mjs. Rather than replicate
// that mapping here we leave state blank and let the operator fill in
// during review. Better empty than wrong.
function usStateFor(_city) { return ''; }

// ---------------------------------------------------------------------
// Emit CSV rows in the seed schema:
//   source,target,source_type,target_type,relation_type,city,state,
//   country,genre,weight,Intrument 1,Intrument 2,Intrument 3,Intrument 4
// ---------------------------------------------------------------------
// 'Years Active' and 'Tenure' are additions to the legacy CSV shape, not part
// of the original Seattle export. Both are read by the seed endpoint
// (netlify/functions/seed_bands.mjs accepts 'Years Active' -> bands.years_active
// and 'Tenure' -> memberships.tenure), and both were being thrown away here:
// the MusicBrainz payload we already fetch and pay the rate limit for carries a
// life-span for the band and a begin/end for every single membership, and the
// pipeline read the years only as a yes/no confidence signal before discarding
// the actual values.
//
// The cost of that omission, measured against production: 495 of 499 bands have
// no years_active, every one of 2,757 musicians is missing theirs, and all 3,813
// memberships have a null tenure. That is why a card reads "YEARS ACTIVE —" and
// why every membership chip shows a name with no dates beside it.
//
// The seed endpoint fills these with coalesce(nullif(...)), so a backfill can
// only ever populate an empty column and can never overwrite something a person
// typed in by hand.
const SEED_HEADERS = [
  'source', 'target', 'source_type', 'target_type', 'relation_type',
  'city', 'state', 'country', 'genre', 'weight',
  'Years Active', 'Tenure',
  'Intrument 1', 'Intrument 2', 'Intrument 3', 'Intrument 4',
];

function proposedRowsForBand(bandDetail, { includeMembers = true } = {}) {
  const self = bandDetail.self;
  const city = self.beginArea || '';
  const country = toIso3(self.country);
  const state = usStateFor(city);
  // Genre picked from the most-tagged rock/metal/etc; join top 2 tags.
  const genre = (self.tags || [])
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map(t => t.name)
    .join(', ');
  // The band's own life-span. formatTenure renders "1969-1980" for a band that
  // has ended and "1973-present" for one that has not, reading MB's `ended`
  // flag rather than inferring from a missing end date — a band with no end
  // date recorded is not the same thing as a band still playing.
  const yearsActive = formatTenure({ begin: self.begin, end: self.end, ended: self.ended });
  const rows = [];
  if (includeMembers) {
    for (const rel of bandDetail.relations) {
      rows.push({
        source: self.name,
        target: rel.relatedName,
        source_type: 'band',
        target_type: 'person',
        relation_type: 'member_of',
        city, state, country, genre,
        weight: 2,
        'Years Active': yearsActive,
        // Per-membership dates, which are a different fact from the band's own
        // life-span: this is when THIS musician was in THIS band, and it is what
        // a membership chip shows beside the name.
        Tenure: formatTenure(rel),
        'Intrument 1': '', 'Intrument 2': '', 'Intrument 3': '', 'Intrument 4': '',
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// Enrichment: for an existing band in the seed graph, propose column
// backfills. Returns an array of { rowIndex, field, oldValue, newValue,
// mbSource } describing each proposed change. Only fills EMPTY fields
// (never overwrites human-entered data).
// ---------------------------------------------------------------------
function proposeEnrichments(seedBand, mbDetail) {
  const proposals = [];
  const mbCity = mbDetail.self.beginArea || '';
  const mbCountry = toIso3(mbDetail.self.country);
  const mbGenre = (mbDetail.self.tags || [])
    .sort((a, b) => b.count - a.count).slice(0, 2)
    .map(t => t.name).join(', ');
  for (let i = 0; i < seedBand.rows.length; i++) {
    const row = seedBand.rows[i];
    const rowIdx = seedBand.rowIndex[i];
    if (!row.city && mbCity) {
      proposals.push({ rowIndex: rowIdx, field: 'city', oldValue: '', newValue: mbCity, source: 'musicbrainz' });
    }
    if (!row.country && mbCountry) {
      proposals.push({ rowIndex: rowIdx, field: 'country', oldValue: '', newValue: mbCountry, source: 'musicbrainz' });
    }
    if (!row.genre && mbGenre) {
      proposals.push({ rowIndex: rowIdx, field: 'genre', oldValue: '', newValue: mbGenre, source: 'musicbrainz-tags' });
    }
    // Years active. The header comment for this function has always claimed to
    // backfill it and never did, which is a large part of why 495 of the 499
    // bands in production have an empty years_active and every card reads
    // "YEARS ACTIVE —". The value is already in the MB payload this loop is
    // holding; it was simply never proposed.
    const mbYears = formatTenure({
      begin: detail.self.begin,
      end: detail.self.end,
      ended: detail.self.ended,
    });
    if (!row['Years Active'] && mbYears) {
      proposals.push({
        rowIndex: rowIdx,
        field: 'years_active',
        oldValue: '',
        newValue: mbYears,
        source: 'musicbrainz-lifespan',
      });
    }
  }
  return proposals;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const log = (...m) => console.log(...m);

  log('=== Batch ingestion runner ===');
  log(`Config: ${args.config}`);
  log(`Seed:   ${args.seed}`);
  log(`Out:    ${args.out}`);
  log(`Enrich: ${args.enrich}`);
  if (args.limit) log(`Limit:  ${args.limit} (dry-run subset)`);
  log('');

  const configRaw = JSON.parse(await readFile(args.config, 'utf8'));
  // Apply --limit to both persons and bands lists for dry-run subsets.
  const config = args.limit
    ? { ...configRaw,
        persons: (configRaw.persons || []).slice(0, args.limit),
        bands:   (configRaw.bands   || []).slice(0, args.limit),
      }
    : configRaw;
  const seedText = await readFile(args.seed, 'utf8');
  const seedRows = parseCsv(seedText);
  const seed = buildSeedIndex(seedRows);
  const overrides = await loadOverrides();

  log(`Seed:      ${seed.bands.size} bands, ${seed.persons.size} persons`);
  log(`Persons to sweep:  ${(config.persons || []).length}`);
  log(`Bands to ingest:   ${(config.bands || []).length}`);
  log(`Overrides:         ${Object.keys(overrides).length}`);
  log('');

  const candidates = new Map(); // mbid -> aggregated candidate record
  const resolveLog = [];

  // Load resolved-MBID cache. Any successful search-based resolution
  // (source: 'search' or 'search-strong') that isn't already an override
  // gets written back to the cache, so future runs skip the search step.
  const resolvedCache = await loadResolvedCache();
  const cacheHits = { hits: 0, additions: 0 };

  // -------------------------------------------------------------------
  // Phase 1: PERSONS (bridge-fill)
  // -------------------------------------------------------------------
  for (const personName of (config.persons || [])) {
    log(`\n[person] ${personName}`);
    let resolved;
    try {
      resolved = await resolveMbid(personName, overrides, { type: 'Person', log, cache: resolvedCache });
    } catch (err) {
      log(`  ! resolve error: ${err.message}`);
      resolveLog.push({ name: personName, kind: 'person', status: 'error', error: err.message });
      continue;
    }
    if (!resolved?.mbid) {
      log(`  ! could not resolve (top score ${resolved?.score ?? '-'})`);
      resolveLog.push({ name: personName, kind: 'person', status: 'unresolved', ...(resolved || {}) });
      continue;
    }
    resolveLog.push({ name: personName, kind: 'person', status: 'resolved', ...resolved });
    cachePersonResolution(resolvedCache, personName, resolved, cacheHits);

    let personData;
    try {
      personData = await getArtistMembers(resolved.mbid, { log });
    } catch (err) {
      log(`  ! relations fetch failed: ${err.message}`);
      continue;
    }

    const seenBandMbid = new Set();
    for (const rel of personData.relations) {
      if (seenBandMbid.has(rel.relatedMbid)) continue;
      seenBandMbid.add(rel.relatedMbid);
      const bandKey = normalizeNameKey(rel.relatedName);
      if (seed.bands.has(bandKey)) {
        log(`    (skip) ${rel.relatedName} — already in graph`);
        continue;
      }
      let candidate = candidates.get(rel.relatedMbid);
      if (!candidate) {
        candidate = {
          mbid: rel.relatedMbid,
          name: rel.relatedName,
          origin: 'bridge-fill',
          bridgesFrom: [],
          detail: null,
          wikipedia: null,
        };
        candidates.set(rel.relatedMbid, candidate);
      }
      candidate.bridgesFrom.push({
        personName,
        personMbid: resolved.mbid,
        tenure: formatTenure(rel),
      });
    }
  }

  // -------------------------------------------------------------------
  // Phase 2: BANDS (direct ingest)
  // -------------------------------------------------------------------
  for (const bandName of (config.bands || [])) {
    log(`\n[band] ${bandName}`);
    let resolved;
    try {
      resolved = await resolveMbid(bandName, overrides, { type: 'Group', log, cache: resolvedCache });
    } catch (err) {
      log(`  ! resolve error: ${err.message}`);
      resolveLog.push({ name: bandName, kind: 'band', status: 'error', error: err.message });
      continue;
    }
    if (!resolved?.mbid) {
      log(`  ! could not resolve`);
      resolveLog.push({ name: bandName, kind: 'band', status: 'unresolved', ...(resolved || {}) });
      continue;
    }
    resolveLog.push({ name: bandName, kind: 'band', status: 'resolved', ...resolved });
    cacheBandResolution(resolvedCache, bandName, resolved, cacheHits);

    // Skip if already in graph — direct-ingest is only for NEW bands.
    if (seed.bands.has(normalizeNameKey(bandName))) {
      log(`  ! already in graph — nothing to add`);
      continue;
    }

    if (!candidates.has(resolved.mbid)) {
      candidates.set(resolved.mbid, {
        mbid: resolved.mbid,
        name: bandName,
        origin: 'direct-ingest',
        bridgesFrom: [],
        detail: null,
        wikipedia: null,
      });
    } else {
      // It was already discovered as a bridge candidate — mark it as
      // also-direct so the review knows the user explicitly wanted it.
      candidates.get(resolved.mbid).origin = 'direct-ingest+bridge';
    }
  }

  // -------------------------------------------------------------------
  // Score every candidate
  // -------------------------------------------------------------------
  log(`\n=== Scoring ${candidates.size} candidates ===`);
  const scored = [];
  let idx = 0;
  for (const candidate of candidates.values()) {
    idx++;
    log(`\n[${idx}/${candidates.size}] ${candidate.name} (${candidate.origin})`);
    try {
      candidate.detail = await getArtistMembers(candidate.mbid, { log });
    } catch (err) {
      log(`  ! detail failed: ${err.message}`);
      continue;
    }
    try {
      candidate.wikipedia = await hasWikipediaArticle(candidate.name, { log });
    } catch (err) {
      candidate.wikipedia = { exists: false, error: err.message };
    }

    const memberCount = candidate.detail.relations.length;
    const memberKeysInGraph = new Set(
      candidate.detail.relations
        .map(r => normalizeNameKey(r.relatedName))
        .filter(k => seed.persons.has(k))
    );
    const existingConnections = memberKeysInGraph.size;

    const score = scoreCandidate({
      existingConnections,
      memberCount,
      hasWikipediaArticle: !!(candidate.wikipedia?.exists && !candidate.wikipedia?.isDisambiguation),
      hasBeginArea: !!candidate.detail.self.beginArea,
      hasBeginYear: !!candidate.detail.self.begin,
      origin: candidate.origin,
    });

    scored.push({
      mbid: candidate.mbid,
      name: candidate.name,
      origin: candidate.origin,
      score: score.score,
      tier: score.tier,
      signals: score.signals,
      existingConnections,
      memberCount,
      membersInGraph: [...memberKeysInGraph].map(k => seed.persons.get(k)).sort(),
      city: candidate.detail.self.beginArea,
      country: candidate.detail.self.country,
      begin: candidate.detail.self.begin,
      end: candidate.detail.self.end,
      wikipediaExists: !!candidate.wikipedia?.exists,
      wikipediaDisambiguation: !!candidate.wikipedia?.isDisambiguation,
      bridgesFrom: candidate.bridgesFrom.map(b => b.personName),
      proposedRows: proposedRowsForBand(candidate.detail),
    });
    log(`  score=${score.score} tier=${score.tier} bridges=${existingConnections} members=${memberCount} wiki=${candidate.wikipedia?.exists ? 'yes' : 'no'}`);
  }

  // -------------------------------------------------------------------
  // Phase 3 (optional): enrichment scan of EXISTING bands in the seed
  // -------------------------------------------------------------------
  const enrichments = [];
  if (args.enrich) {
    log(`\n=== Enrichment scan of existing bands ===`);
    // The resolved-mbids cache is bootstrapped by earlier runs +
    // in-run resolutions. We combine it with manual overrides to widen
    // enrichment coverage without burning ~180 more MB search requests
    // on every scan.
    const bandMbids = new Map(); // seed band key -> mbid
    // Pull from overrides first (they take precedence)
    for (const [name, o] of Object.entries(overrides)) {
      const key = normalizeNameKey(name);
      if (seed.bands.has(key)) bandMbids.set(key, { mbid: o.mbid, source: 'override' });
    }
    // Then pull from the resolved cache for bands not yet pinned
    for (const [key, entry] of Object.entries(resolvedCache.bands || {})) {
      if (seed.bands.has(key) && !bandMbids.has(key)) {
        bandMbids.set(key, { mbid: entry.mbid, source: 'cache' });
      }
    }
    log(`  seed bands with resolvable MBID: ${bandMbids.size}/${seed.bands.size}`);

    for (const [key, { mbid, source }] of bandMbids) {
      const seedBand = seed.bands.get(key);
      log(`\n[enrich ${source}] ${seedBand.displayName}`);
      let detail;
      try {
        detail = await getArtistMembers(mbid, { log });
      } catch (err) {
        log(`  ! detail failed: ${err.message}`);
        continue;
      }
      const proposals = proposeEnrichments(seedBand, detail);
      log(`  ${proposals.length} field-level enrichments proposed`);
      for (const p of proposals) enrichments.push({ band: seedBand.displayName, ...p });
    }
  }

  // -------------------------------------------------------------------
  // Emit outputs
  // -------------------------------------------------------------------
  await mkdir(args.out, { recursive: true });

  const tiers = { high: [], medium: [], low: [] };
  for (const s of scored) tiers[s.tier].push(s);

  // Tier CSVs (summary — one row per candidate band)
  const summaryHeaders = [
    'tier', 'score', 'name', 'origin', 'mbid', 'city', 'country',
    'begin', 'end', 'existingConnections', 'memberCount',
    'wikipediaExists', 'bridgesFrom', 'membersInGraph',
  ];
  for (const tier of ['high', 'medium', 'low']) {
    const rows = tiers[tier].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const path = join(args.out, `candidates-${tier}.csv`);
    const lines = [summaryHeaders.join(',')];
    for (const s of rows) {
      lines.push(csvRow(summaryHeaders, {
        ...s,
        bridgesFrom: s.bridgesFrom.join('; '),
        membersInGraph: s.membersInGraph.join('; '),
      }));
    }
    await writeFile(path, lines.join('\n') + '\n', 'utf8');
    log(`  wrote ${tier.padEnd(6)} → ${path}  (${rows.length} rows)`);
  }

  // Proposed rows CSV (append-ready — matches the seed schema exactly).
  // Only the HIGH tier by default; medium goes to a separate staging file.
  for (const tier of ['high', 'medium']) {
    const proposedLines = [SEED_HEADERS.join(',')];
    for (const s of tiers[tier]) {
      for (const row of s.proposedRows) {
        proposedLines.push(csvRow(SEED_HEADERS, row));
      }
    }
    const path = join(args.out, `proposed-rows-${tier}.csv`);
    await writeFile(path, proposedLines.join('\n') + '\n', 'utf8');
    log(`  wrote ${tier.padEnd(6)} proposed rows → ${path}`);
  }

  if (args.enrich) {
    const enrichPath = join(args.out, 'enrichments.csv');
    const enrichHeaders = ['band', 'rowIndex', 'field', 'oldValue', 'newValue', 'source'];
    const enrichLines = [enrichHeaders.join(',')];
    for (const e of enrichments) enrichLines.push(csvRow(enrichHeaders, e));
    await writeFile(enrichPath, enrichLines.join('\n') + '\n', 'utf8');
    log(`  wrote enrichments → ${enrichPath}  (${enrichments.length} field updates)`);
  }

  // Full summary
  await writeFile(
    join(args.out, 'run-summary.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      config: args.config,
      seedStats: { bands: seed.bands.size, persons: seed.persons.size },
      resolved: resolveLog,
      candidates: scored,
      enrichments,
      counts: {
        candidates: scored.length,
        high: tiers.high.length,
        medium: tiers.medium.length,
        low: tiers.low.length,
        enrichments: enrichments.length,
      },
    }, null, 2),
    'utf8',
  );

  // Persist the resolved-MBID cache: any new high-confidence matches
  // learned during this run get shared with future runs.
  if (cacheHits.additions > 0) {
    await saveResolvedCache(resolvedCache);
    log(`  cache:       +${cacheHits.additions} new entries (${cacheHits.hits} confirmed)`);
  }

  log('\n=== Done ===');
  log(`  candidates:  ${scored.length}`);
  log(`  high:        ${tiers.high.length}`);
  log(`  medium:      ${tiers.medium.length}`);
  log(`  low:         ${tiers.low.length}`);
  if (args.enrich) log(`  enrichments: ${enrichments.length}`);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
