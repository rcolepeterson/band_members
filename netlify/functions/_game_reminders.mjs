// One reminder pipe for every 6* game (Cole, 2026-10-11 pattern, extended).
//
// Daily Chain keeps its own system (_daily_reminder.mjs); Rawkle and the
// card game share this one. Aaron's rule is that everything reminds the
// same, so a game here is a row in GAMES and the send, signup, confirm
// and unsubscribe paths are shared — a per-game copy would drift.
//
// Same contract as Daily's, minus the parts a game without accounts
// cannot have:
//   - Opt-in only, email-only: Rawkle and Cards have no accounts —
//     progress lives in localStorage — so there is no notification_prefs
//     row to flip. The list is just confirmed emails.
//   - Double opt-in: nothing is sent until the confirmation link is
//     clicked, so nobody can sign up someone else's address.
//   - One email per address per game per day: game_reminder_log has a row
//     per (email, game, date), claimed before the send, so a rerun or a
//     double trigger can't send twice.
//   - One-click unsubscribe per game: the footer link stops that game
//     only (unsubscribe.mjs, ?list=<game>).
//   - GAME_REMINDER_SEND_CAP keeps a bug from burning the Resend quota,
//     which is shared with Daily's reminders and the band-update emails
//     (100/day free tier). The caps are per-run safety valves; when the
//     lists grow past the tier, upgrade Resend before raising them.
//   - No skip-if-played: the server cannot know who played, because
//     Rawkle and Cards keep progress on the device. The emails never name
//     a hidden answer, so they are nudges, not spoilers. Rawkle's email
//     carries only the puzzle number (epoch math, no band lookup); the
//     card game has no daily answer at all, so its email carries none.

import { randomBytes } from 'node:crypto';

import { sendEmail as defaultSendEmail, isMailerConfigured, SITE_URL } from './_mailer.mjs';
import { unsubscribeUrlFor } from './_notify.mjs';
import { isPlaceholderEmail } from './_oauth.mjs';
import { pacificDate } from './_daily.mjs';

export const PLAY_URLS = {
  rawkle: `${SITE_URL}/rawkle`,
  cards: `${SITE_URL}/cards`,
};

// Rawkle #1 is 2026-10-23 (the page's LAUNCH_NUM); the number counts on
// from there exactly as the game does, with no band data involved.
const RAWKLE_EPOCH_MS = Date.UTC(2026, 9, 23);
export function rawklePuzzleNumber(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor((Date.UTC(y, m - 1, d) - RAWKLE_EPOCH_MS) / 86400000) + 1;
}

export const GAMES = {
  rawkle: {
    label: 'Rawkle',
    playUrl: PLAY_URLS.rawkle,
    subject: "Today's Rawkle is live",
    line: (num) => `Rawkle #${num} is up. One famous band, six tries.`,
    confirmSubject: 'Confirm your daily Rawkle reminder',
    confirmLine: 'One email each morning when the new Rawkle is live.',
    confirmHeading: 'You’re set.',
    confirmBody: (playUrl) => `One email each morning when the new Rawkle is live. <a href="${playUrl}">Play today’s band</a>`,
    unsubHeading: 'No more Rawkle reminders.',
    unsubBody: (playUrl) => `You won’t get the Rawkle reminder again, and we’ve deleted your email. Today’s band is always at <a href="${playUrl}">sixdegreesofrock.com/rawkle</a>.`,
  },
  cards: {
    label: 'card game',
    playUrl: PLAY_URLS.cards,
    subject: 'The cards are on the table',
    line: () => 'The Six Degrees card game is ready when you are. Deal a hand.',
    confirmSubject: 'Confirm your daily card game reminder',
    confirmLine: 'One email each morning to deal a hand.',
    confirmHeading: 'You’re set.',
    confirmBody: (playUrl) => `One email each morning to deal a hand. <a href="${playUrl}">Play the card game</a>`,
    unsubHeading: 'No more card game reminders.',
    unsubBody: (playUrl) => `You won’t get the card game reminder again, and we’ve deleted your email. The game is always at <a href="${playUrl}">sixdegreesofrock.com/cards</a>.`,
  },
};

// Per-run safety valve; see the header note on the shared Resend tier.
export const GAME_REMINDER_SEND_CAP = 20;

// Don't resend the confirmation to the same address more than this often.
export const CONFIRM_RESEND_MS = 60 * 60 * 1000;

const newToken = () => randomBytes(32).toString('base64url');

// Signup attribution ("how did they get here?"): the client sends the
// landing touch with the signup (see scripts/signup-attribution.mjs).
// Clamped, never trusted raw: over-long or non-string values become ''.
function cleanSource(value) {
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}
export function normalizeSignupSource(source) {
  const s = source && typeof source === 'object' ? source : {};
  return { source: cleanSource(s.source), medium: cleanSource(s.medium), campaign: cleanSource(s.campaign) };
}

