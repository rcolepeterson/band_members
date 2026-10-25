// Scheduled: the card game reminder (same pipe as Rawkle, same contract
// as Daily's _daily_reminder.mjs — see _game_reminders.mjs).
//
// When: 16:00 UTC = 9:00 Pacific daylight (8:00 standard). Daily goes at
// 8:00 and Rawkle at 8:30, so each game's reminder lands half an hour
// apart and nobody gets three emails at once.
//
// The card game has no daily answer, so the email carries no puzzle
// number — just the nudge to deal a hand.

import { getSql, isDbConfigured } from './_db.mjs';
import { runGameReminders } from './_game_reminders.mjs';

export const config = { schedule: '0 16 * * *' };

export default async () => {
  if (!isDbConfigured()) {
    console.log('[cron:cards-reminder] db not configured, skipping');
    return;
  }
  const summary = await runGameReminders(getSql(), 'cards');
  console.log(`[cron:cards-reminder] complete: ${JSON.stringify(summary)}`);
};
