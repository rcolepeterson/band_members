// POST /api/cron-verify-stale-bands — manual, admin-only trigger for the
// same stale-bands verification batch that cron_verify_stale_bands.mjs
// runs on its own every day at 10am UTC.
//
// Why a separate file: Netlify scheduled functions ("can't be invoked
// directly with a URL" per Netlify's docs) claim the entire routing of a
// file that exports `config.schedule`. There is no way to also mount an
// HTTP-reachable path in that same file, so the on-demand trigger the PR
// asks for ("allow POST with admin token... to run it on-demand for
// testing") has to live here instead. Both files import `runBatch` (and
// the pieces it's built from) from cron_verify_stale_bands.mjs, so the
// selection query, per-band verification logic, and batch size are always
// identical between the nightly cron and this manual path — there's
// nothing here to keep in sync by hand.
//
// Auth: same ADMIN_TOKEN + x-admin-token header convention as
// migrate.mjs / seed_bands.mjs / bands.mjs's DELETE handler. This is not
// a signed-in-user action (it hits external APIs and writes DB rows on
// behalf of the whole app, not one user's own edit), so it gets the same
// bar as those other maintainer-only endpoints, not the lighter bearer-
// token check used by verify_band.mjs.
//
// Batch size: identical BATCH_SIZE (10) as the scheduled run — the task
// asks for "same limit of 10 bands per invocation", so this file does not
// accept a caller-supplied override.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { runBatch, BATCH_SIZE } from './cron_verify_stale_bands.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth before DB config — unauthenticated callers should not learn
  // whether the DB is even configured (same discipline as every other
  // admin-guarded endpoint in this codebase).
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const summary = await runBatch(sql, BATCH_SIZE);
    console.log(`[cron:verify] manual trigger complete: processed=${summary.processed} succeeded=${summary.succeeded} failed=${summary.failed} next_stale_count=${summary.next_stale_count}`);
    return ok(summary);
  } catch (err) {
    console.error('[cron:verify] manual trigger failed entirely', err);
    return serverError('manual verification batch failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/cron-verify-stale-bands', method: 'POST' };
