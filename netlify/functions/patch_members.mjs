// POST /api/patch-members — admin-only one-off DB cleanup endpoint.
//
// Purpose: clear specific junk `instrument1` values from band_members rows so
// a subsequent /api/seed-bands run can fill in the correct instrument via
// its fill-missing semantics.
//
// Body: { updates: [ { name, instrument1?, instrument2? }, ... ] }
// Each update is case-insensitive by name. `null` fields are set to NULL.
// Missing fields are left alone. Returns a per-row updated count.
//
// This endpoint exists because our seed upsert is deliberately fill-missing
// (never clobbers existing data), which is the right default but blocks
// correcting existing wrong values. Rather than adding a "force overwrite"
// mode to the seed (which could accidentally destroy real user edits), we
// keep the seed conservative and use this narrow endpoint for one-off
// corrections. It's admin-only, method-only-POST, and takes explicit inputs
// per row so it can't accidentally do a mass update.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
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

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('request body must be JSON');
  }
  if (!body || !Array.isArray(body.updates)) {
    return badRequest('body must be { updates: [...] }', { field: 'updates' });
  }

  const sql = getSql();
  const results = [];
  try {
    for (const update of body.updates) {
      if (!update || typeof update !== 'object') continue;
      const name = typeof update.name === 'string' ? update.name.trim() : '';
      if (!name) continue;

      // Build the SET clause dynamically so callers can update instrument1,
      // instrument2, or both — and can use JSON null to explicitly clear a
      // field (vs. omitting the field to leave it alone).
      const setClauses = [];
      if ('instrument1' in update) {
        const v = update.instrument1;
        setClauses.push(sql`instrument1 = ${v === null ? null : String(v)}`);
      }
      if ('instrument2' in update) {
        const v = update.instrument2;
        setClauses.push(sql`instrument2 = ${v === null ? null : String(v)}`);
      }
      if (setClauses.length === 0) {
        results.push({ name, updated: 0, skipped: 'no fields to update' });
        continue;
      }

      // Compose the SET clause. Neon's tagged template composes via sql`` in
      // the argument slots — see other endpoints for the pattern.
      let query;
      if (setClauses.length === 1) {
        query = sql`update band_members set ${setClauses[0]} where lower(name) = ${name.toLowerCase()}`;
      } else {
        query = sql`update band_members set ${setClauses[0]}, ${setClauses[1]} where lower(name) = ${name.toLowerCase()}`;
      }
      const rows = await query;
      results.push({ name, updated: rows.count ?? rows.length ?? 0 });
    }
    return ok({ results });
  } catch (err) {
    console.error('patch_members failed', err);
    return serverError('patch failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/patch-members' };
