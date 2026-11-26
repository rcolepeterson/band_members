// GET /api/genre-graph/portal/:bandId?degrees=2|3 — one band's member
// neighborhood for the Genre Graph portal (the window into Bands
// Connections).
//
// Replaces the 2 MB embedded neighborhood snapshot with a few KB per
// portal open, computed live from memberships. The response mirrors the
// embedded PORTAL shape ([[memberName, [otherBandNames]], ...]) so the
// page renders live and snapshot data through the same code, plus an
// `ids` name->UUID map so re-centring clicks can fetch by UUID.
//
// Coverage rule (Aaron lock, the BBRU case): the portal covers EVERY
// band in the database, not only genre-placed ones — navigating through
// the portal can leave the genre you started in. This endpoint therefore
// never requires a band_genre_data row.
//
// No auth: public graph data, same trust level as /api/bands.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  notFound,
  badRequest,
} from './_db.mjs';
import { isUuid, shapePortalNeighborhood } from './_genre_graph.mjs';

export default async (req, context) => {
  if (req.method !== 'GET') return methodNotAllowed();

  const id = context?.params?.bandId || '';
  if (!isUuid(id)) return badRequest('band id must be a UUID');

  const url = new URL(req.url);
  const degreesRaw = url.searchParams.get('degrees');
  const degrees = degreesRaw === '3' ? 3 : 2;

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const centreRows = await sql`
      select id, name, city, country from bands where id = ${id} limit 1
    `;
    const centre = centreRows[0];
    if (!centre) return notFound('band not found');

    // 2°: every membership held by the centre band's members (their other
    // bands included), names joined in.
    const rows2 = await sql`
      select m.band_id, m.member_id, bm.name as member_name, b.name as band_name
      from memberships m
      join band_members bm on bm.id = m.member_id
      join bands b on b.id = m.band_id
      where m.member_id in (select member_id from memberships where band_id = ${id})
    `;

    let rows3 = [];
    if (degrees >= 3) {
      // 3°: memberships of the 2° bands' members — gives the third ring
      // (outer bands' own members) plus those members' other bands.
      rows3 = await sql`
        select m.band_id, m.member_id, bm.name as member_name, b.name as band_name
        from memberships m
        join band_members bm on bm.id = m.member_id
        join bands b on b.id = m.band_id
        where m.member_id in (
          select member_id from memberships
          where band_id in (
            select distinct band_id from memberships
            where member_id in (select member_id from memberships where band_id = ${id})
          )
        )
      `;
    }

    const memberships = [];
    const memberById = new Map();
    const bandById = new Map();
    bandById.set(centre.id, { id: centre.id, name: centre.name });
    for (const r of [...rows2, ...rows3]) {
      memberships.push({ band_id: r.band_id, member_id: r.member_id });
      if (!memberById.has(r.member_id)) memberById.set(r.member_id, { id: r.member_id, name: r.member_name });
      if (!bandById.has(r.band_id)) bandById.set(r.band_id, { id: r.band_id, name: r.band_name });
    }

    const shaped = shapePortalNeighborhood({
      centre: { id: centre.id, name: centre.name },
      memberships,
      members: [...memberById.values()],
      bands: [...bandById.values()],
      degrees,
    });

    return new Response(JSON.stringify({
      ok: true,
      band: { id: centre.id, name: centre.name, city: centre.city, country: centre.country },
      degrees,
      entry: shaped.entry,
      outer: shaped.outer,
      ids: shaped.ids,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60, stale-while-revalidate=3600',
        'netlify-cdn-cache-control': 'public, max-age=3600, stale-while-revalidate=3600, durable',
      },
    });
  } catch (err) {
    console.error('genre_graph_portal GET failed', err);
    return serverError('could not load portal neighborhood', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/genre-graph/portal/:bandId', method: 'GET' };
