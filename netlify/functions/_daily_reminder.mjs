// Daily puzzle reminder email (Cole, 2026-10-11).
//
// Opt-in only: notification_prefs.email_daily_reminder defaults to false and
// is turned on by the "Remind me daily" toggle in the account menu or the
// "Want a reminder tomorrow?" prompt after a puzzle. The band-update switch
// (email_enabled) is a separate list; each has its own unsubscribe.
//
// Rules, all enforced here:
//   - Never guests, never placeholder (Instagram OAuth) addresses.
//   - Only users who opted in.
//   - One email per user per day: daily_reminder_log has a row per
//     (user, chain_date), claimed before the send, so a rerun or a double
//     trigger can't send twice.
//   - Skip anyone who already started today's puzzle.
//   - REMINDER_SEND_CAP keeps a bug from burning the Resend quota.
//
// Same failure contract as _notify.mjs / _onboarding.mjs: one user's failure
// never stops the batch, and the run reports what it did.

import { sendEmail as defaultSendEmail, isMailerConfigured, SITE_URL } from './_mailer.mjs';
import { unsubscribeUrlFor } from './_notify.mjs';
import { isPlaceholderEmail } from './_oauth.mjs';
import { pacificDate } from './_daily.mjs';
import { dailyPuzzleNumber } from '../../scripts/six-degrees-game.mjs';

export const PLAY_URL = `${SITE_URL}/game/`;

// Shares Resend's 100/day free tier with the band-update emails.
export const REMINDER_SEND_CAP = 80;

// The flag and the log, created on first use so the toggle works before
// anyone runs /api/migrate (migrate.mjs has the same statements). Once per
// warm instance.
let schemaReady = null;
export function ensureReminderSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // Look before altering: ALTER takes a table lock even when it's a no-op.
      const has = await sql`
        select 1 from information_schema.columns
        where table_name = 'notification_prefs' and column_name = 'email_daily_reminder'
        limit 1
      `;
      if (!has.length) {
        await sql`alter table notification_prefs add column if not exists email_daily_reminder boolean not null default false`;
      }
      await sql`
        create table if not exists daily_reminder_log (
          user_id    uuid not null references users(id) on delete cascade,
          chain_date text not null,
          sent_at    timestamptz not null default now(),
          primary key (user_id, chain_date)
        )
      `;
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
export function __resetReminderSchemaForTests() { schemaReady = null; }

// The unsubscribe link in a reminder turns off reminders only.
export function reminderUnsubscribeUrl(token) {
  return `${unsubscribeUrlFor(token)}&list=daily`;
}

export function buildDailyReminderEmail({ date, unsubscribeUrl }) {
  const num = dailyPuzzleNumber(date);
  const subject = 'Today’s 6° puzzle is live';
  const line1 = `6° Rock${num ? ` #${num}` : ''} is up. Two bands, one chain to find.`;
  const text =
    `${line1}\n` +
    `Play: ${PLAY_URL}\n\n` +
    `You asked for a daily reminder. Stop them: ${unsubscribeUrl}\n`;
  const html =
    `<div style="font-family: Georgia, serif; color: #e8e4da; background: #14120e; padding: 32px; max-width: 560px;">` +
    `<p style="font-size: 18px; line-height: 1.6; margin: 0 0 12px;">${line1}</p>` +
    `<p style="margin: 0;"><a href="${PLAY_URL}" style="color: #c9a96a;">Play today’s puzzle</a></p>` +
    `<hr style="border: none; border-top: 1px solid #3a352c; margin: 24px 0;" />` +
    `<p style="font-size: 12px; color: #8a8478;">You asked for a daily reminder. ` +
    `<a href="${unsubscribeUrl.replace(/&/g, '&amp;')}" style="color: #8a8478;">Stop these emails</a> with one click.</p>` +
    `</div>`;
  return { subject, html, text };
}

// Opted in, real account, not reminded today, hasn't started today's puzzle.
export async function selectReminderRecipients(sql, date) {
  const rows = await sql`
    select u.id, u.email, p.unsubscribe_token
    from users u
    join notification_prefs p on p.user_id = u.id
    where p.email_daily_reminder = true
      and u.is_guest = false
      and p.unsubscribe_token is not null
      and not exists (select 1 from daily_reminder_log l where l.user_id = u.id and l.chain_date = ${date})
      and not exists (select 1 from daily_runs r where r.user_id = u.id and r.chain_date = ${date})
    order by u.created_at
  `;
  return rows.filter((r) => r.email && !isPlaceholderEmail(r.email));
}

export async function runDailyReminders(sql, { date = pacificDate(), dryRun = false, sendEmail } = {}) {
  const send = sendEmail || defaultSendEmail;
  if (!sendEmail && !dryRun && !isMailerConfigured()) {
    return { ok: false, date, error: 'mailer not configured', sent: 0 };
  }
  await ensureReminderSchema(sql);
  const recipients = await selectReminderRecipients(sql, date);
  if (dryRun) return { ok: true, date, dryRun: true, considered: recipients.length, sent: 0 };

  let sent = 0;
  let failed = 0;
  let capped = 0;
  for (const user of recipients) {
    if (sent >= REMINDER_SEND_CAP) { capped += 1; continue; }
    try {
      // Claim the day first: if this row already exists, someone else sent it.
      const claimed = await sql`
        insert into daily_reminder_log (user_id, chain_date) values (${user.id}, ${date})
        on conflict do nothing
        returning user_id
      `;
      if (!claimed.length) continue;
      const { subject, html, text } = buildDailyReminderEmail({
        date,
        unsubscribeUrl: reminderUnsubscribeUrl(user.unsubscribe_token),
      });
      const result = await send({ to: user.email, subject, html, text });
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
        // Not sent, so not counted against today.
        await sql`delete from daily_reminder_log where user_id = ${user.id} and chain_date = ${date}`;
      }
    } catch (err) {
      failed += 1;
      console.error('[reminder] one send failed', err && err.message);
    }
  }
  return { ok: true, date, considered: recipients.length, sent, failed, capped };
}
