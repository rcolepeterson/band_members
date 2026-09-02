#!/usr/bin/env node
// -----------------------------------------------------------------------
// Ingestion pipeline runner — proposes NEW bands to add to the graph.
//
// High-level flow:
//   1. Read the seed CSV to learn who's already in the graph.
//   2. For each existing PERSON, resolve them to a MusicBrainz MBID
//      (using mbid-overrides.json when available, else search).
//   3. For each resolved person, fetch their member-of-band relations.
//   4. Any band in those relations that is NOT already in the seed CSV
//      becomes a CANDIDATE new band.
//   5. For each candidate: fetch its full detail, count members that
//      overlap the seed graph, cross-check Wikipedia, compute confidence.
//   6. Write three output files:
//        - candidates-high.csv    (auto-merge tier)
//        - candidates-medium.csv  (staging for review)
//        - candidates-low.csv     (rejected, logged)
//      plus a run summary JSON.
//
// This script writes NOTHING to the live seed CSV or index.html. The
// operator picks up the high/medium CSVs and decides what to merge.
//
// Usage:
//   node scripts/ingest-musicbrainz.mjs [--seed <path>] [--limit N]
//                                        [--force-refresh] [--out <dir>]
//
// Flags:
//   --seed         Path to the seed CSV. Defaults to the one in repo root.
//   --limit        Only process the first N seed persons. Handy for a
//                  smoke test before a full run.
//   --force-refresh Bypass the on-disk cache (still writes new cache).
//   --out          Output directory. Defaults to scripts/output/.
// -----------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  searchArtist,
  getArtistMembers,
  partitionMemberRelations,
  looksLikeCollective,
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
// CLI arg parsing (minimal — no dep on yargs/commander for a script)
// ---------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    seed: join(REPO_ROOT, 'seattle_band_members-2-2.csv'),
    limit: 0,
    forceRefresh: false,
    out: join(__dirname, 'output'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') args.seed = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--force-refresh') args.forceRefresh = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ingest-musicbrainz.mjs [flags]

