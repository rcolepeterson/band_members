// Shared Neon Postgres helper for all Netlify Functions that need a DB.
//
// Why a shared module: every function that touches Postgres wants the same
// connection setup, the same "is the DB configured?" guard, and the same JSON
// error responses. Centralizing keeps individual endpoints thin and keeps the
// misconfig story consistent (single error shape everywhere).
//
// Why @neondatabase/serverless: it speaks Postgres over an HTTP tunnel, which
// avoids the connection-pool exhaustion that classic `pg` hits when many
// short-lived serverless invocations each open a TCP connection. Each `sql`
// call is its own HTTP request against Neon's pooled endpoint.

import { neon } from '@neondatabase/serverless';

export const DB_URL_ENV = 'NETLIFY_DATABASE_URL';

// Lazy-initialize the client so a missing env var doesn't crash at import time
// (which would take the whole function out before we could return a nice JSON
// error). Instead, callers get `null` and can respond with 503.
let _sql = null;
export function getSql() {
  if (_sql) return _sql;
  const url = process.env[DB_URL_ENV];
  if (!url) return null;
  _sql = neon(url);
  return _sql;
}

// True when the DB URL is configured. Endpoints call this first and short
// -circuit with a 503 if it's false; that way local `netlify dev` without a
// DB configured still returns a helpful error instead of a stack trace.
export function isDbConfigured() {
  return typeof process.env[DB_URL_ENV] === 'string' && process.env[DB_URL_ENV].length > 0;
}

// Standard JSON response builder. Every endpoint uses this to keep the shape
// consistent: { ok: bool, ...payload } with sensible cache headers.
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// Convenience wrappers so endpoints read cleanly.
export const ok = (body) => json(200, { ok: true, ...body });
export const badRequest = (message, extra = {}) => json(400, { ok: false, error: message, ...extra });
export const unauthorized = (message = 'unauthorized') => json(401, { ok: false, error: message });
export const notFound = (message = 'not found') => json(404, { ok: false, error: message });
export const methodNotAllowed = () => json(405, { ok: false, error: 'method not allowed' });
export const serverError = (message = 'server error', extra = {}) => json(500, { ok: false, error: message, ...extra });
export const dbUnavailable = () =>
  json(503, {
    ok: false,
    error: 'database not configured',
    hint: `Set the ${DB_URL_ENV} environment variable in Netlify (Site config -> Environment variables). Scope to Functions only.`,
  });

// --- Auth token helpers ------------------------------------------------------
//
// We store a small opaque token in localStorage on the client and require it
// on any endpoint that acts on behalf of a specific user (contributions, me).
// Not a JWT — deliberately simpler: the token IS a random string we generate
// at signup time and store in the users table. Verifying a token = looking it
// up in the DB. This keeps rotation trivial (delete the row) and avoids the
// signing-key management overhead of JWT for a hobby-scale app.
//
// The token is treated as sensitive: transmitted in an Authorization header,
// never in query strings, and stored per-user (not per-session) so revoking a
// leaked token means resetting one column.

export function extractBearerToken(req) {
  const header = req.headers?.get?.('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

// Generate a cryptographically random 32-byte token, base64url-encoded. Uses
// the Web Crypto API which is available in Netlify's Node functions runtime
// natively — no dependency on `crypto` needed. Length chosen to be well past
// the point of guessability (~256 bits of entropy).
export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url (no padding) — URL/JSON safe with no escaping needed.
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Look up a user by their bearer token. Returns the user row or null.
// Kept here (not inside individual endpoints) so authorization is uniform.
export async function findUserByToken(sql, token) {
  if (!token) return null;
  const rows = await sql`
    select id, email, name, token, bands_added, bands_edited, created_at
    from users
    where token = ${token}
    limit 1
  `;
  return rows[0] || null;
}

// --- Email normalization -----------------------------------------------------
// Basic normalization: trim and lowercase. Not doing anything fancier (like
// plus-address stripping) because we WANT plus-addresses to identify distinct
// signups if someone chooses to use them.
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

// Extremely permissive email validator: presence of @ with something on each
// side. HTML5 form validation already blocked obvious garbage on the client;
// the server's job is just to reject values that would poison the unique
// index (empty string, whitespace-only).
export function isPlausibleEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1;
}

// Trim + collapse whitespace + length-cap. Names are display-only, no
// uniqueness constraint, so we don't need to normalize case.
export function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 100);
}
