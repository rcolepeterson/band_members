// POST /api/verify-band — on-demand cross-check of a band's data against
// MusicBrainz (primary, structured) and Wikipedia (secondary, fuzzy
// corroboration). PR 4a: backend only. The UI that displays this payload
// (score + per-field breakdown) is PR 4b — this endpoint just returns JSON.
//
// Naming note: earlier drafts of this feature called it a "lock". It is
// NOT a lock — it never blocks or gates an edit. It's a read-only
// verification RESULT stored alongside the band. See _verify_helpers.mjs's
// header comment for the same clarification.
//
// Auth: any signed-in user (valid bearer token) may trigger a verification
// for any band — same no-ownership-model precedent as bands_edit.mjs.
//
// Cache: one row per band in `verifications` (unique index on band_id).
// A cached result is reused when it is BOTH fresh (< 24h old) AND newer
// than the band's last edit (verified_at > bands.updated_at). The second
// condition is the entire invalidation story — see the comments in
// bands_edit.mjs / bands_edit_members.mjs pointing back here. We
// deliberately do not add any explicit "mark stale" write on edit; passive
// comparison against updated_at (which the existing bands_set_updated_at
// trigger bumps automatically) is simpler and can't drift out of sync.
//
// Rate limiting: MusicBrainz asks for 1 req/sec. When both external
// services need to be called (i.e. no fresh cache), we call Wikipedia
// first (no strict limit), sleep 1000ms, then call MusicBrainz. Caching
// means this sequence only runs once per band per 24h (or on edit).

