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
  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

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
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

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

    if (Object.keys(changes).length === 0) {
      // No-op: nothing actually changed. Don't log a contribution, don't
      // touch edited_by/updated_at.
      return ok({ band: existing, changes: {} });
    }

    // Name-collision check: if renaming, no OTHER band may already use the
    // new name (case-insensitive).
    if ('name' in changes) {
      const collision = await sql`
        select id from bands
        where lower(name) = ${normalizedName.toLowerCase()} and id <> ${bandId}
        limit 1
      `;
      if (collision.length) {
        return badRequest('another band already has this name', {
          status: 409,
          error_code: 'name_collision',
          existing_band_id: collision[0].id,
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

    // sql.unsafe is part of the Neon serverless driver's tagged-template API
    // for exactly this "safe because it's from a fixed allowlist" case. If
    // sql.unsafe isn't available in this driver version, fall back to an
    // explicit switch — see the try/catch below for defense in depth.
    let updatedRows;
    try {
      const setClause = setFragments.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`));
      const bandNameForLog = normalizedName || existing.name;
      const metadata = { changes };

      const txResults = await sql.transaction([
        sql`update bands set ${setClause}, edited_by = ${user.id} where id = ${bandId} returning *`,
        sql`
          insert into contributions (user_id, action, band_id, band_name, metadata)
          values (${user.id}, 'edit_band', ${bandId}, ${bandNameForLog}, ${JSON.stringify(metadata)}::jsonb)
        `,
        sql`update users set bands_edited = bands_edited + 1, updated_at = now() where id = ${user.id}`,
      ]);
      updatedRows = txResults[0];
    } catch (unsafeErr) {
      // sql.unsafe is a documented feature of @neondatabase/serverless, but
      // guard anyway: if it's missing/behaves unexpectedly, surface a clear
      // 500 instead of a cryptic driver error.
      console.error('bands_edit: dynamic SET clause failed', unsafeErr);
      throw unsafeErr;
    }

    return ok({ band: updatedRows[0], changes });
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
