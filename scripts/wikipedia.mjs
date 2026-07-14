// -----------------------------------------------------------------------
// Wikipedia second-source check for the ingestion pipeline.
//
// We're not trying to parse Wikipedia articles (that way lies infobox
// hell). We only need a boolean: "does an article named <band-name>
// exist?" — a lightweight notability signal that we combine with the
// MusicBrainz data to compute the confidence score.
//
// Uses the MediaWiki Action API which is public, generous with rate
// limits, and cheap. We still cache to disk so re-runs are near-instant.
// -----------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.cache', 'wikipedia');

const HEADERS = {
  'User-Agent': 'RockBandFamilyTree/0.1 (https://github.com/rcolepeterson/band_members)',
  'Accept': 'application/json',
};

async function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

function cacheKeyFor(url) {
  return createHash('sha1').update(url).digest('hex') + '.json';
}

async function readCache(url) {
  const path = join(CACHE_DIR, cacheKeyFor(url));
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(url, body) {
  await ensureCacheDir();
  const path = join(CACHE_DIR, cacheKeyFor(url));
  await writeFile(path, JSON.stringify(body, null, 2), 'utf8');
}

// Check whether a Wikipedia article exists for the given band name.
// Returns { exists, title, isDisambiguation }. We flag disambiguation
// pages so callers don't mistake "The Who (disambiguation)" for a solid
// second-source hit.
export async function hasWikipediaArticle(name, { log = null } = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&titles=${encodeURIComponent(name)}&prop=info&redirects=1`;
  const cached = await readCache(url);
  let body;
  if (cached) {
    if (log) log(`[cache] wiki:${name}`);
    body = cached;
  } else {
    if (log) log(`[fetch] wiki:${name}`);
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      throw new Error(`Wikipedia ${res.status} for ${name}`);
    }
    body = await res.json();
    await writeCache(url, body);
  }
  const pages = body?.query?.pages || {};
  const page = Object.values(pages)[0] || {};
  // Missing pages have pageid=0 and a `missing` marker in the response.
  const exists = !page.missing && page.pageid > 0;
  return {
    exists,
    title: page.title || name,
    // We don't parse category data here, but the title suffix is a
    // reliable enough disambiguation flag for our confidence score.
    isDisambiguation: /\(disambiguation\)$/i.test(page.title || ''),
  };
}
