// GET /api/genre-graph — public read endpoint serving the verified genre
// layer (band_genre_data joined to bands) for the Genre Graph page.
//
// This is the live-pull read path (spec 2026-11-26): the page fetches
// these slim per-band rows, computes the yearly series in-browser, and
// falls back to its embedded snapshot if this endpoint fails or returns
// no rows (e.g. before Aaron has run the first apply). One edit to
// band_genre_data updates the Genre Graph on its next load — no rebuild,
// no ship zip.
//
// debut_year is computed server-side at read time
// (first_album_year ?? formation_year, the first-album rule) so the page
// never re-derives the rule differently. Full provenance and fringe
// genres are NOT in this payload — they are card detail, fetched per
// band from /api/genre-graph/band/:id.
//
// No auth: public graph data, same trust level as /api/bands.
//
// Neon transfer: served through serveCachedGraph (Blobs version cache)
// exactly like /api/bands — the version check covers bands +
// band_genre_data, so unchanged data costs Neon ~zero bytes.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { serveCachedGraph } from './_graph_cache.mjs';
import { GENRE_TABLES, GENRE_CACHE_PREFIX, slimGenreRow } from './_genre_graph.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  const buildPayload = async () => {
    const [rows, totals] = await Promise.all([
      sql`
        select b.id, b.name, b.city, b.country,
               g.primary_genre, g.genre_tier, g.genre_sources,
               g.first_album_year, g.first_album_title, g.first_album_source,
               g.formation_year, g.end_year, g.has_conflict
        from band_genre_data g
        join bands b on b.id = g.band_id
        order by b.name
      `,
      // Total bands in the database (with or without a genre row) so the
      // page header can compute placed/total from the payload instead of
      // hand-maintained copy that drifts from the data.
      sql`select count(*) as n from bands`,
    ]);
    return {
      ok: true,
      bands: rows.map(slimGenreRow),
      total_bands: Number(totals[0]?.n ?? rows.length),
    };
  };

  const toResponse = (payload) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': GENRE_CACHE_CONTROL,
      'netlify-cdn-cache-control': GENRE_CDN_CACHE_CONTROL,
    },
  });

  try {
    return await serveCachedGraph({
      sql,
      tables: GENRE_TABLES,
      prefix: GENRE_CACHE_PREFIX,
      buildPayload,
      toResponse,
    });
  } catch (err) {
    console.error('genre_graph GET failed', err);
    return serverError('could not load genre graph data', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Same cache posture as /api/bands (bands_neon.mjs): browsers 60s fresh
// then stale-while-revalidate; CDN 1 hour to protect Neon transfer.
export const GENRE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=3600';
export const GENRE_CDN_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=3600, durable';

export const config = { path: '/api/genre-graph', method: 'GET' };
