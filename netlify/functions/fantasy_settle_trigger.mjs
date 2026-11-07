// POST /api/cron-fantasy-settle — manual, admin-only run of the fantasy
// settle (same code as the schedule; see cron_verify_stale_bands_trigger.mjs
// for why it's a separate file — a `config.schedule` export takes over a
// file's routing entirely, so a scheduled function can't also be invoked
// by URL). ?date=YYYY-MM-DD settles that past day (default: yesterday,
// Pacific). ?dry=1 computes shares, finals, and the winner and writes
// nothing. A real run is safe to repeat: settle is idempotent, and career
// wins are derived from stored win flags, never incremented.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  badRequest,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { pacificDate } from './_daily.mjs';
import { settleFantasyDay } from './fantasy_settle.mjs';
import { previousPacificDate } from './_fantasy.mjs';

export const config = { path: '/api/cron-fantasy-settle', method: 'POST' };

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

  const params = new URL(req.url).searchParams;
  const date = params.get('date') || previousPacificDate(pacificDate());
  const dryRun = params.get('dry') === '1';
  try {
    const summary = await settleFantasyDay(getSql(), date, { dryRun, settledBy: 'manual' });
    console.log(`[cron:fantasy-settle] manual run: ${JSON.stringify(summary)}`);
    return ok(summary);
  } catch (err) {
    console.error('[cron:fantasy-settle] manual run failed:', err && err.message);
    if (/not over yet|needs a YYYY-MM-DD/.test(err.message || '')) {
      return badRequest(err.message);
    }
    return serverError('settle run failed');
  }
};
