// Scheduled: the day-2 onboarding drip — thank-you from Aaron.
//
// Netlify scheduled functions (v2 syntax): `config.schedule` is a cron
// expression evaluated in UTC. "0 17 * * *" is 17:00 UTC = 10:00 Pacific
// during PDT (UTC-7); a one-hour seasonal drift during PST is accepted
// (same tradeoff as cron_verify_stale_bands).
//
// Picks up users whose created_at is 48–72h old and who have never
// received the onboarding email. The shared runOnboarding() in
// _onboarding.mjs holds the selection, credit grant, and logging — the
// manual trigger (cron_onboarding_drip_trigger.mjs) imports the same
// function so both paths can't drift.

import { getSql, isDbConfigured } from './_db.mjs';
import { runOnboarding } from './_onboarding.mjs';

export const config = { schedule: '0 17 * * *' };

export default async () => {
  if (!isDbConfigured()) {
    console.log('[cron:onboarding] db not configured, skipping');
    return;
  }
  const sql = getSql();
  const summary = await runOnboarding(sql, 'drip');
  console.log(`[cron:onboarding] drip complete: ${JSON.stringify(summary)}`);
};
