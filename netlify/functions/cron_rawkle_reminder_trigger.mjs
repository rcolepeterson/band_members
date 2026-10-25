// POST /api/cron-rawkle-reminder — manual, admin-only run of the rawkle
// reminder (same code as the schedule). ?dry=1 counts who would get it,
// sends nothing. A real run is safe to repeat: nobody gets two in a day.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { runGameReminders } from './_game_reminders.mjs';

export const config = { path: '/api/cron-rawkle-reminder', method: 'POST' };

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.('x-admin-token') || '';
  return provided === expected;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();
  const dryRun = new URL(req.url).searchParams.get('dry') === '1';
  try {
    const summary = await runGameReminders(getSql(), 'rawkle', { dryRun });
    console.log(`[cron:rawkle-reminder] manual run: ${JSON.stringify(summary)}`);
    return ok(summary);
  } catch (err) {
    console.error('[cron:rawkle-reminder] manual run failed:', err && err.message);
    return serverError('reminder run failed');
  }
};
