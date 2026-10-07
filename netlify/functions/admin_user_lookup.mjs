// POST /api/admin/user-lookup — find a user by handle (admin only).
// Body: { handle }
// Returns: { ok: true, email, handle, name, created_at } — never the token.

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
} from './_db.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return badRequest('expected a JSON body');
  }

  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  if (!handle) return badRequest('handle is required');

  try {
    const sql = getSql();
    const rows = await sql`
      select email, handle, name, created_at
        from users
       where lower(handle) = lower(${handle})
       limit 1`;
    if (!rows || !rows.length) return notFound('no such user');
    const u = rows[0];
    return ok({
      email: u.email,
      handle: u.handle,
      name: u.name,
      created_at: u.created_at,
    });
  } catch (err) {
    console.error('admin-user-lookup failed', err && err.message);
    return serverError('lookup failed');
  }
};

export const config = { path: '/api/admin/user-lookup', method: 'POST' };
