// GET /api/genre-graph/band/:id — full genre record for ONE band,
// including the complete provenance blob and fringe genres.
//
// This feeds the locked hybrid provenance design (Aaron, 2026-11-23):
// the band card shows a compact provenance line per field, and one tap
// expands IN PLACE to that band's actual sources, competing values, and
// conflict status. Keeping the heavy fields out of the main
// /api/genre-graph payload holds it to ~300 KB gzipped; this endpoint is
// a few KB per card open.
//
// Keyed by band UUID, never by name (same-name bands stay distinct).
// A band with no genre row returns 404 with ok:false — the card then
// shows its "no genre data yet" state; the band still exists in Bands
// Connections and the portal.
//
// No auth: public graph data, same trust level as /api/bands.
// Not Blobs-cached: per-band reads are tiny and infrequent (one per card
// expansion), and the CDN cache below absorbs repeats.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  notFound,
  badRequest,
} from './_db.mjs';
import { isUuid, debutYearOf } from './_genre_graph.mjs';

export default async (req, context) => {
  if (req.method !== 'GET') return methodNotAllowed();

  const id = context?.params?.id || '';
  if (!isUuid(id)) return badRequest('band id must be a UUID');

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const rows = await sql`
      select b.id, b.name, b.city, b.state, b.country,
             b.genre as existing_genre, b.years_active as existing_years_active,
             g.primary_genre, g.genre_tier, g.genre_sources, g.genre_agreement,
             g.fringe_genres,
             g.first_album_year, g.first_album_title, g.first_album_source,
             g.first_album_tier, g.formation_year, g.end_year,
             g.has_conflict, g.provenance, g.updated_at
      from bands b
      left join band_genre_data g on g.band_id = b.id
      where b.id = ${id}
      limit 1
    `;
    const r = rows[0];
    if (!r) return notFound('band not found');
    if (r.primary_genre === null && r.provenance === null) {
      // Band exists but has no genre row yet (new band, or apply not run).
      return new Response(JSON.stringify({
        ok: false,
        error: 'no genre data for this band yet',
        band: { id: r.id, name: r.name, city: r.city, state: r.state, country: r.country },
      }), {
        status: 404,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=60, stale-while-revalidate=3600',
        },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      band: {
        id: r.id,
        name: r.name,
        city: r.city,
        state: r.state,
        country: r.country,
        existing_genre: r.existing_genre,
        existing_years_active: r.existing_years_active,
        primary_genre: r.primary_genre,
        genre_tier: r.genre_tier,
        genre_sources: r.genre_sources || [],
        genre_agreement: r.genre_agreement,
        fringe_genres: r.fringe_genres || [],
        first_album_year: r.first_album_year,
        first_album_title: r.first_album_title,
        first_album_source: r.first_album_source,
        first_album_tier: r.first_album_tier,
        formation_year: r.formation_year,
        end_year: r.end_year,
        debut_year: debutYearOf(r),
        has_conflict: r.has_conflict === true,
        provenance: r.provenance || {},
        updated_at: r.updated_at,
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60, stale-while-revalidate=3600',
        'netlify-cdn-cache-control': 'public, max-age=3600, stale-while-revalidate=3600, durable',
      },
    });
  } catch (err) {
    console.error('genre_graph_band GET failed', err);
    return serverError('could not load band genre data', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/genre-graph/band/:id', method: 'GET' };
