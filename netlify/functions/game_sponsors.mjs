// Game sponsor ribbon.
//
// GET  /api/game-sponsors — public. Returns the ordered sponsor list for the
//   "This week's game is brought to you by" ribbon in the game card:
//   { ok: true, sponsors: [{ id, name, icon_url, link_url, sort_order }] }
//   Empty table (or no DB configured) -> { ok: true, sponsors: [] } so the
//   game card falls back to its tasteful "your brand here" placeholder and
//   never breaks because this endpoint is down.
// POST /api/game-sponsors — admin. Body: { name, icon_url, link_url?, sort_order? }
// PUT  /api/game-sponsors — admin. Body: { id, name?, icon_url?, link_url?, sort_order? }
// DELETE /api/game-sponsors?id=<id> — admin.
//
// Writes are guarded by the same x-admin-token header migrate.mjs uses, so
// only the maintainer can change who the game is brought to you by.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  notFound,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

const MAX_NAME = 120;
const MAX_URL = 2048;

function cleanText(raw, max) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cleanUrl(raw) {
  const u = cleanText(raw, MAX_URL);
  if (!u) return null;
  // Icons and links must be absolute http(s) URLs — no javascript:, no
  // relative paths, no data: blobs rendered into other people's game cards.
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

// Validates a sponsor payload. Returns { name, icon_url, link_url, sort_order }
// or null. Exported so tests can exercise it without a database.
export function validSponsor(body) {
  if (!body || typeof body !== 'object') return null;
  const name = cleanText(body.name, MAX_NAME);
  const icon_url = cleanUrl(body.icon_url);
  if (!name || !icon_url) return null;
  const link_url = body.link_url == null || body.link_url === '' ? null : cleanUrl(body.link_url);
  if (body.link_url != null && body.link_url !== '' && !link_url) return null;
  let sort_order = 0;
  if (body.sort_order != null && body.sort_order !== '') {
    sort_order = Number(body.sort_order);
    if (!Number.isFinite(sort_order)) return null;
    sort_order = Math.max(0, Math.min(1000, Math.round(sort_order)));
  }
  return { name, icon_url, link_url, sort_order };
}

function rowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    icon_url: row.icon_url,
    link_url: row.link_url,
    sort_order: row.sort_order,
  };
}

export default async (req) => {
  const url = new URL(req.url);

  // --- GET: the public ribbon list -------------------------------------------
  if (req.method === 'GET') {
    if (!isDbConfigured()) return ok({ sponsors: [] });
    try {
      const sql = getSql();
      const rows = await sql`
        select id, name, icon_url, link_url, sort_order
        from game_sponsors
        order by sort_order asc, created_at asc
        limit 7
      `;
      return ok({ sponsors: (rows || []).map(rowToJson) });
    } catch (error) {
      // The ribbon must never break the game: on any read failure the card
      // shows its placeholder, same as an empty table.
      console.error('game-sponsors: read failed', error && error.message);
      return ok({ sponsors: [] });
    }
  }

  // --- writes: admin only ------------------------------------------------------
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    const sponsor = validSponsor(body);
    if (!sponsor) return badRequest('name and a valid https icon_url are required');
    try {
      const sql = getSql();
      const rows = await sql`
        insert into game_sponsors (name, icon_url, link_url, sort_order)
        values (${sponsor.name}, ${sponsor.icon_url}, ${sponsor.link_url}, ${sponsor.sort_order})
        returning id, name, icon_url, link_url, sort_order
      `;
      return ok({ sponsor: rowToJson(rows[0]) });
    } catch (error) {
      console.error('game-sponsors: insert failed', error && error.message);
      return serverError('could not add the sponsor');
    }
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    const id = cleanText(body && body.id, 64);
    if (!id) return badRequest('id is required');
    const sponsor = validSponsor(body);
    if (!sponsor) return badRequest('name and a valid https icon_url are required');
    try {
      const sql = getSql();
      const rows = await sql`
        update game_sponsors
        set name = ${sponsor.name},
            icon_url = ${sponsor.icon_url},
            link_url = ${sponsor.link_url},
            sort_order = ${sponsor.sort_order}
        where id = ${id}
        returning id, name, icon_url, link_url, sort_order
      `;
      if (!rows || !rows[0]) return notFound('no such sponsor');
      return ok({ sponsor: rowToJson(rows[0]) });
    } catch (error) {
      console.error('game-sponsors: update failed', error && error.message);
      return serverError('could not update the sponsor');
    }
  }

  if (req.method === 'DELETE') {
    const id = cleanText(url.searchParams.get('id'), 64);
    if (!id) return badRequest('id is required');
    try {
      const sql = getSql();
      const rows = await sql`delete from game_sponsors where id = ${id} returning id`;
      if (!rows || !rows[0]) return notFound('no such sponsor');
      return ok({ deleted: rows[0].id });
    } catch (error) {
      console.error('game-sponsors: delete failed', error && error.message);
      return serverError('could not delete the sponsor');
    }
  }

  return methodNotAllowed();
};

export const config = { path: '/api/game-sponsors' };
