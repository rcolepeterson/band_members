// Onboarding email — the thank-you from Aaron.
//
// Two sends share this module:
//   - blast: one-time, manual (admin trigger) — the founding users, 200 credits.
//   - drip: daily scheduled — anyone whose created_at is 48–72h old, 100 credits.
//
// Both grant bonus credits atomically with the send and log to
// onboarding_emails so nobody is ever emailed twice. Follows the
// _notify.mjs contracts: never throws, never blocks, honors
// notification_prefs (email_enabled, unsubscribed_at, email_onboarding),
// skips placeholder (IG OAuth) emails.

import {
  sendEmail as defaultSendEmail,
  isMailerConfigured,
  SITE_URL,
  MAIL_FROM_ADDRESS,
} from './_mailer.mjs';
import { ensureNotifyPrefs, unsubscribeUrlFor } from './_notify.mjs';
import { isPlaceholderEmail } from './_oauth.mjs';

// Founding users get the real reward: 200 = 20 Ask-the-tree lifelines
// (or two full streak-freezes at 100 each). The ongoing drip is 100.
export const BLAST_CREDITS = 200;
export const DRIP_CREDITS = 100;

// The address stays updates@ (verified Resend sender, deliverability);
// only the display name becomes Aaron's.
export const FROM_NAME = 'Aaron — Six Degrees of Rawk';
export const FROM_LINE = `${FROM_NAME} <${MAIL_FROM_ADDRESS}>`;

export const PLAY_URL = `${SITE_URL}/game/`;

function lifelines(credits) {
  return Math.floor(credits / 10);
}

export function buildOnboardingEmail({ handle, kind, unsubscribeUrl }) {
  const credits = kind === 'blast' ? BLAST_CREDITS : DRIP_CREDITS;
  const firstLine =
    kind === 'blast'
      ? "Thanks for signing up — you're one of the first people in, and that means something."
      : 'Thanks for signing up.';
  const subject = 'A thank-you from Aaron';
  const text =
    `${firstLine}\n\n` +
    `I dropped ${credits} bonus credits in your account. ` +
    `That's ${lifelines(credits)} Ask-the-tree lifelines in the Daily Chain — ` +
    `the daily matchup is the fastest way into the game.\n\n` +
    `Play it here: ${PLAY_URL}\n\n` +
    `Know a band we're missing? Add it — the tree grows from players like you: ${SITE_URL}/\n\n` +
    `Hit reply with anything: suggestions, bugs, bands I got wrong. I read everything.\n\n` +
    `— Aaron\n\n` +
    `You're receiving this because you signed up at Six Degrees of Rawk.\n` +
    `Unsubscribe: ${unsubscribeUrl}\n`;
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const html =
    `<div style="font-family: Georgia, serif; color: #e8e4da; background: #14120e; padding: 32px; max-width: 560px;">` +
    `<p style="font-size: 18px; line-height: 1.6;">${esc(firstLine)}</p>` +
    `<p style="font-size: 16px; line-height: 1.6;">I dropped <strong>${credits} bonus credits</strong> in your account. ` +
    `That's ${lifelines(credits)} Ask-the-tree lifelines in the Daily Chain — ` +
    `the daily matchup is the fastest way into the game.</p>` +
    `<p><a href="${PLAY_URL}" style="color: #c9a96a;">Play the Daily Chain</a></p>` +
    `<p style="font-size: 16px; line-height: 1.6;">Know a band we're missing? ` +
    `<a href="${SITE_URL}/" style="color: #c9a96a;">Add it</a> — the tree grows from players like you.</p>` +
    `<p style="font-size: 16px; line-height: 1.6;">Hit reply with anything: suggestions, bugs, bands I got wrong. I read everything.</p>` +
    `<p style="font-size: 16px; line-height: 1.6;">— Aaron</p>` +
    `<hr style="border: none; border-top: 1px solid #3a352c; margin: 24px 0;" />` +
    `<p style="font-size: 12px; color: #8a8478;">You're receiving this because you signed up at Six Degrees of Rawk. ` +
    `<a href="${esc(unsubscribeUrl)}" style="color: #8a8478;">Unsubscribe</a> with one click — no login needed.</p>` +
    `</div>`;
  return { subject, html, text, credits };
}

// Recipient selection. The drip window is 48–72h after signup — not instant
// (day-2 "how's it going" beats a skimmed instant welcome). Placeholder
// emails (IG OAuth) are filtered in JS: isPlaceholderEmail lives in the
// oauth module, not SQL.
export async function selectRecipients(sql, kind) {
  const rows =
    kind === 'drip'
      ? await sql`
          select u.id, u.email, u.handle, u.name, u.created_at
          from users u
          left join onboarding_emails o on o.user_id = u.id
          where o.user_id is null
            and u.created_at > now() - interval '72 hours'
            and u.created_at <= now() - interval '48 hours'
        `
      : await sql`
          select u.id, u.email, u.handle, u.name, u.created_at
          from users u
          left join onboarding_emails o on o.user_id = u.id
          where o.user_id is null
        `;
  return rows.filter((r) => !isPlaceholderEmail(r.email));
}

// One user: prefs check → send → grant credits → log. Never throws: a
// mail failure for one user must not abort the batch or break the caller.
export async function sendOnboardingEmail(sql, user, kind, deps = {}) {
  const send = deps.sendEmail || defaultSendEmail;
  try {
    const prefs = await ensureNotifyPrefs(sql, user.id);
    if (!prefs.email_enabled || prefs.unsubscribed_at) return { ok: false, skipped: 'unsubscribed' };
    if (prefs.email_onboarding === false) return { ok: false, skipped: 'opted-out' };
    const { subject, html, text, credits } = buildOnboardingEmail({
      handle: user.handle,
      kind,
      unsubscribeUrl: unsubscribeUrlFor(prefs.unsubscribe_token),
    });
    const sent = await send({ to: user.email, subject, html, text, from: FROM_LINE });
    if (!sent.ok) return { ok: false, error: sent.error };
    await sql`update users set credits = credits + ${credits} where id = ${user.id}`;
    await sql`
      insert into onboarding_emails (user_id, kind, credits_granted)
      values (${user.id}, ${kind}, ${credits})
      on conflict (user_id) do nothing
    `;
    return { ok: true, credits };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

export async function runOnboarding(sql, kind, deps = {}) {
  if (!isMailerConfigured() && !deps.sendEmail) {
    return { ok: false, kind, error: 'mailer not configured', sent: 0 };
  }
  const recipients = await selectRecipients(sql, kind);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const user of recipients) {
    const r = await sendOnboardingEmail(sql, user, kind, deps);
    if (r.ok) sent += 1;
    else if (r.skipped) skipped += 1;
    else failed += 1;
  }
  return { ok: true, kind, considered: recipients.length, sent, skipped, failed };
}