Flags:
  --seed <path>       Seed CSV (default: repo root's seattle_band_members-2-2.csv)
  --limit <N>         Only process first N seed persons (smoke tests)
  --force-refresh     Bypass the cache
  --out <dir>         Output directory (default: scripts/output/)
  -h, --help          Show this help

The pipeline is read-only against the live graph. It writes three CSVs
of proposed additions plus a summary JSON. No CSV in the repo is touched.`);
}

// ---------------------------------------------------------------------
// Seed CSV loader — minimal parser sufficient for this pipeline's needs.
// The site's own CSV loader is browser-side; this Node version handles
// quoted fields but doesn't need to match every edge case since we only
// read the seed, never rewrite it.
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
// Build the "existing graph" index from the seed CSV. We want two sets:
//   - existingBandNames: normalized names of bands already in the graph
//   - existingPersonNames: normalized names of persons already in the graph
// Both are used to detect bridges: a candidate band is a "bridge" if
// its MusicBrainz members overlap the person set.
// ---------------------------------------------------------------------
function buildSeedIndex(rows) {
  const bands = new Map();      // key -> displayName
  const persons = new Map();    // key -> displayName
  for (const r of rows) {
    if (r.source_type === 'band' && r.source) {
      bands.set(normalizeNameKey(r.source), r.source);
    }
    if (r.target_type === 'band' && r.target) {
      bands.set(normalizeNameKey(r.target), r.target);
    }
    if (r.source_type === 'person' && r.source) {
      persons.set(normalizeNameKey(r.source), r.source);
    }
    if (r.target_type === 'person' && r.target) {
      persons.set(normalizeNameKey(r.target), r.target);
    }
  }
  return { bands, persons };
}

// ---------------------------------------------------------------------
// MBID resolver — first checks manual overrides, then falls back to
// MusicBrainz search. Returns null if no confident match.
// ---------------------------------------------------------------------
async function loadOverrides() {
  const path = join(__dirname, 'data', 'mbid-overrides.json');
  if (!existsSync(path)) return {};
  const raw = JSON.parse(await readFile(path, 'utf8'));
  // Strip the `_comment` key so lookups don't trip on it.
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

async function resolveMbid(name, overrides, { type = 'Person', log = null } = {}) {
  if (overrides[name]) {
    return { mbid: overrides[name].mbid, source: 'override', score: 100 };
  }
  const hits = await searchArtist(name, { type, limit: 3, log });
  if (hits.length === 0) return null;
  const top = hits[0];
  // We accept the top hit only if score >= 95. Below that, disambiguation
  // risk is real (see: 39 "Pearl Jam" results) and we'd rather flag it
  // for override than silently pick wrong.
  if (top.score < 95) {
    if (log) log(`  ! low-confidence match for "${name}" (top score ${top.score}) — needs override`);
    return { mbid: null, source: 'ambiguous', score: top.score, candidates: hits };
  }
  return { mbid: top.mbid, source: 'search', score: top.score };
}

// ---------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const log = (...m) => console.log(...m);

  log('=== Six Degrees of Rock — MusicBrainz ingestion ===');
  log(`Seed:  ${args.seed}`);
  log(`Out:   ${args.out}`);
  if (args.limit) log(`Limit: first ${args.limit} persons`);
  log('');

  const seedText = await readFile(args.seed, 'utf8');
  const seedRows = parseCsv(seedText);
  const seed = buildSeedIndex(seedRows);
  log(`Seed loaded: ${seed.bands.size} bands, ${seed.persons.size} persons`);

  const overrides = await loadOverrides();
  log(`Overrides:   ${Object.keys(overrides).length} manual MBID pins`);
  log('');

  // Sort persons deterministically so re-runs process them in the same
  // order (better for cache hits and easier to diff outputs).
  const personEntries = [...seed.persons.entries()].sort(([a], [b]) => a.localeCompare(b));
  const targetPersons = args.limit ? personEntries.slice(0, args.limit) : personEntries;

  const candidates = new Map(); // mbid -> aggregated candidate record
  const resolveLog = [];

  for (const [key, displayName] of targetPersons) {
    log(`\n[person] ${displayName}`);
    let resolved;
    try {
      resolved = await resolveMbid(displayName, overrides, { type: 'Person', log });
    } catch (err) {
      log(`  ! resolve failed: ${err.message}`);
      resolveLog.push({ name: displayName, status: 'error', error: err.message });
      continue;
    }
    if (!resolved || !resolved.mbid) {
      resolveLog.push({ name: displayName, status: 'unresolved', ...resolved });
      continue;
    }
    resolveLog.push({ name: displayName, status: 'resolved', ...resolved });

    let personData;
    try {
      personData = await getArtistMembers(resolved.mbid, { log });
    } catch (err) {
      log(`  ! fetch relations failed: ${err.message}`);
      continue;
    }

    // Dedupe relations by MBID (MB sometimes lists a band twice for the
    // same person — see Dave Grohl's Nirvana entry).
    const seenBandMbid = new Set();
    for (const rel of personData.relations) {
      if (seenBandMbid.has(rel.relatedMbid)) continue;
      seenBandMbid.add(rel.relatedMbid);

      const bandKey = normalizeNameKey(rel.relatedName);
      // Skip if this band is already in the graph — that's not a new
      // candidate, it's an already-known connection.
      if (seed.bands.has(bandKey)) {
        log(`    (skip) ${rel.relatedName} — already in graph`);
        continue;
      }

      // Aggregate: multiple seed persons may point to the same candidate
      // band, and each such pointer is a bridge signal.
      let candidate = candidates.get(rel.relatedMbid);
      if (!candidate) {
        candidate = {
          mbid: rel.relatedMbid,
          name: rel.relatedName,
          type: rel.relatedType,
          bridgesFrom: [],
          detail: null,
          wikipedia: null,
        };
        candidates.set(rel.relatedMbid, candidate);
      }
      candidate.bridgesFrom.push({
        personName: displayName,
        personMbid: resolved.mbid,
        tenure: formatTenure(rel),
      });
    }
  }

  log(`\n=== Candidate bands found: ${candidates.size} ===`);

  // For each candidate, fetch its full detail + Wikipedia check.
  const scored = [];
  // Candidates that are billings rather than bands. Held out of scoring and
  // out of the merge, and written to the run summary so the call is a human's.
  const collectives = [];
  let idx = 0;
  for (const candidate of candidates.values()) {
    idx++;
    log(`\n[candidate ${idx}/${candidates.size}] ${candidate.name}`);
    try {
      const detail = await getArtistMembers(candidate.mbid, { log });
      candidate.detail = detail;
    } catch (err) {
      log(`  ! detail fetch failed: ${err.message}`);
      continue;
    }
    try {
      candidate.wikipedia = await hasWikipediaArticle(candidate.name, { log });
    } catch (err) {
      log(`  ! wiki check failed: ${err.message}`);
      candidate.wikipedia = { exists: false, error: err.message };
    }

    // Groups are not people, and this graph's only relationship is
    // band -> person. MB uses one 'member of band' relation for both, so a
    // tour billing like Claypool Gold arrives as a "band" whose members are
    // three other bands. Left unfiltered, those became phantom musicians named
    // Primus, The Claypool Lennon Delirium and The Les Claypool Frog Brigade,
    // each colliding with the real band of the same name.
    const { people: personRelations, groups: groupRelations } =
      partitionMemberRelations(candidate.detail.relations);
    const isCollective = looksLikeCollective(candidate.detail.relations);
    if (groupRelations.length) {
      log(`  (groups) ${groupRelations.length} group member(s) skipped: ${groupRelations.map(r => r.relatedName).join(', ')}`);
    }
    if (isCollective) {
      // Not scored, not merged, but reported: a human decides whether the
      // billing is worth representing, and how.
      log('  ! looks like a tour/collective (members are mostly groups) — held for review');
      collectives.push({
        mbid: candidate.mbid,
        name: candidate.name,
        groupMembers: groupRelations.map(r => r.relatedName),
        personMembers: personRelations.map(r => r.relatedName),
        bridgesFrom: candidate.bridgesFrom.map(b => b.personName),
      });
      continue;
    }

    const memberCount = personRelations.length;
    // The bridge count = how many members of this candidate band are
    // already in the seed graph (matched by name). This is the "≥1
    // existing musician" signal, and it can be >1 if multiple members
    // are already known — which is the strongest bridge-fill signal.
    const memberNamesInGraph = personRelations
      .map(r => normalizeNameKey(r.relatedName))
      .filter(k => seed.persons.has(k));
    const existingConnections = new Set(memberNamesInGraph).size;

    const score = scoreCandidate({
      existingConnections,
      memberCount,
      hasWikipediaArticle: !!(candidate.wikipedia?.exists && !candidate.wikipedia?.isDisambiguation),
      hasBeginArea: !!candidate.detail.self.beginArea,
      hasBeginYear: !!candidate.detail.self.begin,
    });

    scored.push({
      mbid: candidate.mbid,
      name: candidate.name,
      score: score.score,
      tier: score.tier,
      signals: score.signals,
      existingConnections,
      memberCount,
      city: candidate.detail.self.beginArea,
      country: candidate.detail.self.country,
      begin: candidate.detail.self.begin,
      end: candidate.detail.self.end,
      wikipediaExists: !!candidate.wikipedia?.exists,
      wikipediaDisambiguation: !!candidate.wikipedia?.isDisambiguation,
      bridgesFrom: candidate.bridgesFrom.map(b => b.personName),
      tenures: candidate.bridgesFrom,
      members: personRelations.map(r => ({
        name: r.relatedName,
        mbid: r.relatedMbid,
        tenure: formatTenure(r),
        inGraph: seed.persons.has(normalizeNameKey(r.relatedName)),
      })),
    });
    log(`  score=${score.score} tier=${score.tier} bridges=${existingConnections} members=${memberCount} wiki=${!!candidate.wikipedia?.exists}`);
  }

  // ---------------------------------------------------------------------
  // Emit outputs
  // ---------------------------------------------------------------------
  await mkdir(args.out, { recursive: true });

  const tiers = { high: [], medium: [], low: [] };
  for (const s of scored) tiers[s.tier].push(s);

  const headers = [
    'tier', 'score', 'name', 'mbid', 'city', 'country',
    'begin', 'end', 'existingConnections', 'memberCount',
    'wikipediaExists', 'wikipediaDisambiguation', 'bridgesFrom',
  ];

  for (const tier of ['high', 'medium', 'low']) {
    const rows = tiers[tier].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const path = join(args.out, `candidates-${tier}.csv`);
    const lines = [headers.join(',')];
    for (const s of rows) {
      lines.push(csvRow(headers, {
        ...s,
        bridgesFrom: s.bridgesFrom.join('; '),
      }));
    }
    await writeFile(path, lines.join('\n') + '\n', 'utf8');
    log(`  wrote ${tier.padEnd(6)} → ${path}  (${rows.length} rows)`);
  }

  // Detailed JSON dump for auditability + future replays.
  await writeFile(
    join(args.out, 'run-summary.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      seed: args.seed,
      seedStats: { bands: seed.bands.size, persons: seed.persons.size },
      limit: args.limit || null,
      overrides: Object.keys(overrides),
      resolved: resolveLog,
      candidates: scored,
      collectives,
      counts: {
        collectivesHeld: collectives.length,
        candidates: scored.length,
        high: tiers.high.length,
        medium: tiers.medium.length,
        low: tiers.low.length,
      },
    }, null, 2),
    'utf8',
  );
  log(`  wrote summary → ${join(args.out, 'run-summary.json')}`);

  log('\n=== Done ===');
  log(`  candidates:  ${scored.length}`);
  log(`  high tier:   ${tiers.high.length}  (auto-merge policy)`);
  log(`  medium tier: ${tiers.medium.length}  (stage for review)`);
  log(`  low tier:    ${tiers.low.length}  (rejected, logged)`);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
