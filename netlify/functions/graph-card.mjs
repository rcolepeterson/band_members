// GET /api/graph-card?type=band|member&id=<exact id> — governor card
// endpoint: ONE entity, fully, and nothing else.
//
// Why this exists: there is currently NO single-band/single-member GET
// card endpoint. GET /api/bands/:id is follow-only (follows.mjs); PATCH and
// DELETE exist but no read. The governor client therefore needs a way to
// fetch exactly the card for the node the visitor picked, without the full
// /api/bands corpus. This is that endpoint, built from the same Neon tables
// bands_neon.mjs reads (bands, band_members, memberships, band_links).
// bands.mjs is the legacy submissions endpoint and is NOT used here.
//
// Freshness choice (documented, deliberate): a single row is read DIRECTLY
// from Neon on every request — no Blobs copy, no version check. A single-row
// read is cheap and always fresh, and a cached card could serve a stale bio
// or a stale membership list after an edit. The Blobs version cache exists
// to avoid re-reading megabytes; it buys nothing for one row. Responses
// are therefore `no-store`.
//
// Id resolution: try the exact id first, then the exact name. This covers
// both id shapes the client may hold:
//   - the Neon id from a /api/graph-search result (a UUID), which hits the
//     id lookup, and
//   - the plain display name ("Sweet Water"), which hits the name fallback.
// What it does NOT cover: a city-suffixed client node id for a colliding
// name (e.g. the display id the graph uses to disambiguate two same-name
// bands) is neither a Neon id nor a plain name, so it 404s — the client
// must pass the Neon id from search results for colliding names. The name
// fallback is also inherently ambiguous when two bands share a name, so it
// orders by id asc and returns the first: deterministic, but the client
// must not rely on it for colliding names.
// Name matching is exact and case-sensitive (Neon `=`); search
// (/api/graph-search) is the case-insensitive path.
//
// Response:
//   band:   { ok, type:'band', entity: { id, name, city, state, country,
//             genre, years_active, label, albums, bio, created_at, added_by },
//             memberships: [{ member_id, member_name, tenure, weight,
//             relation }], links: [{ platform, url }] }
//   member: { ok, type:'member', entity: { id, name, city, state, country,
//             instrument1, instrument2, years_active, bio,
//             popularity_score }, memberships: [{ band_id, band_name,
//             tenure, weight, relation }], links: [] }
// Never any other bands/members beyond the requested entity's own
// memberships. Unknown id -> 404 { ok:false, error:'not found' }.
// Public read, same trust as /api/bands; no auth.

import {
  getSql,
  isDbConfigured,
  dbUnavailable,
  methodNotAllowed,
  badRequest,
  notFound,
  serverError,
} from './_db.mjs';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function findBand(sql, id) {
  const byId = await sql`
    select id, name, city, state, country, genre, years_active, label, albums, bio, created_at, added_by
    from bands
    where id = ${id}
    limit 1
  `;
  if (byId && byId.length) return byId[0];
  // Plain-name fallback, deterministic on collision (see header note).
  const byName = await sql`
    select id, name, city, state, country, genre, years_active, label, albums, bio, created_at, added_by
    from bands
    where name = ${id}
    order by id asc
    limit 1
  `;
  return byName && byName.length ? byName[0] : null;
}

async function findMember(sql, id) {
  const byId = await sql`
    select id, name, city, state, country, instrument1, instrument2, years_active, bio,
           coalesce(popularity_score, 0) as popularity_score
    from band_members
    where id = ${id}
    limit 1
  `;
  if (byId && byId.length) return byId[0];
  const byName = await sql`
    select id, name, city, state, country, instrument1, instrument2, years_active, bio,
           coalesce(popularity_score, 0) as popularity_score
    from band_members
    where name = ${id}
    order by id asc
    limit 1
  `;
  return byName && byName.length ? byName[0] : null;
}

async function bandCard(sql, entity) {
  const memberships = await sql`
    select member_id, tenure, weight, relation
    from memberships
    where band_id = ${entity.id}
  `;
  const memberIds = [...new Set((memberships || []).map((m) => m.member_id).filter(Boolean))];
  let namesById = new Map();
  if (memberIds.length) {
    const rows = await sql`
      select id, name from band_members where id = any(${memberIds})
    `;
    namesById = new Map((rows || []).map((r) => [r.id, r.name]));
  }
  const links = await sql`
    select platform, url from band_links where band_id = ${entity.id}
  `;
  return {
    ok: true,
    type: 'band',
    entity,
    memberships: (memberships || []).map((m) => ({
      member_id: m.member_id,
      member_name: namesById.get(m.member_id) ?? null,
      tenure: m.tenure ?? null,
      weight: m.weight ?? null,
      relation: m.relation ?? null,
    })),
    links: (links || []).map((l) => ({ platform: l.platform, url: l.url })),
  };
}

async function memberCard(sql, entity) {
  const memberships = await sql`
    select band_id, tenure, weight, relation
    from memberships
    where member_id = ${entity.id}
  `;
  const bandIds = [...new Set((memberships || []).map((m) => m.band_id).filter(Boolean))];
  let namesById = new Map();
  if (bandIds.length) {
    const rows = await sql`
      select id, name from bands where id = any(${bandIds})
    `;
    namesById = new Map((rows || []).map((r) => [r.id, r.name]));
  }
  return {
    ok: true,
    type: 'member',
    entity,
    memberships: (memberships || []).map((m) => ({
      band_id: m.band_id,
      band_name: namesById.get(m.band_id) ?? null,
      tenure: m.tenure ?? null,
      weight: m.weight ?? null,
      relation: m.relation ?? null,
    })),
    // Members carry no links: band_links is keyed by band_id only.
    links: [],
  };
}

/**
 * Testable handler: `req` is a Request (only .url and .method are read);
 * pass `sql` in tests, omit it in production (the default export supplies
 * the real one).
 */
export async function handleGraphCard(req, { sql } = {}) {
  if (req.method && req.method !== 'GET') return methodNotAllowed();

  const url = new URL(req.url);
  const type = url.searchParams.get('type') ?? '';
  const id = url.searchParams.get('id') ?? '';
  if (type !== 'band' && type !== 'member') {
    return badRequest("type must be 'band' or 'member'");
  }
  if (!id.trim()) {
    return badRequest('id is required');
  }

  const entity = type === 'band' ? await findBand(sql, id) : await findMember(sql, id);
  if (!entity) return notFound();

  const body = type === 'band' ? await bandCard(sql, entity) : await memberCard(sql, entity);
  return jsonResponse(200, body);
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  try {
    return await handleGraphCard(req, { sql });
  } catch (err) {
    console.error('graph-card GET failed', err);
    return serverError('could not load card', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/graph-card', method: 'GET' };
