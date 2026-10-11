// GET /api/me — return the user identified by the Authorization: Bearer token.
//
// Purpose: on page load the client reads its token from localStorage and hits
// this endpoint to (a) verify the token is still valid and (b) refresh the
// live counters (bands_added, bands_edited) which may have been updated on
// another device. A 401 tells the client to clear its stored token and
// present the signed-out UI.
//
// PATCH /api/me — "Your card" in the account menu (2026-10-11): the signed-in
// user edits their own name, city, state, country and instrument. Sign-up no
// longer asks for these, so this is where they get filled in. Only the
// fields sent are changed; an empty string clears a profile field. The name
// can be changed but not cleared (users.name is not null).
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
  badRequest,
  normalizeName,
  normalizeCity,
  normalizeState,
  normalizeCountry,
  normalizeInstrument,
} from './_db.mjs';

const PROFILE_FIELDS = {
  city: normalizeCity,
  state: normalizeState,
  country: normalizeCountry,
  instrument: normalizeInstrument,
};

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    bands_added: user.bands_added,
    bands_edited: user.bands_edited,
    created_at: user.created_at,
    // Profile fields: optional, null until the user fills them in.
    city: user.city,
    state: user.state,
    country: user.country,
    instrument: user.instrument,
  };
}

// The changes a PATCH body asks for, normalized. Exported for the tests.
export function profileChanges(body) {
  const changes = {};
  if (!body || typeof body !== 'object') return { error: 'request body must be JSON' };
  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return { error: 'name can\u2019t be empty', field: 'name' };
    changes.name = name;
  }
  for (const [field, normalize] of Object.entries(PROFILE_FIELDS)) {
    if (body[field] !== undefined) changes[field] = normalize(body[field]) || null;
  }
  if (!Object.keys(changes).length) return { error: 'nothing to update' };
  return { changes };
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed();

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

    if (req.method === 'PATCH') {
      const body = await req.json().catch(() => null);
      const { changes, error, field } = profileChanges(body);
      if (error) return badRequest(error, field ? { field } : undefined);
      const next = { ...user, ...changes };
      const updated = await sql`
        update users set
          name       = ${next.name},
          city       = ${next.city ?? null},
          state      = ${next.state ?? null},
          country    = ${next.country ?? null},
          instrument = ${next.instrument ?? null},
          updated_at = now()
        where id = ${user.id}
        returning id, email, name, bands_added, bands_edited, created_at,
                  city, state, country, instrument
      `;
      return ok({ user: publicUser(updated[0]) });
    }

    return ok({ user: publicUser(user) });
  } catch (err) {
    console.error('me failed', err);
    return serverError('me failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/me' };
