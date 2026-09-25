// GET /api/notification-prefs — read my email notification preference.
// PATCH /api/notification-prefs — update it ({ email_enabled: boolean }).
//
// This is the server side of the user card's "Email me when a band I've
// touched is updated" toggle. Phase 1 kept the toggle in localStorage;
// Phase 2 persists it here so the preference follows the user across
// devices and — critically — so the mailer (_notify.mjs) can honor it.
//
// Auth: bearer token, like every other per-user endpoint. Anonymous
// callers get 401 before we touch the DB.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { ensureNotifyPrefs } from './_notify.mjs';

function toResponseBody(prefs) {
  return {
    email_enabled: !!prefs.email_enabled,
    // Exposed so the client can show "unsubscribed on <date>" copy if it
    // wants to; null when the user never opted out.
    unsubscribed_at: prefs.unsubscribed_at || null,
  };
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed();

  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    if (req.method === 'GET') {
      const prefs = await ensureNotifyPrefs(sql, user.id);
      return ok(toResponseBody(prefs));
    }

    // PATCH
    let body;
    try {
      body = await req.json();
    } catch {
      return badRequest('request body must be JSON');
    }
    if (!body || typeof body !== 'object' || typeof body.email_enabled !== 'boolean') {
      return badRequest('body must be { email_enabled: boolean }', { field: 'email_enabled' });
    }

    // ensureNotifyPrefs first so the row (and its unsubscribe token)
    // exists; then flip the switch. unsubscribed_at tracks the opt-out
    // moment: set when disabling, cleared when re-enabling.
    await ensureNotifyPrefs(sql, user.id);
    const updated = await sql`
      update notification_prefs
      set email_enabled = ${body.email_enabled},
          unsubscribed_at = case when ${body.email_enabled} then null else now() end,
          updated_at = now()
      where user_id = ${user.id}
      returning user_id, email_enabled, unsubscribed_at, unsubscribe_token
    `;
    return ok(toResponseBody(updated[0]));
  } catch (err) {
    console.error('notification_prefs failed', err);
    return serverError('could not update notification preferences', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/notification-prefs' };
