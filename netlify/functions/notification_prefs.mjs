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
    // Granular event-type toggles (PR 2). All default true.
    notify_band_member_joined: prefs.notify_band_member_joined !== false,
    notify_band_badge_added: prefs.notify_band_badge_added !== false,
    notify_band_edited: prefs.notify_band_edited !== false,
    notify_member_band_changed: prefs.notify_member_band_changed !== false,
    notify_member_edited: prefs.notify_member_edited !== false,
  };
}

const EVENT_TOGGLE_FIELDS = [
  'notify_band_member_joined',
  'notify_band_badge_added',
  'notify_band_edited',
  'notify_member_band_changed',
  'notify_member_edited',
];

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
    // PATCH accepts { email_enabled: boolean } and/or any of the granular
    // event-type toggles. At least one must be present.
    const patch = {};
    if (typeof body.email_enabled === 'boolean') patch.email_enabled = body.email_enabled;
    for (const field of EVENT_TOGGLE_FIELDS) {
      if (typeof body[field] === 'boolean') patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) {
      return badRequest('body must include email_enabled or an event-type toggle', { field: 'email_enabled' });
    }

    // ensureNotifyPrefs first so the row (and its unsubscribe token)
    // exists; then apply the patch. unsubscribed_at tracks the master
    // opt-out moment: set when disabling email, cleared when re-enabling.
    await ensureNotifyPrefs(sql, user.id);
    const updated = await sql`
      update notification_prefs
      set email_enabled = coalesce(${patch.email_enabled ?? null}, email_enabled),
          notify_band_member_joined = coalesce(${patch.notify_band_member_joined ?? null}, notify_band_member_joined),
          notify_band_badge_added = coalesce(${patch.notify_band_badge_added ?? null}, notify_band_badge_added),
          notify_band_edited = coalesce(${patch.notify_band_edited ?? null}, notify_band_edited),
          notify_member_band_changed = coalesce(${patch.notify_member_band_changed ?? null}, notify_member_band_changed),
          notify_member_edited = coalesce(${patch.notify_member_edited ?? null}, notify_member_edited),
          unsubscribed_at = case
            when ${patch.email_enabled ?? null} is null then unsubscribed_at
            when ${patch.email_enabled ?? null} then null
            else now()
          end,
          updated_at = now()
      where user_id = ${user.id}
      returning user_id, email_enabled, unsubscribed_at, unsubscribe_token,
        notify_band_member_joined, notify_band_badge_added, notify_band_edited,
        notify_member_band_changed, notify_member_edited
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
