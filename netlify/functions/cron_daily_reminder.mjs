// Scheduled: the daily puzzle reminder (Cole, 2026-10-11). See
// _daily_reminder.mjs for who gets it and the one-per-day rule.
//
// When: 15:00 UTC = 8:00 Pacific (7:00 during PST). The puzzle itself turns
// over at midnight Pacific, which is 3am on the East Coast, a bad time for
// an email, and nobody has played yet then, so "skip anyone who already
// played" would skip no one. Mid-morning lands in the inbox when people are
// up and skips the early birds who already played.

import { getSql, isDbConfigured } from './_db.mjs';
import { runDailyReminders } from './_daily_reminder.mjs';

export const config = { schedule: '0 15 * * *' };

export default async () => {
  if (!isDbConfigured()) {
    console.log('[cron:reminder] db not configured, skipping');
    return;
  }
  const summary = await runDailyReminders(getSql());
  console.log(`[cron:reminder] complete: ${JSON.stringify(summary)}`);
};
