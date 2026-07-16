// GET /api/me — return the user identified by the Authorization: Bearer token.
//
// Purpose: on page load the client reads its token from localStorage and hits
// this endpoint to (a) verify the token is still valid and (b) refresh the
// live counters (bands_added, bands_edited) which may have been updated on
// another device. A 401 tells the client to clear its stored token and
// present the signed-out UI.
//
// Not exposing the token in the response — the client already has it. That
// keeps this endpoint safe to log if we ever want to.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();

  // Auth check runs before DB config check so that unauthenticated callers
  // get a consistent 401 whether or not the DB is available. This avoids
  // leaking deployment state to anonymous clients.
  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    return ok({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        bands_added: user.bands_added,
        bands_edited: user.bands_edited,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('me failed', err);
    return serverError('me failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/me' };
