// POST /api/resend-webhook — Resend event webhook.
//
// Why: sender reputation. If a recipient marks our mail as spam
// (email.complained) or their address hard-bounces (email.bounced),
// Resend tells us here and we flip their notification preference off.
// Continuing to mail complainers is how a domain gets blocklisted —
// this is the automatic circuit breaker.
//
// Verification: Resend signs webhooks in the Svix format. We verify the
// HMAC-SHA256 signature with Web Crypto before trusting anything:
//   signature = base64(hmac_sha256(secret, "<svix-id>.<svix-timestamp>.<raw-body>"))
// The secret is RESEND_WEBHOOK_SECRET (from the Resend dashboard's
// Webhooks page, after creating the webhook). If the env var isn't set,
// we accept nothing and reply 200 with a skip note — the endpoint is
// inert until Aaron wires it up, rather than erroring.
//
// Timestamp tolerance: 5 minutes, per Svix's recommendation, to blunt
// replay attacks.

import { getSql, isDbConfigured, json } from './_db.mjs';

const ok = (body) => json(200, { ok: true, ...body });

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Constant-time-ish comparison to avoid leaking the expected signature
// through timing. Overkill at this scale, but it's three lines.
function signaturesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySvixSignature({ secret, id, timestamp, signatureHeader, rawBody }) {
  if (!id || !timestamp || !signatureHeader) return false;
  // Replay guard: 5 minutes.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false;

  // RESEND_WEBHOOK_SECRET looks like "whsec_<base64>"; the HMAC key is
  // the base64-decoded part after the prefix.
  const keyB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes;
  try {
    keyBytes = base64ToBytes(keyB64);
  } catch {
    return false;
  }
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const expected = bytesToBase64(new Uint8Array(mac));

  // Header looks like "v1,<sig>" and may carry multiple space-separated
  // signatures (key rotation) — accept if ANY v1 signature matches.
  const candidates = signatureHeader.split(' ');
  for (const c of candidates) {
    const [version, sig] = c.split(',');
    if (version === 'v1' && signaturesEqual(sig, expected)) return true;
  }
  return false;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'method not allowed' });
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Inert until wired up — see module header.
    return ok({ skipped: 'webhook secret not configured' });
  }

  const rawBody = await req.text();
  const verified = await verifySvixSignature({
    secret,
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signatureHeader: req.headers.get('svix-signature'),
    rawBody,
  });
  if (!verified) {
    return json(401, { ok: false, error: 'bad signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(400, { ok: false, error: 'invalid JSON' });
  }

  const type = event && event.type;
  if (type !== 'email.complained' && type !== 'email.bounced') {
    // We only act on reputation-harming events; everything else
    // (delivered, opened, clicked) is acknowledged and ignored.
    return ok({ ignored: type || 'unknown' });
  }

  // data.to can be a string or an array of strings.
  const toField = event.data && event.data.to;
  const addresses = (Array.isArray(toField) ? toField : [toField])
    .filter((a) => typeof a === 'string' && a.includes('@'))
    .map((a) => a.trim().toLowerCase());
  if (!addresses.length || !isDbConfigured()) {
    return ok({ ignored: 'no address' });
  }

  const sql = getSql();
  try {
    // Suppress: flip the preference off for any user with a matching
    // email. ensureNotifyPrefs isn't needed — if they never had a row,
    // there was never anything to send them.
    for (const email of addresses) {
      const users = await sql`select id from users where lower(email) = ${email} limit 1`;
      for (const u of users) {
        await sql`
          insert into notification_prefs (user_id, email_enabled, unsubscribed_at)
          values (${u.id}, false, now())
          on conflict (user_id) do update
          set email_enabled = false, unsubscribed_at = now(), updated_at = now()
        `;
      }
    }
    return ok({ suppressed: addresses.length, type });
  } catch (err) {
    console.error('resend_webhook failed', err);
    // Return 200 anyway: a 500 would make Resend retry a write that may
    // have partially succeeded, and suppression is best-effort.
    return ok({ error: 'suppression failed (logged)' });
  }
};

export const config = { path: '/api/resend-webhook' };
