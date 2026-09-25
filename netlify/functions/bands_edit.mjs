// PATCH /api/bands/:id — edit a band's metadata fields (PR 3b write path).
//
// Route param extraction: Netlify Functions v2 exposes named URLPattern
// groups from `config.path` (e.g. ':id') on `context.params`. We read from
// there first and fall back to parsing `new URL(req.url).pathname` in case
// the local dev/test harness doesn't populate `context.params` (defensive —
// verified against the Netlify docs, but cheap insurance either way).
//
// Auth: any signed-in user may edit any band — there is no ownership model.
// Attribution is via `edited_by` on the row plus a contributions log entry.
//
// Attribution ownership: this endpoint OWNS the contribution log write for
// edits. It happens INSIDE the same transaction as the UPDATE, so the log
// and the mutation can never disagree (no separate client call to
// /api/contributions for edits — that would risk logging a contribution for
// a write that failed, or vice versa, since the two calls wouldn't be
// atomic with each other). If the client's edit UI ever wants to show a
// success toast with contribution info, it should read the `changes` field
// from THIS endpoint's response, not make a second call.
//
// PR 4a note (passive cache invalidation): this endpoint does NOT need to
// touch the `verifications` table directly. Every successful UPDATE here
// bumps `bands.updated_at` via the existing bands_set_updated_at trigger
// (see migrate.mjs), and verify_band.mjs treats a cached verification as
// stale whenever bands.updated_at is newer than verifications.verified_at.
// So an edit here silently invalidates any prior cross-check result for
// this band without this file knowing the verifications table exists.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';
import { consume, tooManyRequests, LIMITS as RATE_LIMITS } from './_rate_limit.mjs';
import { sameBandIdentity } from './_bands_write.mjs';
import { notifyBandTouched } from './_notify.mjs';
import {
  normalizeLinksInput,
  diffBandLinks,
  bandLinkWriteQueries,
  canManageBandLinks,
  requestHasAdminToken,
} from './_links.mjs';

const LIMITS = {
  name: 200,
  city: 80,
  state: 2,
  country: 3,
  genre: 80,
  meta: 200, // years_active / label / albums
};

// Fields the client may PATCH, and how to normalize each. Sparse body: only
// keys present in the request are considered — this drives both the diff
// computation and the UPDATE's SET clause.
const EDITABLE_FIELDS = ['name', 'city', 'state', 'country', 'genre', 'years_active', 'label', 'albums'];

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCountryCode(raw) {
  const country = asTrimmedString(raw).toUpperCase();
  return country.slice(0, 3);
}
function normalizeStateCode(raw, country) {
  const state = asTrimmedString(raw).toUpperCase();
  if (!state) return '';
  if (country && country !== 'USA') return '';
  return state.slice(0, 2);
}

