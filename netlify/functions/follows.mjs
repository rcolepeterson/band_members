// /api/bands/:id/follow — the "Follow this band" action.
//
//   GET    -> { following: bool }           (is the caller following?)
///   POST   -> { following: true }           (follow; idempotent)
///   DELETE -> { following: false }          (unfollow; idempotent)
//
// Why follows exist: "touched" (see _notify.mjs) = created, edited, OR
// followed. Follows let a user get update emails for bands they care about
// but never edited — the lightweight engagement hook that doesn't require
// contributing first.
//
// Auth: bearer token required for all three methods. Anonymous callers get
// 401 before we touch the DB.
//
// The band id comes from the path (same :id extraction pattern as
// bands_edit.mjs: context.params first, URL-parse fallback). A follow for
// a band id that isn't in the bands table is a 404 — the client hides the
// button in that case (e.g. legacy graph nodes without a DB row).

import {
  getSql,
  isDbConfigured,
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

function extractBandId(req, context) {
  const fromContext = context && context.params && typeof context.params.id === 'string' ? context.params.id.trim() : '';
  if (fromContext) return fromContext;
  try {
    const pathname = new URL(req.url).pathname;
    const match = /\/api\/bands\/([^/]+)\/follow\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

export default async (req, context) => {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    return methodNotAllowed();
  }

  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  const bandId = extractBandId(req, context);
  if (!bandId) return badRequest('band id is required in the URL path', { field: 'id' });

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    // Confirm the band exists (and that bandId parses as a uuid — a
    // malformed id just won't match, which is the 404 we want).
    let bandExists = false;
    try {
      const bands = await sql`select id from bands where id = ${bandId} limit 1`;
      bandExists = bands.length > 0;
    } catch {
      bandExists = false;
    }
    if (!bandExists) return notFound('no band with that id');

    if (req.method === 'GET') {
      const rows = await sql`
        select 1 from band_follows where user_id = ${user.id} and band_id = ${bandId} limit 1
      `;
      return ok({ following: rows.length > 0 });
    }

    if (req.method === 'POST') {
      // Idempotent: following twice is still just following.
      await sql`
        insert into band_follows (user_id, band_id)
        values (${user.id}, ${bandId})
        on conflict (user_id, band_id) do nothing
      `;
      return ok({ following: true });
    }

    // DELETE — idempotent: unfollowing what you don't follow is a no-op.
    await sql`
      delete from band_follows where user_id = ${user.id} and band_id = ${bandId}
    `;
    return ok({ following: false });
  } catch (err) {
    console.error('follows failed', err);
    return serverError('follow failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/bands/:id/follow' };
