// DELETE /api/bands/:id — hard-delete a band node and its dependent rows.
//
// Why this exists: the Sep-2026 Sweet Water duplicate (empty node, no city,
// no members — just three links) has to go, and Aaron approved deleting the
// bad node. This endpoint is the safe, auditable way to do it.
//
// Safety rules:
//   - Admin-token only (x-admin-token, same as the other admin endpoints).
//   - NEVER deletes a band with memberships: the member guard returns 409
//     when the band has any member rows. Bands with history are edited or
//     merged by a maintainer, never hard-deleted through this route.
//   - Deletes the band row plus its dependent rows (band_links,
//     band_follows, verifications, band_notification_log) in one
//     transaction. Every dependent table declares `on delete cascade`, but
//     the deletes are explicit so the row counts show up in the log line.
//
// After merge + deploy + migrate, Aaron deletes the Sweet Water duplicate
// himself with his saved admin token:
//
//   DELETE https://sixdegreesofrock.com/api/bands/9dcd9cd0-a34b-4304-ba75-cd38139c5e30
//
// The core logic lives in deleteBandById(sql, bandId) so tests can drive it
// with a fake `sql`; the default export is Netlify's HTTP wrapper.

import {
  getSql,
  isDbConfigured,
  json,
  unauthorized,
  dbUnavailable,
  badRequest,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { requestHasAdminToken } from './_links.mjs';

// Pure guard, exported for tests. memberCount is the number of membership
// rows pointing at the band; exists is false when the band row is missing.
export function canDeleteBand({ memberCount, exists = true }) {
  if (!exists) return { ok: false, reason: 'band not found' };
  if (memberCount > 0) {
    return {
      ok: false,
      reason: `band has ${memberCount} member${memberCount === 1 ? '' : 's'}; refusing hard delete — edit or merge instead`,
    };
  }
  return { ok: true };
}

// Returns { status, body }; throws only on unexpected DB failures.
export async function deleteBandById(sql, bandId) {
  const bandRows = await sql`
    select id, name, city, state, country from bands where id = ${bandId}
  `;
  if (!bandRows.length) {
    return { status: 404, body: { ok: false, error: 'band not found' } };
  }
  const band = bandRows[0];

  const memberRows = await sql`
    select count(*)::int as n from memberships where band_id = ${bandId}
  `;
  const guard = canDeleteBand({ memberCount: memberRows[0] ? memberRows[0].n : 0 });
  if (!guard.ok) {
    return { status: 409, body: { ok: false, error: guard.reason, error_code: 'band_has_members' } };
  }

  // One transaction: the band row plus its dependent rows.
  const [links, follows, verifs, notifLog] = await sql.transaction([
    sql`delete from band_links where band_id = ${bandId}`,
    sql`delete from band_follows where band_id = ${bandId}`,
    sql`delete from verifications where band_id = ${bandId}`,
    sql`delete from band_notification_log where band_id = ${bandId}`,
    sql`delete from bands where id = ${bandId}`,
  ]);
  const deleted = {
    links: links.count || 0,
    follows: follows.count || 0,
    verifications: verifs.count || 0,
    notification_log: notifLog.count || 0,
  };
  console.log(
    `[bands:delete] deleted band ${bandId} ("${band.name}") ` +
      `links=${deleted.links} follows=${deleted.follows} ` +
      `verifications=${deleted.verifications} notification_log=${deleted.notification_log}`
  );

  return {
    status: 200,
    body: { ok: true, deleted_band_id: bandId, deleted_band_name: band.name, deleted },
  };
}

// Extract the :id path param, preferring context.params, falling back to
// manual URL parsing against the known /api/bands/:id shape.
// (Same helper shape as bands_edit.mjs.)
function extractBandId(req, context) {
  const fromContext = context && context.params && typeof context.params.id === 'string' ? context.params.id.trim() : '';
  if (fromContext) return fromContext;
  try {
    const pathname = new URL(req.url).pathname;
    const match = /\/api\/bands\/([^/]+)\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

export default async (req, context) => {
  if (req.method !== 'DELETE') return methodNotAllowed();

  // Auth before DB config — unauthenticated callers should not learn
  // whether the DB is even configured (same discipline as every other
  // admin-guarded endpoint in this codebase).
  if (!requestHasAdminToken(req)) return unauthorized('admin token required');
  if (!isDbConfigured()) return dbUnavailable();

  const bandId = extractBandId(req, context);
  if (!bandId) return badRequest('band id is required');

  const sql = getSql();
  try {
    const result = await deleteBandById(sql, bandId);
    return json(result.status, result.body);
  } catch (err) {
    console.error('[bands:delete] failed', err);
    return serverError('could not delete band', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/bands/:id', method: 'DELETE' };