// Extract the :id path param, preferring context.params, falling back to
// manual URL parsing against the known /api/bands/:id shape.
function extractBandId(req, context) {
  const fromContext = context && context.params && typeof context.params.id === 'string' ? context.params.id.trim() : '';
  if (fromContext) return fromContext;
  try {
    const pathname = new URL(req.url).pathname;
    const match = /\/api\/bands\/([^/]+)\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

// Normalize + validate one field's incoming value. Returns the normalized
// value or throws a { error, field } shaped object for the caller to 400 on.
function normalizeField(field, rawValue, pendingCountry) {
  switch (field) {
    case 'name': {
      const v = asTrimmedString(rawValue);
      if (!v) throw { error: 'band name cannot be empty', field: 'name' };
      if (v.length > LIMITS.name) throw { error: 'band name is too long', field: 'name' };
      return v;
    }
    case 'city': {
      const v = asTrimmedString(rawValue).slice(0, LIMITS.city);
      return v;
    }
    case 'country': {
      const v = normalizeCountryCode(rawValue);
      if (v.length > LIMITS.country) throw { error: 'country must be a 3-letter ISO code', field: 'country' };
      return v;
    }
    case 'state': {
      const v = normalizeStateCode(rawValue, pendingCountry);
      if (v.length > LIMITS.state) throw { error: 'state must be a 2-letter USPS code', field: 'state' };
      return v;
    }
    case 'genre':
      return asTrimmedString(rawValue).slice(0, LIMITS.genre);
    case 'years_active':
    case 'label':
    case 'albums':
      return asTrimmedString(rawValue).slice(0, LIMITS.meta);
    default:
      return asTrimmedString(rawValue);
  }
}

export default async (req, context) => {
  if (req.method !== 'PATCH') return methodNotAllowed();

  // Auth before DB/id checks — unauthenticated callers learn nothing.
  // Phase 3: a valid admin token (x-admin-token) substitutes for a bearer
  // token, so admin tooling (link backfills) can PATCH links without
  // impersonating a user. The permission gate for links still applies
  // below; metadata edits remain any-signed-in-user as before.
  const token = extractBearerToken(req);
  const adminToken = requestHasAdminToken(req);
  if (!token && !adminToken) return unauthorized('missing bearer token');

  const bandId = extractBandId(req, context);
  if (!bandId) return badRequest('band id is required in the URL path', { field: 'id' });

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

  const sql = getSql();

  try {
    // Bearer token resolves to a user; admin-token-only requests proceed
    // without one (no attribution, no contribution log — see below).
    let user = null;
    if (token) {
      user = await findUserByToken(sql, token);
      if (!user) return unauthorized('invalid or revoked token');
    }

    // Keyed on the user id, not the token: rotating a credential must not hand its
    // holder a fresh budget, and the counter table should never hold a live secret.
    // Placed after the token check so an invalid caller cannot spend a real user's
    // allowance by guessing at their id. Admin-token requests skip the user
    // budget (the token itself is the credential; the other admin endpoints
    // don't rate-limit either).
    if (user) {
      const rl = await consume({ sql, bucket: `band-edit:user:${user.id}`, ...RATE_LIMITS.bandEdit });
      if (!rl.allowed) {
        return tooManyRequests(
          'That is a lot of edits in one hour. Try again shortly.',
          rl.retryAfterSeconds
        );
      }
    }

    const existingRows = await sql`select * from bands where id = ${bandId} limit 1`;
    if (!existingRows.length) return notFound('no band with that id');
    const existing = existingRows[0];

    // Country must be resolved before state (state validity depends on it).
    // If the caller doesn't touch country in this PATCH, use the existing
    // row's country as context for validating a state-only change.
    const pendingCountry = 'country' in body
      ? normalizeCountryCode(body.country)
      : (existing.country || '');

    const changes = {};
    let normalizedName = null;
    for (const field of EDITABLE_FIELDS) {
      if (!(field in body)) continue; // sparse PATCH — skip untouched fields
      let normalized;
      try {
        normalized = normalizeField(field, body[field], pendingCountry);
      } catch (fieldErr) {
        return badRequest(fieldErr.error, { field: fieldErr.field });
      }
      const oldValue = existing[field] ?? '';
      const newValue = normalized ?? '';
      if (oldValue !== newValue) {
        changes[field] = { old: existing[field] ?? null, new: normalized || null };
      }
      if (field === 'name') normalizedName = normalized;
    }

    // Phase 3: the admin token authorizes LINK edits only. Ordinary metadata
    // editing keeps its original rule — a signed-in user via Bearer token —
    // so an admin-token-only request carrying real metadata changes is
    // rejected here, before the links block below.
    if (!user && Object.keys(changes).length > 0) {
      return unauthorized('metadata edits require a signed-in user');
    }

    // Phase 3: social links. Only the band's creator (bands.added_by) or an
    // admin-token holder may touch these — everyone else gets a 403, even
    // though plain metadata edits stay open to any signed-in user. Empty
    // string per platform = remove that link. The diff below keeps a
    // resubmission of identical links a true no-op.
    let linksChanged = {};
    if ('links' in body) {
      const normalized = normalizeLinksInput(body.links);
      if (!normalized.ok) {
        return badRequest(normalized.error, { field: normalized.field });
      }
      if (!canManageBandLinks({ bandAddedBy: existing.added_by, userId: user ? user.id : null, req })) {
        return forbidden('only the band creator or an admin can edit links');
      }
      const currentLinkRows = await sql`select platform, url from band_links where band_id = ${bandId}`;
      linksChanged = diffBandLinks(currentLinkRows, normalized.links);
    }
    const linksChangedKeys = Object.keys(linksChanged);

    if (Object.keys(changes).length === 0 && linksChangedKeys.length === 0) {
      // No-op: nothing actually changed. Don't log a contribution, don't
      // touch edited_by/updated_at.
      return ok({ band: existing, changes: {} });
    }

    // Identity-collision check: band identity is name + city + country. A
    // rename (or relocation) is blocked only when ANOTHER band already owns
    // the resulting identity. Same name in a different city is a different
    // band — allowed through. Mirrors createBandInNeon's conflict check in
    // _bands_write.mjs; keep the two in sync.
    if ('name' in changes || 'city' in changes || 'country' in changes) {
      const pendingName = 'name' in changes ? (changes.name.new || '') : (existing.name || '');
      const pendingCity = 'city' in changes ? (changes.city.new || '') : (existing.city || '');
      const pendingCountry = 'country' in changes ? (changes.country.new || '') : (existing.country || '');
      const candidates = await sql`
        select id, name, city, country from bands
        where lower(name) = ${pendingName.toLowerCase()} and id <> ${bandId}
      `;
      const clash = candidates.find((row) =>
        sameBandIdentity(
          { name: pendingName, city: pendingCity, country: pendingCountry },
          { name: row.name, city: row.city, country: row.country }
        )
      );
      if (clash) {
        return badRequest('another band already has this name', {
          status: 409,
          error_code: 'name_collision',
          existing_band_id: clash.id,
        });
      }
    }

    // Build the dynamic SET clause. Neon's tagged-template driver can't
    // parameterize column names, but every key here comes from
    // EDITABLE_FIELDS (a fixed allowlist), never from raw user input, so
    // interpolating the field name into the query text is safe.
    const setFragments = Object.keys(changes).map(field => {
      const value = changes[field].new;
      return sql`${sql.unsafe(field)} = ${value}`;
    });
    // Attribution: a signed-in editor becomes edited_by (which also feeds
    // the notify audience). Admin-token-only requests carry no user, so
    // they leave edited_by untouched rather than nulling it.
    if (user) setFragments.push(sql`edited_by = ${user.id}`);

    // sql.unsafe is part of the Neon serverless driver's tagged-template API
    // for exactly this "safe because it's from a fixed allowlist" case. If
    // sql.unsafe isn't available in this driver version, fall back to an
    // explicit switch — see the try/catch below for defense in depth.
    //
    // Phase 3: link upserts/deletes join the same atomic transaction as the
    // metadata UPDATE. A link-only edit still runs a transaction (links +
    // attribution), just without a metadata SET clause.
    const metaChanged = Object.keys(changes).length > 0;
    const linkQueries = bandLinkWriteQueries(sql, bandId, linksChanged);
    const bandNameForLog = normalizedName || existing.name;
    const metadata = { changes };
    if (linksChangedKeys.length) metadata.links = linksChanged;

    let updatedBand = existing;
    try {
      const txParts = [];
      if (metaChanged) {
        const setClause = setFragments.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`));
        txParts.push(sql`update bands set ${setClause} where id = ${bandId} returning *`);
      } else if (user && linksChangedKeys.length) {
        // Link-only edit by a signed-in user: attribute the touch without
        // a metadata diff.
        txParts.push(sql`update bands set edited_by = ${user.id} where id = ${bandId} returning *`);
      }
      const bandRowIndex = txParts.length - 1; // -1 when no band UPDATE ran
      if (user) {
        txParts.push(sql`
          insert into contributions (user_id, action, band_id, band_name, metadata)
          values (${user.id}, 'edit_band', ${bandId}, ${bandNameForLog}, ${JSON.stringify(metadata)}::jsonb)
        `);
        txParts.push(sql`update users set bands_edited = bands_edited + 1, updated_at = now() where id = ${user.id}`);
      }
      txParts.push(...linkQueries);

      const txResults = await sql.transaction(txParts);
      if (bandRowIndex >= 0 && txResults[bandRowIndex] && txResults[bandRowIndex][0]) {
        updatedBand = txResults[bandRowIndex][0];
      }
    } catch (unsafeErr) {
      // sql.unsafe is a documented feature of @neondatabase/serverless, but
      // guard anyway: if it's missing/behaves unexpectedly, surface a clear
      // 500 instead of a cryptic driver error.
      console.error('bands_edit: dynamic SET clause failed', unsafeErr);
      throw unsafeErr;
    }

    // Band-update notifications (Phase 2). The actor is excluded by
    // notifyBandTouched; everyone else who touched this band gets at most
    // one email per 24h. Link changes count as band updates, so they fire
    // the hook too. Admin-token edits have no actor to exclude.
    // Best-effort: never throws, never blocks this response.
    await notifyBandTouched(sql, {
      bandId,
      bandName: updatedBand.name,
      actorUserId: user ? user.id : null,
    });

    return ok({ band: updatedBand, changes, links: linksChanged });
  } catch (err) {
    console.error('bands_edit failed', err);
    return serverError('could not edit band', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Netlify Functions v2 route with a named path param. context.params.id is
// populated for requests matching this pattern; see extractBandId() above.
export const config = { path: '/api/bands/:id', method: 'PATCH' };
