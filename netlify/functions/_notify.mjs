// Band-update notification orchestration — the "who gets emailed when a
// band changes" logic, shared by every write endpoint.
//
// The engagement loop: when a band is added or edited by someone, everyone
// who has "touched" that band gets at most one teaser email per 24 hours.
//
// "Touched" = created the band, edited it (bands.added_by / bands.edited_by
// plus the contributions log), or explicitly follows it (band_follows).
// The contributions table is the recipient source for creators/editors — no
// new tracking needed there; follows are the only new affordance (a "Follow
// this band" button on the band card, see follows.mjs).
//
// Rules (all enforced here, not in the callers):
//   - Never notify the actor about their own edit.
//   - Honor the per-user preference (notification_prefs.email_enabled and
//     unsubscribed_at). Default ON — the loop only works if people are in
//     it; opting out is one tap away (user card toggle, one-click footer
//     link).
//   - 24-hour cooldown per (band, user): band_notification_log is the clock.
//   - Daily global cap (DAILY_SEND_CAP) as backstop against the Resend free
//     tier quota (100/day) — a runaway bug must not burn the quota.
//
// Failure contract: notifyBandTouched() NEVER throws and NEVER blocks the
// write it follows. Every failure mode (mailer unconfigured, DB hiccup,
// Resend error) is caught and logged; the band write already committed and
// its HTTP response is unaffected. Callers await it (serverless invocations
// may freeze after the response, so fire-and-forget promises are unreliable)
// but treat the result as informational.

import { generateToken } from './_db.mjs';
import {
  buildBandUpdateEmail,
  isMailerConfigured,
  sendEmail as defaultSendEmail,
  SITE_URL,
} from './_mailer.mjs';

export const NOTIFY_COOLDOWN_HOURS = 24;

// Backstop under Resend's 100/day free tier. The per-band cooldown is the
// real throttle; this just keeps a bug from eating the whole quota.
export const DAILY_SEND_CAP = 90;

// One-click unsubscribe link. The token is a per-user random secret stored
// on notification_prefs — no login needed, and it can't be guessed. Served
// by unsubscribe.mjs at /api/unsubscribe.
export function unsubscribeUrlFor(token) {
  return `${SITE_URL}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

// Ensure the user has a notification_prefs row, creating it (with a fresh
// unsubscribe token) on first use. Existing users predate the table, so
// lazy creation here covers everyone — no backfill migration needed.
export async function ensureNotifyPrefs(sql, userId) {
  const rows = await sql`
    select user_id, email_enabled, unsubscribed_at, unsubscribe_token
    from notification_prefs
    where user_id = ${userId}
    limit 1
  `;
  if (rows.length) {
    if (!rows[0].unsubscribe_token) {
      const token = generateToken();
      const updated = await sql`
        update notification_prefs
        set unsubscribe_token = ${token}, updated_at = now()
        where user_id = ${userId}
        returning user_id, email_enabled, unsubscribed_at, unsubscribe_token
      `;
      return updated[0];
    }
    return rows[0];
  }
  const token = generateToken();
  const inserted = await sql`
    insert into notification_prefs (user_id, email_enabled, unsubscribe_token)
    values (${userId}, true, ${token})
    returning user_id, email_enabled, unsubscribed_at, unsubscribe_token
  `;
  return inserted[0];
}

// Everyone who touched the band except the actor. Union of:
//   - bands.added_by / bands.edited_by (direct attribution columns)
//   - contributions rows for this band (add_band / edit_band /
//     edit_band_members actions). contributions.band_id is TEXT (legacy
//     free-form), so compare against the string form of the uuid.
//   - band_follows rows (explicit follows)
// Distinct users with their email addresses. Preference filtering happens
// in notifyBandTouched, not here, so this stays a pure recipient query.
export async function getTouchedRecipients(sql, bandId, actorUserId) {
  const bandIdStr = String(bandId);
  const rows = await sql`
    select distinct u.id, u.email, u.name
    from users u
    where u.id <> ${actorUserId}
      and (
        u.id in (select added_by from bands where id = ${bandId} and added_by is not null)
        or u.id in (select edited_by from bands where id = ${bandId} and edited_by is not null)
        or u.id in (
          select user_id from contributions
          where band_id = ${bandIdStr}
            and action in ('add_band', 'edit_band', 'edit_band_members')
        )
        or u.id in (select user_id from band_follows where band_id = ${bandId})
      )
  `;
  return rows;
}

async function notifyOneRecipient(sql, bandId, bandName, recipient, mailer) {
  const prefs = await ensureNotifyPrefs(sql, recipient.id);
  if (!prefs.email_enabled || prefs.unsubscribed_at) {
    return { sent: false, reason: 'opted out' };
  }
  const cooled = await sql`
    select 1 from band_notification_log
    where band_id = ${bandId}
      and user_id = ${recipient.id}
      and sent_at > now() - (${NOTIFY_COOLDOWN_HOURS} * interval '1 hour')
    limit 1
  `;
  if (cooled.length) {
    return { sent: false, reason: 'cooldown' };
  }
  const email = buildBandUpdateEmail({
    bandName,
    unsubscribeUrl: unsubscribeUrlFor(prefs.unsubscribe_token),
  });
  const result = await mailer.sendEmail({ to: recipient.email, ...email });
  if (!result.ok) {
    console.warn('notify: send failed for user', recipient.id, result.error);
    return { sent: false, reason: 'send failed' };
  }
  await sql`
    insert into band_notification_log (band_id, user_id)
    values (${bandId}, ${recipient.id})
  `;
  return { sent: true };
}

export async function notifyBandTouched(
  sql,
  { bandId, bandName, actorUserId, mailer = { sendEmail: defaultSendEmail } }
) {
  try {
    if (!isMailerConfigured()) {
      return { ok: true, sent: 0, skipped: 'mailer not configured' };
    }
    const counted = await sql`
      select count(*)::int as n from band_notification_log
      where sent_at > now() - interval '24 hours'
    `;
    if (counted[0] && counted[0].n >= DAILY_SEND_CAP) {
      console.warn('notify: daily send cap reached, skipping');
      return { ok: true, sent: 0, skipped: 'daily cap' };
    }
    const recipients = await getTouchedRecipients(sql, bandId, actorUserId);
    // Parallel sends — each recipient is independent, and at hobby scale
    // the fan-out is a handful of emails. Individual failures are caught
    // per-recipient so one bad address can't sink the rest.
    const outcomes = await Promise.allSettled(
      recipients.map((r) =>
        notifyOneRecipient(sql, bandId, bandName, r, mailer).catch((err) => {
          console.warn('notify: recipient failed', r.id, err && err.message);
          return { sent: false, reason: 'error' };
        })
      )
    );
    const sent = outcomes.filter(
      (o) => o.status === 'fulfilled' && o.value && o.value.sent
    ).length;
    return { ok: true, sent };
  } catch (err) {
    console.warn('notifyBandTouched failed (non-fatal)', err && err.message);
    return { ok: false, sent: 0 };
  }
}
