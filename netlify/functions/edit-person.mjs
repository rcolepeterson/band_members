// POST /api/edit-person — update a single musician's bio (beta-scoped edit).
//
// Deliberately minimal: this endpoint owns exactly one field (band_members.bio).
// Rename, instrument edits, and tenure edits already exist inside the
// edit-band roster flow (bands_edit_members.mjs) and are out of scope here —
// see the PR description for why the combined scope of a full person-edit
// endpoint was cut down for the beta.
//
// Auth: mirrors bands_edit.mjs exactly — bearer token via extractBearerToken,
// resolved to a user via findUserByToken. Any signed-in user may edit any
// musician's bio; there is no ownership model, same as band edits.
//
// Input shape: { personId: string, bio: string }. `personId` is the
// band_members.id (uuid) OR the member's name — resolved case-insensitively
// against band_members.name, matching how the rest of the app already
// treats "the canonical name/id" for a person (see findRawMemberByName in
// index.html, and band_members_name_lower_idx in migrate.mjs). Accepting
// either shape means the client can send node.id (the display name) without
// having to first resolve a backend uuid, exactly like bands_edit_members.mjs
// accepts either an `id` or a `name` for its `add` entries.
//
// Validation: bio is a plain-text string, trimmed, capped at LIMITS.bio
// (2000 chars — matches the band-submission bio cap in bands.mjs), and
// rejected if it contains a link/URL/promo-domain pattern. BLOCKED_LINK_RE
// below is a byte-for-byte copy of bands.mjs's BLOCKED_LINK_RE so the two
// endpoints enforce the exact same "no links" rule the client's bio field
// note already promises ("Plain text only. Links and promo URLs are not
// allowed.").
//
// Idempotent: re-submitting the same bio value is a normal UPDATE (Postgres
// doesn't care that the new value equals the old one), and this file still
// logs a contribution + counter bump on every successful call, matching
// bands_edit.mjs's per-request (not per-field-changed) contribution logging
// there -- the one exception is bands_edit.mjs's no-op short-circuit for a
// fully-empty diff, which doesn't apply here since there is only one field.
//
// Audit: logs a contributions row with action='edit_person_bio', inside the
// SAME sql.transaction() as the UPDATE (see bands_edit.mjs's header for why
// that atomicity matters). band_id is left null (this edit isn't
// band-scoped); band_name is repurposed to carry the person's name since
// that's the closest existing free-text column, and metadata carries the
// person id + old/new bio for full context.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  notFound,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { consume, tooManyRequests, LIMITS as RATE_LIMITS } from './_rate_limit.mjs';

const LIMITS = {
  bio: 2000,
};

// Mirror of bands.mjs's BLOCKED_LINK_RE (and the client's bioContainsBlockedLink())
// so link spam is rejected here too, even if a caller bypasses the browser form.
const BLOCKED_LINK_RE = /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|io|co|fm|tv|gg|ly|me|info|biz|xyz|site|link|app|dev|music|band|rocks|live))/i;

// A uuid-shaped personId is looked up by id; anything else is treated as a
// name and resolved case-insensitively, matching band_members_name_lower_idx.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth before DB/id checks — unauthenticated callers learn nothing,
  // same ordering discipline as bands_edit.mjs / bands_create.mjs.
  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('request body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('request body must be a JSON object');
  }

  const personId = asTrimmedString(body.personId);
  if (!personId) return badRequest('personId is required', { field: 'personId' });

  if (typeof body.bio !== 'string') {
    return badRequest('bio must be a string', { field: 'bio' });
  }
  const bio = body.bio.trim();
  if (bio.length > LIMITS.bio) {
    return badRequest('bio is too long', { field: 'bio' });
  }
  if (bio && BLOCKED_LINK_RE.test(bio)) {
    return badRequest('Bio must be plain text only — no links, URLs, or promo sites.', { field: 'bio' });
  }

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    // Keyed on the user id, not the token: rotating a credential must not hand its
    // holder a fresh budget, and the counter table should never hold a live secret.
    // Placed after the token check so an invalid caller cannot spend a real user's
    // allowance by guessing at their id.
    const rl = await consume({ sql, bucket: `band-edit:user:${user.id}`, ...RATE_LIMITS.bandEdit });
    if (!rl.allowed) {
      return tooManyRequests(
        'That is a lot of edits in one hour. Try again shortly.',
        rl.retryAfterSeconds
      );
    }

    const existingRows = UUID_RE.test(personId)
      ? await sql`select id, name, bio from band_members where id = ${personId}::uuid limit 1`
      : await sql`select id, name, bio from band_members where lower(name) = lower(${personId}) limit 1`;

    if (!existingRows.length) return notFound('no musician with that id');
    const existing = existingRows[0];

    const metadata = {
      person_id: existing.id,
      person_name: existing.name,
      changes: { bio: { old: existing.bio ?? null, new: bio || null } },
    };

    const [updatedRows] = await sql.transaction([
      sql`update band_members set bio = ${bio || null} where id = ${existing.id} returning id, name, bio`,
      sql`
        insert into contributions (user_id, action, band_id, band_name, metadata)
        values (${user.id}, 'edit_person_bio', ${null}, ${existing.name}, ${JSON.stringify(metadata)}::jsonb)
      `,
      sql`update users set bands_edited = bands_edited + 1, updated_at = now() where id = ${user.id}`,
    ]);

    const updated = updatedRows[0];
    return ok({ personId: updated.id, name: updated.name, bio: updated.bio || '' });
  } catch (err) {
    console.error('edit-person failed', err);
    return serverError('could not edit musician bio', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Mounted at /api/edit-person per the PR spec (a plain action-style POST
// route, unlike /api/bands/:id's RESTful PATCH-by-id shape) -- personId
// travels in the JSON body instead of the URL path since callers may only
// have a display name, not a confirmed backend uuid, at call time.
export const config = { path: '/api/edit-person', method: 'POST' };
