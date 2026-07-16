// POST /api/admin-clear-verifications — one-shot admin endpoint to delete
// all rows from the `verifications` table. Used exactly once after PR 4c
// merges so the cron backfills fresh scores with the new logic; will be
// removed in the immediate follow-up PR (same pattern as PR #56 -> #57).
//
// Auth: same ADMIN_TOKEN + x-admin-token convention as migrate.mjs /
// cron_verify_stale_bands_trigger.mjs. This is a maintainer-only, all-of-
// table destructive operation, not a per-user action.
//
// Idempotent: running it a second time deletes 0 rows.

import {
  getSql,
  isDbConfigured,
  ok,
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

  const sql = getSql();

  try {
    // Count before, delete, then confirm. `verifications` has no FK
    // dependencies pointing into it (contributions FK the OTHER way was
    // handled in PR 4a — verifications hangs off bands only), so a plain
    // delete is safe without a CTE.
    const before = await sql`select count(*)::int as n from verifications`;
    const deleted = await sql`delete from verifications returning band_id`;
    const after = await sql`select count(*)::int as n from verifications`;

    const summary = {
      ok: true,
      before: before[0].n,
      deleted: deleted.length,
      after: after[0].n,
    };
    console.log(`[admin] cleared verifications: before=${summary.before} deleted=${summary.deleted} after=${summary.after}`);
    return ok(summary);
  } catch (err) {
    console.error('[admin] clear verifications failed', err);
    return serverError('clear verifications failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/admin-clear-verifications', method: 'POST' };
