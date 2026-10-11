// POST /api/cron-daily-reminder — manual, admin-only run of the daily
// reminder (same code as the schedule; see cron_onboarding_drip_trigger.mjs
// for why it's a separate file). ?dry=1 counts who would get it, sends
// nothing. A real run is safe to repeat: nobody gets two in a day.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import { runDailyReminders } from './_daily_reminder.mjs';

export const config = { path: '/api/cron-daily-reminder', method: 'POST' };

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
    const summary = await runDailyReminders(getSql(), { dryRun });
    console.log(`[cron:reminder] manual run: ${JSON.stringify(summary)}`);
    return ok(summary);
  } catch (err) {
    console.error('[cron:reminder] manual run failed:', err);
    return serverError('reminder run failed');
  }
};
