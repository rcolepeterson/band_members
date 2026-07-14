// -----------------------------------------------------------------------
// MusicBrainz API client for the band-tree ingestion pipeline.
//
// MusicBrainz has a hard 1-req/sec rate limit. This module owns that
// discipline in one place: every fetch queues through `mbFetch()`, which
// enforces the delay and stores every response to a local JSON cache so
// re-runs don't hammer the API.
//
// Public API:
//   searchArtist(name, opts)     -> array of candidate artists (score-sorted)
//   getArtist(mbid)              -> raw artist detail
//   getArtistWithMembers(mbid)   -> artist + member-of-band relations
//   MUSICBRAINZ_HEADERS          -> the required User-Agent header
//
// Caching:
//   .cache/musicbrainz/<sha1-of-url>.json — plain JSON responses. Delete
//   the directory to force fresh fetches. Cache never expires; MB data
//   for historical bands is stable enough that TTL isn't worth the code.
// -----------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.cache', 'musicbrainz');

// MusicBrainz asks that every client identify itself. Their 1-req/sec rate
// limit is per User-Agent, so an honest UA also keeps us from getting
// throttled behind other tools.
export const MUSICBRAINZ_HEADERS = {
  'User-Agent': 'RockBandFamilyTree/0.1 (https://github.com/rcolepeterson/band_members)',
  'Accept': 'application/json',
};

// 1 second between requests. MB's docs say "average 1 req/sec"; we play
// safe with a fixed 1050ms floor.
const RATE_LIMIT_MS = 1050;
let lastRequestAt = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// The one and only function that touches the network. Every other export
// funnels through here so rate-limiting and caching cannot be bypassed
// by accident.
export async function mbFetch(url, { forceRefresh = false, log = null } = {}) {
  if (!forceRefresh) {
    const cached = await readCache(url);
    if (cached) {
      if (log) log(`[cache] ${url}`);
      return cached;
    }
  }
  // Enforce global 1-req/sec pacing.
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestAt = Date.now();
  if (log) log(`[fetch] ${url}`);
  const res = await fetch(url, { headers: MUSICBRAINZ_HEADERS });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MusicBrainz ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  await writeCache(url, body);
  return body;
}

// -----------------------------------------------------------------------
// Search + lookup helpers
// -----------------------------------------------------------------------

// URL-encode a Lucene query fragment for the MB search endpoint. MB uses
// Lucene syntax under the hood, so quoted phrases need to be preserved.
function encodeLucene(fragment) {
  return encodeURIComponent(fragment);
}

// Return candidate artists for a given name. Filters to "Group" type by
// default (i.e. bands) but callers can pass type='Person' for musicians.
// Results are already sorted by MB's `score` (0-100) so the top hit is
// usually the right one — but disambiguation is on the caller.
export async function searchArtist(name, { type = 'Group', limit = 5, log = null } = {}) {
  const q = type
    ? `name:"${name}" AND type:${type}`
    : `name:"${name}"`;
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeLucene(q)}&fmt=json&limit=${limit}`;
  const body = await mbFetch(url, { log });
  return (body.artists || []).map(normalizeSearchHit);
}

function normalizeSearchHit(a) {
  return {
    mbid: a.id,
    name: a.name,
    type: a.type || '',
    score: a.score || 0,
    disambiguation: a.disambiguation || '',
    country: a.country || '',
    beginArea: a['begin-area']?.name || '',
    area: a.area?.name || '',
    begin: a['life-span']?.begin || '',
    end: a['life-span']?.end || '',
    ended: a['life-span']?.ended || false,
    tags: (a.tags || []).map(t => ({ name: t.name, count: t.count })),
  };
}

// Fetch an artist's full detail INCLUDING artist-artist relations. That's
// where "member of band" edges live. Returns the raw MB body so callers
// can pick out what they need; getArtistMembers below is the sugar for
// the common case.
export async function getArtistWithMembers(mbid, { log = null } = {}) {
  const url = `https://musicbrainz.org/ws/2/artist/${mbid}?inc=artist-rels+tags+aliases&fmt=json`;
  return mbFetch(url, { log });
}

// Extract just the member-of-band relations from an artist detail body.
// For a BAND, this returns its members. For a PERSON, this returns bands
// they're a member of. MB uses the same relation type in both directions
// with `direction: 'backward'` telling us which side we're on.
export function extractMemberRelations(artistBody) {
  const rels = artistBody.relations || [];
  return rels
    .filter(r => r.type === 'member of band')
    .map(r => ({
      relatedMbid: r.artist?.id || '',
      relatedName: r.artist?.name || '',
      relatedType: r.artist?.type || '',
      direction: r.direction || 'forward',
      begin: r.begin || '',
      end: r.end || '',
      ended: r.ended || false,
      attributes: r.attributes || [],
    }))
    .filter(r => r.relatedMbid && r.relatedName);
}

// Convenience: fetch an artist + return normalized members in one call.
// Distinguishes bands (members) from persons (bands they're in) by
// examining relation direction.
export async function getArtistMembers(mbid, { log = null } = {}) {
  const body = await getArtistWithMembers(mbid, { log });
  return {
    self: normalizeSearchHit(body),
    relations: extractMemberRelations(body),
  };
}
