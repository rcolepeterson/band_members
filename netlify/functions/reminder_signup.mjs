// Guest sign-up for the daily 6° reminder (Cole, 2026-10-15).
//
// POST /api/reminder-signup  { email, guest_session_id }
//   A guest (after a puzzle, or on /remind/ before ever playing) asks for
//   the reminder with only an email. We
//   save it on their guest row and send a confirmation link; nothing else
//   is sent until they click it (double opt-in), so nobody can sign up
//   someone else's address.
// GET /api/reminder-signup?confirm=<token>
//   The link in that email. Turns the reminder on and says so.
//
// Signed-in players keep using "Remind me daily" (notification_prefs); this
// is only for guests. The send itself, skip-if-played, one-a-day and
// unsubscribe all live in _daily_reminder.mjs and unsubscribe.mjs.

import { randomBytes } from 'node:crypto';
import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  normalizeEmail,
  isPlausibleEmail,
  generateToken,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { sendEmail, isMailerConfigured, SITE_URL } from './_mailer.mjs';
import { isPlaceholderEmail } from './_oauth.mjs';
import { ensureReminderSchema, buildReminderConfirmEmail } from './_daily_reminder.mjs';

// Don't resend the confirmation to the same address more than this often.
export const CONFIRM_RESEND_MS = 60 * 60 * 1000;

const newToken = () => randomBytes(32).toString('base64url');

export function confirmUrlFor(token) {
  return `${SITE_URL}/api/reminder-signup?confirm=${encodeURIComponent(token)}`;
}

function page({ heading, body }) {
  // Same quiet page as unsubscribe.mjs.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>Daily reminder — Six Degrees of Rock</title>` +
      `<style>body{background:#14120e;color:#e8e4da;font-family:Georgia,serif;` +
      `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}` +
      `.card{max-width:480px;text-align:center;line-height:1.7}` +
      `h1{font-weight:normal;font-size:24px;margin:0 0 12px}` +
      `p{color:#a49d8d;font-size:15px}` +
      `a{color:#c9a96a}</style></head><body><div class="card">` +
      `<h1>${heading}</h1><p>${body}</p>` +
      `</div></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

async function confirm(sql, token) {
  if (!token) {
    return page({ heading: 'That link doesn’t look right.', body: 'Try the link in the email again.' });
  }
  const rows = await sql`
    update guest_reminders set confirmed_at = coalesce(confirmed_at, now())
    where confirm_token = ${token}
    returning user_id
  `;
  if (!rows.length) {
    return page({
      heading: 'That link doesn’t look right.',
      body: 'It may be old. Ask for the reminder again after your next puzzle at <a href="https://sixdegreesofrock.com/game/">sixdegreesofrock.com/game</a>.',
    });
  }
  return page({
    heading: 'You’re set.',
    body: 'One email each morning when the new 6° puzzle is live, skipped on days you’ve already played. <a href="https://sixdegreesofrock.com/game/">Play today’s puzzle</a>',
  });
}

export async function signUp(sql, { email, guestSessionId, send = sendEmail, now = Date.now() }) {
  const guests = await sql`
    select id from users where guest_session_id = ${guestSessionId} and is_guest = true limit 1
  `;
  let guest = guests && guests[0];
  if (!guest) {
    // Signed up from /remind/ before ever playing (2026-10-15): make the
    // guest row the game would have made (same as game_daily_play.mjs), so
    // when they play on this device, "already played today" still applies.
    const made = await sql`
      insert into users (is_guest, guest_session_id, credits, token, email, name)
      values (true, ${guestSessionId}, 50, ${generateToken()}, ${`guest_${guestSessionId}@guest.local`}, 'Guest')
      on conflict do nothing
      returning id
    `;
    guest = (made && made[0]) || (await sql`
      select id from users where guest_session_id = ${guestSessionId} and is_guest = true limit 1
    `)[0];
  }
  if (!guest) return { error: 'could not save that' };

  const existing = (await sql`select * from guest_reminders where user_id = ${guest.id} limit 1`)[0];
  if (existing && existing.email === email && existing.confirmed_at) return { status: 'already_on' };
  if (
    existing && existing.email === email && existing.confirm_sent_at &&
    now - new Date(existing.confirm_sent_at).getTime() < CONFIRM_RESEND_MS
  ) {
    return { status: 'check_email' };
  }

  // A new or changed address starts unconfirmed with a fresh link.
  const confirmToken = newToken();
  await sql`
    insert into guest_reminders (user_id, email, confirm_token, unsubscribe_token, confirm_sent_at)
    values (${guest.id}, ${email}, ${confirmToken}, ${newToken()}, now())
    on conflict (user_id) do update set
      email = excluded.email,
      confirm_token = excluded.confirm_token,
      confirmed_at = null,
      confirm_sent_at = now()
  `;
  const { subject, html, text } = buildReminderConfirmEmail({ confirmUrl: confirmUrlFor(confirmToken) });
  const sent = await send({ to: email, subject, html, text });
  if (!sent || !sent.ok) return { error: 'could not send the email' };
  return { status: 'check_email' };
}

export default async (req) => {
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();

  if (req.method === 'GET') {
    try {
      await ensureReminderSchema(sql);
      return await confirm(sql, (new URL(req.url).searchParams.get('confirm') || '').trim());
    } catch (err) {
      console.error('reminder confirm failed', err && err.message);
      return page({ heading: 'Give us a moment.', body: 'Something went wrong on our end. Try the link again in a minute.' });
    }
  }
  if (req.method !== 'POST') return methodNotAllowed();

  const budget = await consume({ sql, bucket: `reminder-signup:ip:${clientIp(req)}`, limit: 5, windowSeconds: 3600 });
  if (!budget.allowed) return tooManyRequests('Too many tries. Try again later.', budget.retryAfterSeconds);

  let body;
  try { body = await req.json(); } catch { return badRequest('expected a JSON body'); }
  const email = normalizeEmail(body && body.email);
  const guestSessionId = body && body.guest_session_id;
  // A real-looking address: a dot in the domain, and not one of our own
  // placeholder addresses (guest_…@guest.local, Instagram's).
  const domain = email.split('@')[1] || '';
  if (!isPlausibleEmail(email) || isPlaceholderEmail(email) || !domain.includes('.') || domain.endsWith('.local')) {
    return badRequest('enter a real email address');
  }
  if (typeof guestSessionId !== 'string' || guestSessionId.length < 8 || guestSessionId.length > 64) {
    return badRequest('missing guest session');
  }
  if (!isMailerConfigured()) return serverError('email is not set up');

  try {
    await ensureReminderSchema(sql);
    const result = await signUp(sql, { email, guestSessionId });
    if (result.error) return badRequest(result.error);
    return ok({ status: result.status });
  } catch (err) {
    console.error('reminder signup failed', err && err.message);
    return serverError('could not save that');
  }
};

export const config = { path: '/api/reminder-signup' };
