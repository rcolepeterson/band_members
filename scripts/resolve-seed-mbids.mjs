// -----------------------------------------------------------------------
// Resolve a MusicBrainz ID for every band in the seed graph.
//
// WHY THIS EXISTS SEPARATELY
//
// ingest-batch.mjs --enrich can only enrich a band it can already identify: its
// loop is built from the override list plus whatever the resolved-MBID cache
// happens to hold. On the first full enrichment run that was 100 of 499 bands,
// so 402 bands -- including Black Sabbath, Iron Maiden and King Crimson, the
// very bands with no founder recorded -- were skipped silently. Discovery
// resolves MBIDs as a side effect of scanning for NEW bands, which is the one
// thing an enrichment pass does not do.
//
// So this fills the cache directly, and nothing else. It writes no CSV, proposes
// no changes, and touches no graph data: it turns "we cannot identify this band"
// into "we can", and enrichment does the rest.
//
// SAVES AS IT GOES
//
// MusicBrainz allows one request per second, so 400 bands is roughly seven
// minutes of wall clock before retries, and it answered 503 repeatedly the night
// this was written. A run that only wrote its cache at the end would throw away
// every resolution it had made if it were interrupted -- which is exactly what
// happened once already. The cache is therefore flushed every SAVE_EVERY
// resolutions, and re-running is cheap and idempotent: anything already cached
// is skipped without a request.
//
//   node scripts/resolve-seed-mbids.mjs [--seed <path>] [--limit N] [--dry-run]
// -----------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchArtist } from './musicbrainz.mjs';
import { normalizeNameKey } from './pipeline-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVED_CACHE_PATH = join(__dirname, 'data', 'resolved-mbids.json');
const OVERRIDES_PATH = join(__dirname, 'data', 'mbid-overrides.json');
const DEFAULT_SEED = join(__dirname, 'data', 'live-graph-seed.csv');

// Same threshold ingest-batch.mjs caches at. Below a strong match a hit can be a
// genuinely different artist -- "Filter" the band versus filtration, "Ministry"
// the band versus a disambiguation page -- and a wrong MBID is worse than none:
// it would enrich a band with another band's founders.
const CACHE_MIN_SCORE = 95;
const SAVE_EVERY = 10;

function parseArgs(argv) {
  const args = { seed: DEFAULT_SEED, limit: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seed') args.seed = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: resolve-seed-mbids.mjs [--seed <path>] [--limit N] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

// The seed's own minimal CSV shape: only the band column is needed here.
function bandNamesFrom(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const sourceIdx = headers.indexOf('source');
  const typeIdx = headers.indexOf('source_type');
  const names = new Map(); // normalized key -> display name
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if ((cells[typeIdx] || '').trim() !== 'band') continue;
    const name = (cells[sourceIdx] || '').trim();
    if (!name) continue;
    const key = normalizeNameKey(name);
    if (key && !names.has(key)) names.set(key, name);
  }
  return names;
}

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const log = (...m) => console.log(...m);

  log('=== Resolve seed band MBIDs ===');
  log(`Seed:  ${args.seed}`);
  if (args.limit) log(`Limit: ${args.limit}`);
  if (args.dryRun) log('Dry run: nothing will be written');
  log('');

  const cache = await loadJson(RESOLVED_CACHE_PATH, { bands: {}, persons: {}, generatedAt: null });
  if (!cache.bands) cache.bands = {};
  const overridesRaw = await loadJson(OVERRIDES_PATH, {});
  const overrideKeys = new Set(Object.keys(overridesRaw).map(normalizeNameKey));

  const names = bandNamesFrom(await readFile(args.seed, 'utf8'));
  const pending = [...names.entries()].filter(
    ([key]) => !cache.bands[key]?.mbid && !overrideKeys.has(key),
  );

  log(`seed bands:        ${names.size}`);
  log(`already resolved:  ${names.size - pending.length}`);
  log(`to resolve now:    ${pending.length}`);
  log('');

  const work = args.limit ? pending.slice(0, args.limit) : pending;
  const stats = { resolved: 0, ambiguous: 0, missing: 0, failed: 0 };
  const unresolved = [];
  let sinceSave = 0;

  for (const [key, name] of work) {
    let hits;
    try {
      hits = await searchArtist(name, { type: 'Group', limit: 3, log: () => {} });
    } catch (err) {
      stats.failed += 1;
      unresolved.push({ name, reason: `search failed: ${err.message}` });
      log(`  ! ${name}: search failed — ${err.message}`);
      continue;
    }
    if (!hits.length) {
      stats.missing += 1;
      unresolved.push({ name, reason: 'no MusicBrainz match' });
      continue;
    }
    const top = hits[0];
    // Below the threshold the top hit is recorded as a candidate rather than
    // trusted, so a human can promote it through mbid-overrides.json. Guessing
    // here is how a band ends up with somebody else's founders.
    if (typeof top.score === 'number' && top.score < CACHE_MIN_SCORE) {
      stats.ambiguous += 1;
      unresolved.push({
        name,
        reason: `ambiguous (top score ${top.score})`,
        candidates: hits.slice(0, 3).map(h => `${h.name} [${h.mbid}] score ${h.score}`),
      });
      continue;
    }
    cache.bands[key] = {
      mbid: top.mbid,
      name,
      score: top.score,
      resolvedAt: new Date().toISOString(),
      via: 'seed-resolve',
    };
    stats.resolved += 1;
    sinceSave += 1;
    if (!args.dryRun && sinceSave >= SAVE_EVERY) {
      await writeFile(
        RESOLVED_CACHE_PATH,
        JSON.stringify({ ...cache, generatedAt: new Date().toISOString() }, null, 2) + '\n',
        'utf8',
      );
      sinceSave = 0;
      log(`  … ${stats.resolved} resolved (cache flushed)`);
    }
  }

  if (!args.dryRun) {
    await writeFile(
      RESOLVED_CACHE_PATH,
      JSON.stringify({ ...cache, generatedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  }

  log('\n=== Done ===');
  log(`  resolved:   ${stats.resolved}`);
  log(`  ambiguous:  ${stats.ambiguous}  (needs an override, not a guess)`);
  log(`  no match:   ${stats.missing}`);
  log(`  failed:     ${stats.failed}`);
  log(`  cache now holds ${Object.keys(cache.bands).length} bands`);
  if (unresolved.length) {
    log('\nUnresolved, for review:');
    for (const u of unresolved.slice(0, 40)) {
      log(`  ${u.name} — ${u.reason}`);
      for (const c of u.candidates || []) log(`      candidate: ${c}`);
    }
    if (unresolved.length > 40) log(`  … and ${unresolved.length - 40} more`);
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