import {
  getSql,
  isDbConfigured,
  json,
  ok,
  badRequest,
  unauthorized,
  notFound,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { consume, tooManyRequests, LIMITS as RATE_LIMITS } from './_rate_limit.mjs';
import { fetchMusicBrainz, fetchWikipedia, scoreVerification } from './_verify_helpers.mjs';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours, per spec
const MUSICBRAINZ_SLEEP_MS = 1000; // MB's documented 1 req/sec courtesy limit

// Loose UUID v1-v5 shape check. We don't need to be pedantic about the
// version nibble — just reject obviously-not-a-uuid input with a clear
// 400 before it reaches a query (Postgres would otherwise 500 on a
// malformed ::uuid cast, which is a worse error for the caller).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildSources(mbArtist, wikiPage) {
  const musicbrainz = mbArtist
    ? { mbid: mbArtist.id, url: `https://musicbrainz.org/artist/${mbArtist.id}` }
    : null;
  const wikipedia = wikiPage && wikiPage.content_urls && wikiPage.content_urls.desktop
    ? { title: wikiPage.title, url: wikiPage.content_urls.desktop.page }
    : (wikiPage ? { title: wikiPage.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent((wikiPage.title || '').replace(/\s+/g, '_'))}` } : null);
  return { musicbrainz, wikipedia };
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth before DB/body checks — unauthenticated callers learn nothing
  // about DB config or band existence (same discipline as bands_edit.mjs).
  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('request body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('request body must be a JSON object');
  }

  const bandId = typeof body.band_id === 'string' ? body.band_id.trim() : '';
  if (!bandId) return badRequest('band_id is required', { field: 'band_id' });
  if (!UUID_RE.test(bandId)) {
    return badRequest('band_id must be a valid UUID', { field: 'band_id' });
  }

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    // Keyed on the user id, not the token: rotating a credential must not hand its
    // holder a fresh budget, and the counter table should never hold a live secret.
    // Placed after the token check so an invalid caller cannot spend a real user's
    // allowance by guessing at their id.
    const rl = await consume({ sql, bucket: `verify-band:user:${user.id}`, ...RATE_LIMITS.verifyBand });
    if (!rl.allowed) {
      return tooManyRequests(
        'Verification is limited to protect MusicBrainz, which asks for one request a second. Try again shortly.',
        rl.retryAfterSeconds
      );
    }

    const bandRows = await sql`select * from bands where id = ${bandId} limit 1`;
    if (!bandRows.length) return notFound('no band with that id');
    const band = bandRows[0];

    const existingVerification = await sql`
      select * from verifications where band_id = ${bandId} limit 1
    `;
    const cached = existingVerification[0] || null;

    if (cached) {
      const verifiedAtMs = new Date(cached.verified_at).getTime();
      const updatedAtMs = new Date(band.updated_at).getTime();
      const isFresh = Date.now() - verifiedAtMs < CACHE_TTL_MS;
      const isStale = updatedAtMs > verifiedAtMs;
      if (isFresh && !isStale) {
        return ok({
          cached: true,
          band_id: band.id,
          band_name: band.name,
          overall_score: cached.overall_score,
          verified_at: cached.verified_at,
          breakdown: cached.breakdown,
          sources: {
            musicbrainz: cached.musicbrainz_mbid
              ? { mbid: cached.musicbrainz_mbid, url: cached.musicbrainz_url }
              : null,
            wikipedia: cached.wikipedia_title
              ? { title: cached.wikipedia_title, url: cached.wikipedia_url }
              : null,
          },
        });
      }
    }

    // No usable cache — hit the external services. Wikipedia first (no
    // strict rate limit), then sleep, then MusicBrainz (1 req/sec courtesy
    // limit per MB's guidelines).
    const wikiResult = await fetchWikipedia(band.name);
    await sleep(MUSICBRAINZ_SLEEP_MS);
    const mbResult = await fetchMusicBrainz(band.name, { country: band.country });

    const mbOk = mbResult.ok;
    const wikiOk = wikiResult.ok;

    if (!mbOk && !wikiOk) {
      // Both external services failed entirely — don't upsert a bogus
      // row; let the user retry with a clean slate. serverError() always
      // emits 500, so build the 502 directly with the shared json() helper
      // to match this specific contract from the design doc.
      return json(502, {
        ok: false,
        error: 'both MusicBrainz and Wikipedia lookups failed',
        musicbrainz_error: mbResult.error,
        wikipedia_error: wikiResult.error,
      });
    }

    const mbArtist = mbOk ? mbResult.artist : null;
    const wikiPage = wikiOk ? wikiResult.page : null;

    const { overall_score, breakdown } = scoreVerification(band, mbArtist, wikiPage);
    const sources = buildSources(mbArtist, wikiPage);

    const warnings = [];
    if (!mbOk) warnings.push(`MusicBrainz lookup failed: ${mbResult.error}`);
    else if (!mbArtist) warnings.push('No MusicBrainz match found');
    if (!wikiOk) warnings.push(`Wikipedia lookup failed: ${wikiResult.error}`);
    else if (!wikiPage) warnings.push('No Wikipedia match found');

    const upserted = await sql`
      insert into verifications (band_id, verified_at, overall_score, breakdown, musicbrainz_mbid, musicbrainz_url, wikipedia_title, wikipedia_url)
      values (
        ${bandId}, now(), ${overall_score}, ${JSON.stringify(breakdown)}::jsonb,
        ${sources.musicbrainz ? sources.musicbrainz.mbid : null},
        ${sources.musicbrainz ? sources.musicbrainz.url : null},
        ${sources.wikipedia ? sources.wikipedia.title : null},
        ${sources.wikipedia ? sources.wikipedia.url : null}
      )
      on conflict (band_id) do update set
        verified_at = excluded.verified_at,
        overall_score = excluded.overall_score,
        breakdown = excluded.breakdown,
        musicbrainz_mbid = excluded.musicbrainz_mbid,
        musicbrainz_url = excluded.musicbrainz_url,
        wikipedia_title = excluded.wikipedia_title,
        wikipedia_url = excluded.wikipedia_url
      returning verified_at
    `;

    const responseBody = {
      cached: false,
      band_id: band.id,
      band_name: band.name,
      overall_score,
      verified_at: upserted[0].verified_at,
      breakdown,
      sources,
    };
    if (warnings.length) responseBody.warnings = warnings;

    return ok(responseBody);
  } catch (err) {
    console.error('verify_band failed', err);
    return serverError('could not verify band', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/verify-band', method: 'POST' };
