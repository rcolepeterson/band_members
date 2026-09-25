// Resend mailer — the single module that talks to Resend's email API.
//
// Why a shared module: every notification path (band-update emails today,
// digests or receipts tomorrow) wants the same from-line, the same auth
// header, and the same failure contract. Centralizing keeps the "who sends
// mail" story in one place and keeps individual endpoints from each
// hand-rolling fetch calls against api.resend.com.
//
// Failure contract: sendEmail() NEVER throws. Network failures, missing
// config, and Resend API errors all come back as { ok: false, error }.
// Rationale: sending mail is always a best-effort side effect of some
// primary action (a band write, a webhook). No caller should have to
// try/catch around us, and no band edit should ever 500 because the mail
// provider had a bad minute. Callers that care about the outcome inspect
// the returned object; callers that don't can ignore it.
//
// Testability: the fetch implementation is injectable via
// __setFetchForTests() so tests can assert on the request shape without
// touching the network. Production code never calls it.

export const RESEND_API_URL = 'https://api.resend.com/emails';

// Verified sender. The domain sixdegreesofrock.com is verified in Resend
// (DKIM + SPF + DMARC records live in Network Solutions DNS as of
// 2026-09-24). Aaron's personal Network Solutions mailbox is deliberately
// NOT used here — automated mail never goes through it (spam risk).
export const MAIL_FROM = 'Six Degrees of Rawk <updates@sixdegreesofrock.com>';

export const SITE_URL = 'https://sixdegreesofrock.com';

// Indirect through a module-level binding so tests can swap it.
let fetchImpl = (...args) => globalThis.fetch(...args);
export function __setFetchForTests(fn) {
  fetchImpl = fn;
}
export function __resetFetchForTests() {
  fetchImpl = (...args) => globalThis.fetch(...args);
}

export function isMailerConfigured() {
  return (
    typeof process.env.RESEND_API_KEY === 'string' &&
    process.env.RESEND_API_KEY.length > 0
  );
}

// Band-update email content. Teaser style per the product decision: the
// email says the band "was recently updated" and nothing more — no diff,
// no field names. Anticipation drives the click back to the site, and it
// keeps the email from leaking edit details to anyone who shouldn't see
// them. Sentence case, quiet register, no hype.
//
// unsubscribeUrl is the per-user signed one-click link
// (see _notify.mjs unsubscribeUrlFor + unsubscribe.mjs). Every email
// carries it in the footer — no login required to opt out.
export function buildBandUpdateEmail({ bandName, unsubscribeUrl }) {
  const safeName = String(bandName || 'A band').slice(0, 200);
  const subject = `${safeName} was recently updated`;
  const text =
    `${safeName} was recently updated.\n\n` +
    `See what's new: ${SITE_URL}\n\n` +
    `You're receiving this because you added, edited, or follow this band on Six Degrees of Rawk.\n` +
    `Unsubscribe: ${unsubscribeUrl}\n`;
  const html =
    `<div style="font-family: Georgia, serif; color: #e8e4da; background: #14120e; padding: 32px; max-width: 560px;">` +
    `<p style="font-size: 18px; line-height: 1.6;">${escapeHtml(safeName)} was recently updated.</p>` +
    `<p><a href="${SITE_URL}" style="color: #c9a96a;">See what's new on Six Degrees of Rawk</a></p>` +
    `<hr style="border: none; border-top: 1px solid #3a352c; margin: 24px 0;" />` +
    `<p style="font-size: 12px; color: #8a8478;">You're receiving this because you added, edited, or follow this band. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color: #8a8478;">Unsubscribe</a> with one click — no login needed.</p>` +
    `</div>`;
  return { subject, html, text };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Send one email via Resend. `to` is a single address string.
// Never throws — see the module header for the failure contract.
export async function sendEmail({ to, subject, html, text }) {
  if (!isMailerConfigured()) {
    return { ok: false, error: 'mailer not configured (RESEND_API_KEY missing)' };
  }
  if (typeof to !== 'string' || !to.includes('@')) {
    return { ok: false, error: 'invalid recipient address' };
  }
  try {
    const res = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        detail = '';
      }
      return { ok: false, error: `resend ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    let id = null;
    try {
      const data = await res.json();
      id = data && typeof data.id === 'string' ? data.id : null;
    } catch {
      id = null;
    }
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : 'network error' };
  }
}
