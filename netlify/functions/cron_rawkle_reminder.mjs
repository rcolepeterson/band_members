// Scheduled: the Rawkle reminder (same pipe as the card game, same
// contract as Daily's _daily_reminder.mjs — see _game_reminders.mjs).
//
// When: 15:30 UTC = 8:30 Pacific daylight (7:30 standard). Daily's
// reminder goes at 8:00, so Rawkle lands half an hour later and the two
// don't arrive as a pair. The puzzle itself turns over at midnight
// Pacific, so mid-morning lands in the inbox when people are up.
//
// No skip-if-played: Rawkle keeps progress on the device, so the server
// cannot know who played. The email never names the band, so it is a
// nudge, not a spoiler.

import { getSql, isDbConfigured } from './_db.mjs';
import { runGameReminders } from './_game_reminders.mjs';

export const config = { schedule: '30 15 * * *' };

export default async () => {
  if (!isDbConfigured()) {
    console.log('[cron:rawkle-reminder] db not configured, skipping');
    return;
  }
  const summary = await runGameReminders(getSql(), 'rawkle');
  console.log(`[cron:rawkle-reminder] complete: ${JSON.stringify(summary)}`);
};
