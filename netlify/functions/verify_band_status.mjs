// GET /api/verify-band-status — bulk, read-only lookup of cached
// verification rows for one or many bands. NEVER calls MusicBrainz or
// Wikipedia; it only reads whatever verify_band.mjs has already written to
// the `verifications` table. That split matters: the graph page needs to
// know, for ~500 bands at once, which ones already carry a silver-star
// badge, and doing that with 500 sequential POST /api/verify-band calls
// would be both slow and would hammer the external APIs pointlessly (this
// endpoint touches none of them, so there's no rate limit story here at
// all).
//
// Auth: none. A cached score/breakdown is not sensitive — same trust level
// as /api/bands (public graph data). Signed-out visitors can see badges;
// only *triggering* a fresh check (POST /api/verify-band) requires a
// session, per PR 4a.
//
// Separate path from POST /api/verify-band (see that file's header) so the
// two endpoints' very different semantics (mutating, rate-limited,
// authenticated vs. read-only, unauthenticated, cheap) never have to share
// a single handler's branching logic.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';

// Same cap rationale as most "bulk by id list" endpoints: keeps the query's
// IN-list bounded and gives the client a clear, cheap-to-implement signal
// to paginate/batch on their end instead of us silently truncating.
const MAX_BAND_IDS = 100;

// Same loose UUID shape check used in verify_band.mjs — good enough to
// reject obviously-bad input with a clean 400 before it reaches Postgres.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();

  if (!isDbConfigured()) return dbUnavailable();

  const url = new URL(req.url);
  const raw = url.searchParams.get('band_ids') || '';
  const bandIds = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!bandIds.length) {
    return badRequest('band_ids query param is required (comma-separated uuid list)', { field: 'band_ids' });
  }
  if (bandIds.length > MAX_BAND_IDS) {
    return badRequest(`too many band_ids: max ${MAX_BAND_IDS} per request`, {
      field: 'band_ids',
      max: MAX_BAND_IDS,
      received: bandIds.length,
    });
  }

  // Reject non-UUID-shaped entries up front rather than letting Postgres
  // 500 on a malformed ::uuid[] cast — same defensive posture as
  // verify_band.mjs's band_id check.
  const invalid = bandIds.filter(id => !UUID_RE.test(id));
  if (invalid.length) {
    return badRequest('band_ids contains one or more values that are not valid UUIDs', {
      field: 'band_ids',
      invalid,
    });
  }

  const sql = getSql();

  try {
    // Single query for the whole batch, using = ANY($1) against a text[]
    // built from the caller's list, then cast per-row to uuid for the
    // comparison. This is the same batch-read shape as bands_neon.mjs's
    // selects — one round trip regardless of how many ids were requested.
    const rows = await sql`
      select band_id, verified_at, overall_score, breakdown,
             musicbrainz_mbid, musicbrainz_url, wikipedia_title, wikipedia_url
      from verifications
      where band_id = any(${bandIds}::uuid[])
    `;

    const byId = new Map(rows.map(row => [row.band_id, row]));

    // Response map includes every requested id (present or not) so the
    // caller never has to special-case "key missing" vs. "key present but
    // null" — both mean "no verification yet".
    const verifications = {};
    for (const id of bandIds) {
      const row = byId.get(id);
      verifications[id] = row
        ? {
            overall_score: row.overall_score,
            verified_at: row.verified_at,
            breakdown: row.breakdown,
            sources: {
              musicbrainz: row.musicbrainz_mbid
                ? { mbid: row.musicbrainz_mbid, url: row.musicbrainz_url }
                : null,
              wikipedia: row.wikipedia_title
                ? { title: row.wikipedia_title, url: row.wikipedia_url }
                : null,
            },
          }
        : null;
    }

    return ok({ verifications });
  } catch (err) {
    console.error('verify_band_status GET failed', err);
    return serverError('could not load verification statuses', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Mounted at a distinct path from /api/verify-band (see this file's header
// for why) so Netlify Functions v2's (path, method) dispatch never has to
// disambiguate GET-vs-POST on the same route.
export const config = { path: '/api/verify-band-status', method: 'GET' };
