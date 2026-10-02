// POST /api/cron-onboarding-drip-trigger — manual, admin-only trigger for
// the onboarding email (thank-you from Aaron).
//
// Why a separate file: a `config.schedule` export takes over a file's
// routing entirely (Netlify scheduled functions "can't be invoked directly
// with a URL"), so the on-demand path lives here. Both import
// runOnboarding() from _onboarding.mjs — identical selection, credit
// grant, and logging; nothing to keep in sync by hand.
//
// ?kind=blast — one-time thank-you to all current users (the founding
//   crew). ?kind=drip (default) — the 48–72h window, same as the cron.
// This is what fires the founding blast: POST with x-admin-token.
//
// Auth: same ADMIN_TOKEN + x-admin-token convention as migrate.mjs —
// maintainer-only, not a signed-in-user action.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { runOnboarding } from './_onboarding.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

// Path follows the cron_verify_stale_bands_trigger convention: dashes,
// no _trigger suffix.
export const config = { path: '/api/cron-onboarding-drip', method: 'POST' };

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

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') === 'blast' ? 'blast' : 'drip';

  try {
    const sql = getSql();
    const summary = await runOnboarding(sql, kind);
    console.log(`[cron:onboarding] manual ${kind} complete: ${JSON.stringify(summary)}`);
    return ok(summary);
  } catch (err) {
    console.error('[cron:onboarding] manual trigger failed:', err);
    return serverError('onboarding run failed');
  }
};
