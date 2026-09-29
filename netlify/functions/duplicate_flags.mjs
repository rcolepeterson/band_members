// GET /api/admin/duplicate-flags — list unresolved duplicate-band flags.
//
// Companion to the duplicate-band monitor in cron_verify_stale_bands.mjs
// (scanDuplicateBands), which inserts one row per detected true-duplicate
// pair into the duplicate_flags table during the daily 3am run.
//
// Why a separate file: same Netlify constraint as
// cron_verify_stale_bands_trigger.mjs — a file exporting `config.schedule`
// can't also serve HTTP, so the read API lives here.
//
// Auth: x-admin-token only (requestHasAdminToken from _links.mjs). This is
// maintainer tooling, not a signed-in-user action.
//
// Response: { flags: [ { id, band_ids, detected_at, note, bands: [
//   { id, name, city, state, country } ] } ] } — band details are joined in
// for readability so the maintainer can decide at a glance which node is
// the keeper and which is the dup.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { requestHasAdminToken } from './_links.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();

  // Auth before DB config — unauthenticated callers should not learn
  // whether the DB is even configured (same discipline as every other
  // admin-guarded endpoint in this codebase).
  if (!requestHasAdminToken(req)) return unauthorized('admin token required');
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const flags = await sql`
      select id, band_ids, detected_at, note
      from duplicate_flags
      where resolved_at is null
      order by detected_at desc
    `;

    const bandIds = [...new Set(flags.flatMap((f) => f.band_ids || []))];
    let byId = new Map();
    if (bandIds.length) {
      const bands = await sql`
        select id, name, city, state, country
        from bands
        where id = any(${bandIds})
      `;
      byId = new Map(bands.map((b) => [b.id, b]));
    }

    return ok({
      flags: flags.map((f) => ({
        id: f.id,
        band_ids: f.band_ids,
        detected_at: f.detected_at,
        note: f.note,
        bands: (f.band_ids || []).map((id) => byId.get(id) || { id }),
      })),
    });
  } catch (err) {
    console.error('[duplicate-flags] failed', err);
    return serverError('could not load duplicate flags', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/admin/duplicate-flags', method: 'GET' };
