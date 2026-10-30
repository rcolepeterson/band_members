// Sign-up for a 6* game's daily reminder (Rawkle, card game).
//
// POST /api/game-reminder-signup  { email, game }
//   Asks for the reminder with only an email. We save it and send a
//   confirmation link; nothing else is sent until they click it (double
//   opt-in), so nobody can sign up someone else's address.
// GET /api/game-reminder-signup?confirm=<token>
//   The link in that email. Turns the reminder on and says so.
//
// The send itself, one-a-day and unsubscribe all live in
// _game_reminders.mjs and unsubscribe.mjs. Daily Chain keeps its own
// system (_daily_reminder.mjs); this is the shared pipe for the games
// without accounts.

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
} from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';
import { sendEmail, isMailerConfigured } from './_mailer.mjs';
import {
  GAMES,
  ensureGameReminderSchema,
  validateGameReminderEmail,
  signUpForGameReminder,
  confirmGameReminder,
  reminderConfirmedGaScript,
} from './_game_reminders.mjs';

function page({ title, heading, body, gaScript }) {
  // Same quiet page as unsubscribe.mjs.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>${title}</title>` +
      `<style>body{background:#14120e;color:#e8e4da;font-family:Georgia,serif;` +
      `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}` +
      `.card{max-width:480px;text-align:center;line-height:1.7}` +
      `h1{font-weight:normal;font-size:24px;margin:0 0 12px}` +
      `p{color:#a49d8d;font-size:15px}` +
      `a{color:#c9a96a}</style>${gaScript || ''}</head><body><div class="card">` +
      `<h1>${heading}</h1><p>${body}</p>` +
      `</div></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

async function confirm(sql, token) {
  if (!token) {
    return page({ title: 'Reminder — Six Degrees of Rock', heading: 'That link doesn’t look right.', body: 'Try the link in the email again.' });
  }
  const row = await confirmGameReminder(sql, token);
  if (!row) {
    return page({
      title: 'Reminder — Six Degrees of Rock',
      heading: 'That link doesn’t look right.',
      body: 'It may be old. Ask for the reminder again after your next game.',
    });
  }
  const g = GAMES[row.game] || GAMES.rawkle;
  return page({
    title: 'Reminder — Six Degrees of Rock',
    heading: g.confirmHeading,
    body: g.confirmBody(g.playUrl),
    gaScript: row.fresh ? reminderConfirmedGaScript(row.game, row) : '',
  });
}

export default async (req) => {
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();

  if (req.method === 'GET') {
    try {
      await ensureGameReminderSchema(sql);
      return await confirm(sql, (new URL(req.url).searchParams.get('confirm') || '').trim());
    } catch (err) {
      console.error('game reminder confirm failed', err && err.message);
      return page({ title: 'Reminder — Six Degrees of Rock', heading: 'Give us a moment.', body: 'Something went wrong on our end. Try the link again in a minute.' });
    }
  }
  if (req.method !== 'POST') return methodNotAllowed();

  const budget = await consume({ sql, bucket: `game-reminder-signup:ip:${clientIp(req)}`, limit: 5, windowSeconds: 3600 });
  if (!budget.allowed) return tooManyRequests('Too many tries. Try again later.', budget.retryAfterSeconds);

  let body;
  try { body = await req.json(); } catch { return badRequest('expected a JSON body'); }
  const email = normalizeEmail(body && body.email);
  const game = body && body.game;
  const source = body && body.source;
  if (!GAMES[game]) return badRequest('unknown game');
  const emailError = validateGameReminderEmail(email);
  if (!isPlausibleEmail(email) || emailError) {
    return badRequest(emailError || 'enter a real email address');
  }
  if (!isMailerConfigured()) return serverError('email is not set up');

  try {
    await ensureGameReminderSchema(sql);
    const result = await signUpForGameReminder(sql, { email, game, source, send: sendEmail });
    if (result.error) return badRequest(result.error);
    return ok({ status: result.status });
  } catch (err) {
    console.error('game reminder signup failed', err && err.message);
    return serverError('could not save that');
  }
};

export const config = { path: '/api/game-reminder-signup' };
