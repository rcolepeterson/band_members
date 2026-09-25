// GET /api/unsubscribe?token=... — one-click unsubscribe.
//
// The footer of every notification email carries a per-user signed link
// (see _notify.mjs unsubscribeUrlFor). Clicking it lands here: no login,
// no confirmation step, no dark patterns — the token IS the authorization.
// We flip email_enabled off, stamp unsubscribed_at, and render a quiet
// confirmation page in the brand register.
//
// Why a GET that mutates: one-click unsubscribe links must work as plain
// links (that's the entire point — and what Gmail's List-Unsubscribe
// expects). The token is a 256-bit random secret, so CSRF-style abuse
// isn't a meaningful threat: anyone who has the link was given it by us
// in an email to that user.
//
// Bad/missing token: a plain 404 page, no user enumeration (we don't say
// whether a token ever existed).

import { getSql, isDbConfigured } from './_db.mjs';

function page({ title, heading, body }) {
  // Minimal branded page — dark, quiet, Georgia serif like the emails.
  // No tracking, no scripts, no nav. One job: confirm the outcome.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>${title}</title>` +
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

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  let token = '';
  try {
    token = (new URL(req.url).searchParams.get('token') || '').trim();
  } catch {
    token = '';
  }

  if (!token) {
    return page({
      title: 'Unsubscribe — Six Degrees of Rawk',
      heading: 'That link doesn\u2019t look right.',
      body: 'The unsubscribe link is missing its token. If you got here from an email footer, try the link again — or turn emails off from your account card on <a href="https://sixdegreesofrock.com">sixdegreesofrock.com</a>.',
    });
  }

  if (!isDbConfigured()) {
    return page({
      title: 'Unsubscribe — Six Degrees of Rawk',
      heading: 'Give us a moment.',
      body: 'We couldn\u2019t reach the database just now. Please try the link again in a minute.',
    });
  }

  const sql = getSql();
  try {
    const rows = await sql`
      select user_id, email_enabled from notification_prefs
      where unsubscribe_token = ${token}
      limit 1
    `;
    if (!rows.length) {
      return page({
        title: 'Unsubscribe — Six Degrees of Rawk',
        heading: 'That link doesn\u2019t look right.',
        body: 'We couldn\u2019t find that unsubscribe link. It may have already been used — you can also turn emails off from your account card on <a href="https://sixdegreesofrock.com">sixdegreesofrock.com</a>.',
      });
    }
    await sql`
      update notification_prefs
      set email_enabled = false, unsubscribed_at = now(), updated_at = now()
      where unsubscribe_token = ${token}
    `;
    return page({
      title: 'Unsubscribed — Six Degrees of Rawk',
      heading: 'You\u2019re unsubscribed.',
      body: 'No more band update emails. If you change your mind, flip the switch back on in your account card on <a href="https://sixdegreesofrock.com">sixdegreesofrock.com</a>.',
    });
  } catch (err) {
    console.error('unsubscribe failed', err);
    return page({
      title: 'Unsubscribe — Six Degrees of Rawk',
      heading: 'Give us a moment.',
      body: 'Something went wrong on our end. Please try the link again in a minute.',
    });
  }
};

export const config = { path: '/api/unsubscribe' };