// GA4 on the bare confirm page: the page has no gtag of its own, so this
// loads it and fires reminder_signup_confirmed. Params are JSON-encoded,
// never interpolated raw. Callers pass it only on a FRESH confirmation, so
// a refresh of the confirm page never double-counts.
export function reminderConfirmedGaScript(game, source) {
  // Escape < so a hostile source value can never break out of this
  // <script> block via a literal </script> sequence.
  const params = JSON.stringify({
    game,
    signup_source: (source && source.source) || '',
    signup_medium: (source && source.medium) || '',
    signup_campaign: (source && source.campaign) || '',
  }).replace(/</g, '\\u003c');
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=G-E2SNSPFHGB"></script>` +
    `<script>window.dataLayer = window.dataLayer || [];` +
    `function gtag(){dataLayer.push(arguments);}` +
    `gtag('js', new Date());` +
    `gtag('config', 'G-E2SNSPFHGB');` +
    `gtag('event', 'reminder_signup_confirmed', ${params});</script>`;
}

// The tables, created on first use. Once per warm instance.
let schemaReady = null;
export function ensureGameReminderSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        create table if not exists game_reminders (
          email             text not null,
          game              text not null,
          confirm_token     text not null unique,
          unsubscribe_token text not null unique,
          confirmed_at      timestamptz,
          confirm_sent_at   timestamptz,
          created_at        timestamptz not null default now(),
          primary key (email, game)
        )
      `;
      await sql`alter table game_reminders add column if not exists signup_source text`;
      await sql`alter table game_reminders add column if not exists signup_medium text`;
      await sql`alter table game_reminders add column if not exists signup_campaign text`;
      await sql`
        create table if not exists game_reminder_log (
          email         text not null,
          game          text not null,
          reminder_date text not null,
          sent_at       timestamptz not null default now(),
          primary key (email, game, reminder_date)
        )
      `;
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
export function __resetGameReminderSchemaForTests() { schemaReady = null; }

// A real-looking address: a dot in the domain, and not one of our own
// placeholder addresses (guest_…@guest.local, Instagram's).
export function validateGameReminderEmail(email) {
  const domain = (email.split('@')[1] || '');
  if (!email || !email.includes('@') || !domain.includes('.') || domain.endsWith('.local')) {
    return 'enter a real email address';
  }
  if (isPlaceholderEmail(email)) return 'enter a real email address';
  return null;
}

// The unsubscribe link in a reminder turns off that game only.
export function gameReminderUnsubscribeUrl(game, token) {
  return `${unsubscribeUrlFor(token)}&list=${game}`;
}

export function gameReminderConfirmUrl(token) {
  return `${SITE_URL}/api/game-reminder-signup?confirm=${encodeURIComponent(token)}`;
}

function emailShell(line1, playUrl, playLabel, unsubscribeUrl) {
  const text =
    `${line1}\n` +
    `Play: ${playUrl}\n\n` +
    `You asked for a daily reminder. Stop them: ${unsubscribeUrl}\n`;
  const html =
    `<div style="font-family: Georgia, serif; color: #e8e4da; background: #14120e; padding: 32px; max-width: 560px;">` +
    `<p style="font-size: 18px; line-height: 1.6; margin: 0 0 12px;">${line1}</p>` +
    `<p style="margin: 0;"><a href="${playUrl}" style="color: #c9a96a;">${playLabel}</a></p>` +
    `<hr style="border: none; border-top: 1px solid #3a352c; margin: 24px 0;" />` +
    `<p style="font-size: 12px; color: #8a8478;">You asked for a daily reminder. ` +
    `<a href="${unsubscribeUrl.replace(/&/g, '&amp;')}" style="color: #8a8478;">Stop these emails</a> with one click.</p>` +
    `</div>`;
  return { html, text };
}

export function buildGameReminderEmail(game, { date, unsubscribeUrl }) {
  const g = GAMES[game];
  const num = game === 'rawkle' ? rawklePuzzleNumber(date) : null;
  const line1 = g.line(num);
  const { html, text } = emailShell(line1, g.playUrl, game === 'rawkle' ? 'Play today’s band' : 'Play the card game', unsubscribeUrl);
  return { subject: g.subject, html, text };
}

export function buildGameReminderConfirmEmail(game, { confirmUrl }) {
  const g = GAMES[game];
  const text =
    `${g.confirmLine}\n` +
    `${confirmUrl}\n\n` +
    `Didn't ask for this? Ignore it and you won't hear from us.\n`;
  const html =
    `<div style="font-family: Georgia, serif; color: #e8e4da; background: #14120e; padding: 32px; max-width: 560px;">` +
    `<p style="font-size: 18px; line-height: 1.6; margin: 0 0 12px;">${g.confirmLine}</p>` +
    `<p style="margin: 0;"><a href="${confirmUrl}" style="color: #c9a96a;">Yes, remind me</a></p>` +
    `<hr style="border: none; border-top: 1px solid #3a352c; margin: 24px 0;" />` +
    `<p style="font-size: 12px; color: #8a8478;">Didn’t ask for this? Ignore it and you won’t hear from us.</p>` +
    `</div>`;
  return { subject: g.confirmSubject, html, text };
}

// Confirmed, not reminded today for this game. One email per address even
// if the same address somehow holds two rows.
export async function selectGameReminderRecipients(sql, game, date) {
  const rows = await sql`
    select email, unsubscribe_token
    from game_reminders
    where game = ${game}
      and confirmed_at is not null
      and not exists (select 1 from game_reminder_log l where l.email = game_reminders.email and l.game = ${game} and l.reminder_date = ${date})
    order by created_at
  `;
  const seen = new Set();
  return (rows || []).filter((r) => {
    if (!r.email || isPlaceholderEmail(r.email)) return false;
    const key = String(r.email).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runGameReminders(sql, game, { date = pacificDate(), dryRun = false, sendEmail } = {}) {
  const send = sendEmail || defaultSendEmail;
  if (!sendEmail && !dryRun && !isMailerConfigured()) {
    return { ok: false, game, date, error: 'mailer not configured', sent: 0 };
  }
  await ensureGameReminderSchema(sql);
  const recipients = await selectGameReminderRecipients(sql, game, date);
  if (dryRun) return { ok: true, game, date, dryRun: true, considered: recipients.length, sent: 0 };

  let sent = 0;
  let failed = 0;
  let capped = 0;
  for (const user of recipients) {
    if (sent >= GAME_REMINDER_SEND_CAP) { capped += 1; continue; }
    try {
      // Claim the day first: if this row already exists, someone else sent it.
      const claimed = await sql`
        insert into game_reminder_log (email, game, reminder_date) values (${user.email}, ${game}, ${date})
        on conflict do nothing
        returning email
      `;
      if (!claimed.length) continue;
      const { subject, html, text } = buildGameReminderEmail(game, {
        date,
        unsubscribeUrl: gameReminderUnsubscribeUrl(game, user.unsubscribe_token),
      });
      const result = await send({ to: user.email, subject, html, text });
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
        // Not sent, so not counted against today.
        await sql`delete from game_reminder_log where email = ${user.email} and game = ${game} and reminder_date = ${date}`;
      }
    } catch (err) {
      failed += 1;
      console.error('[game-reminder] one send failed', err && err.message);
    }
  }
  return { ok: true, game, date, considered: recipients.length, sent, failed, capped };
}

// A signup asks for confirmation first, so nobody can sign up someone
// else's address. A new or changed address starts unconfirmed with a
// fresh link.
export async function signUpForGameReminder(sql, { email, game, source, send = defaultSendEmail, now = Date.now() }) {
  const src = normalizeSignupSource(source);
  const existing = (await sql`select * from game_reminders where email = ${email} and game = ${game} limit 1`)[0];
  if (existing && existing.confirmed_at) return { status: 'already_on' };
  if (
    existing && existing.confirm_sent_at &&
    now - new Date(existing.confirm_sent_at).getTime() < CONFIRM_RESEND_MS
  ) {
    return { status: 'check_email' };
  }

  const confirmToken = newToken();
  await sql`
    insert into game_reminders (email, game, confirm_token, unsubscribe_token, confirm_sent_at, signup_source, signup_medium, signup_campaign)
    values (${email}, ${game}, ${confirmToken}, ${newToken()}, now(), ${src.source}, ${src.medium}, ${src.campaign})
    on conflict (email, game) do update set
      confirm_token = excluded.confirm_token,
      unsubscribe_token = excluded.unsubscribe_token,
      signup_source = coalesce(nullif(excluded.signup_source, ''), game_reminders.signup_source),
      signup_medium = coalesce(nullif(excluded.signup_medium, ''), game_reminders.signup_medium),
      signup_campaign = coalesce(nullif(excluded.signup_campaign, ''), game_reminders.signup_campaign),
      confirmed_at = null,
      confirm_sent_at = now()
  `;
  const { subject, html, text } = buildGameReminderConfirmEmail(game, { confirmUrl: gameReminderConfirmUrl(confirmToken) });
  const sent = await send({ to: email, subject, html, text });
  if (!sent || !sent.ok) return { error: 'could not send the email' };
  return { status: 'check_email' };
}

export async function confirmGameReminder(sql, token) {
  if (!token) return null;
  const before = (await sql`select confirmed_at from game_reminders where confirm_token = ${token} limit 1`)[0];
  const rows = await sql`
    update game_reminders set confirmed_at = coalesce(confirmed_at, now())
    where confirm_token = ${token}
    returning email, game, signup_source, signup_medium, signup_campaign
  `;
  const row = (rows && rows[0]) || null;
  if (!row) return null;
  return { ...row, fresh: !before || !before.confirmed_at };
}
