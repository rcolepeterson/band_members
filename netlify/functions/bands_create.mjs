// POST /api/bands — create a new band in Neon Postgres (PR 3b write path).
//
// Shares the /api/bands route with bands_neon.mjs (GET, read path from
// PR 3a). The two files coexist without collision because each restricts
// itself to one HTTP method via `config.method` — Netlify Functions v2
// dispatches by (path, method) when multiple functions declare the same
// path but different methods. See bands_neon.mjs's config for the GET side.
//
// Auth: any signed-in user (valid bearer token) may create a band. There is
// no ownership model in this app — attribution is via `added_by`/`edited_by`
// on the row plus a contributions log entry, not an access-control check.
//
// Two-transaction shape (same reasoning as seed_bands.mjs): Neon's
// sql.transaction() takes an array of already-built queries and can't use a
// result from one query to build another query in the SAME transaction. We
// need the new band's id (from the INSERT) to build the membership rows, so:
//   1. sql.transaction([insert band, ...upsert members]) — atomic.
//   2. sql.transaction([...insert memberships, insert contribution,
//      increment counter]) — atomic.
// A crash between step 1 and step 2 would leave a band with no memberships
// and no logged contribution; that's an acceptable, narrow failure window
// (matches the existing seed_bands.mjs precedent) rather than a silent data
// corruption risk, and is recoverable by the user re-adding members through
// the edit-members endpoint.

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
import { notifyBandTouched } from './_notify.mjs';
import { createBandInNeon } from './_bands_write.mjs';
import { normalizeLinksInput } from './_links.mjs';

const LIMITS = {
  name: 200,
  city: 80,
  state: 2,
  country: 3,
  genre: 80,
  meta: 200, // years_active / label / albums
  memberName: 120,
  instrument: 120,
  maxMembers: 50,
};

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Mirrors seed_bands.mjs's normalizeCountryCode/normalizeStateCode so the
// same location schema rules apply everywhere a band is written.
function normalizeCountryCode(raw) {
  const country = asTrimmedString(raw).toUpperCase();
  if (!country) return 'USA'; // default per spec
  return country.slice(0, 3);
}
function normalizeStateCode(raw, country) {
  const state = asTrimmedString(raw).toUpperCase();
  if (!state) return '';
  if (country && country !== 'USA') return '';
  return state.slice(0, 2);
}

// Validate + normalize the request body. Returns { ok:true, data } or
// { ok:false, error }.
function validateCreateBody(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }

  const name = asTrimmedString(payload.name);
  if (!name) return { ok: false, error: 'band name is required', field: 'name' };
  if (name.length > LIMITS.name) return { ok: false, error: 'band name is too long', field: 'name' };

  const city = asTrimmedString(payload.city).slice(0, LIMITS.city);
  const country = normalizeCountryCode(payload.country);
  const state = normalizeStateCode(payload.state, country);
  const genre = asTrimmedString(payload.genre).slice(0, LIMITS.genre);
  const years_active = asTrimmedString(payload.years_active).slice(0, LIMITS.meta);
  const label = asTrimmedString(payload.label).slice(0, LIMITS.meta);
  const albums = asTrimmedString(payload.albums).slice(0, LIMITS.meta);

  const rawMembers = Array.isArray(payload.members) ? payload.members : [];
  if (rawMembers.length > LIMITS.maxMembers) {
    return { ok: false, error: 'too many members in one request', field: 'members' };
  }

  const members = [];
  for (const entry of rawMembers) {
    if (!entry || typeof entry !== 'object') continue;
    const id = asTrimmedString(entry.id);
    const memberName = asTrimmedString(entry.name);
    if (!id && !memberName) continue; // skip fully empty rows — matches bands.mjs's "skip" rule
    if (memberName.length > LIMITS.memberName) {
      return { ok: false, error: 'member name is too long', field: 'members' };
    }
    const instrument1 = asTrimmedString(entry.instrument1).slice(0, LIMITS.instrument);
    const instrument2 = asTrimmedString(entry.instrument2).slice(0, LIMITS.instrument);
    const tenure = asTrimmedString(entry.tenure).slice(0, LIMITS.meta);
    const weightNum = Number(entry.weight);
    const weight = Number.isFinite(weightNum) && weightNum > 0 ? Math.trunc(weightNum) : 2;
    const relation = asTrimmedString(entry.relation) || 'member_of';
    members.push({ id: id || null, name: memberName || null, instrument1, instrument2, tenure, weight, relation });
  }

  // Phase 3: social/streaming links. Whoever creates the band may set its
  // links at creation — permission is inherent (the requester IS the
  // creator). Domain-validated per platform; the server is the enforcer
  // (the client mirrors this for inline feedback only).
  const normalizedLinks = normalizeLinksInput(payload.links);
  if (!normalizedLinks.ok) {
    return { ok: false, error: normalizedLinks.error, field: normalizedLinks.field };
  }
  // Drop removals (nulls): no rows exist yet on create.
  const links = {};
  for (const [platform, url] of Object.entries(normalizedLinks.links)) {
    if (url) links[platform] = url;
  }

  return {
    ok: true,
    data: { name, city, state, country, genre, years_active, label, albums, members, links },
  };
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth before DB checks so anonymous callers can't probe DB config state.
  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('request body must be JSON');
  }

  const validated = validateCreateBody(body);
  if (!validated.ok) {
    return badRequest(validated.error, validated.field ? { field: validated.field } : {});
  }
  const { name, city, state, country, genre, years_active, label, albums, members, links } = validated.data;

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    // Keyed on the user id, not the token: rotating a credential must not hand its
    // holder a fresh budget, and the counter table should never hold a live secret.
    // Placed after the token check so an invalid caller cannot spend a real user's
    // allowance by guessing at their id.
    const rl = await consume({ sql, bucket: `band-create:user:${user.id}`, ...RATE_LIMITS.bandCreate });
    if (!rl.allowed) {
      return tooManyRequests(
        'You have added a lot of bands in the last hour. Take a breather and try again shortly.',
        rl.retryAfterSeconds
      );
    }

    const result = await createBandInNeon(sql, {
      name, city, state, country, genre, years_active, label, albums, members, links,
      userId: user.id,
    });

    if (result.conflict) {
      // Same name AND same location already exists. Return the existing
      // band's location so the client can name it in the duplicate message
      // ("already exists in Seattle") instead of dead-ending the user.
      const where = result.existingCity ? ` in ${result.existingCity}` : '';
      return badRequest(`a band with this name already exists${where}`, {
        status: 409,
        error_code: 'band_exists',
        existing_band_id: result.existingBandId,
        existing_band_name: result.existingName,
        existing_band_city: result.existingCity,
        existing_band_country: result.existingCountry,
      });
    }
    if (result.missingMemberIds) {
      return badRequest('one or more referenced member ids do not exist', {
        field: 'members',
        missing_ids: result.missingMemberIds,
      });
    }

    // Band-update notifications (Phase 2). On a fresh create the actor is
    // the only toucher, so this usually notifies nobody — but the call
    // keeps every write path uniform and covers re-creates. Best-effort:
    // notifyBandTouched never throws and never blocks this response.
    await notifyBandTouched(sql, {
      bandId: result.band.id,
      bandName: result.band.name,
      actorUserId: user.id,
    });

    return ok({
      band: result.band,
      member_ids: result.memberIds,
      memberships_created: result.membershipsCreated,
      links,
    });
  } catch (err) {
    console.error('bands_create failed', err);
    return serverError('could not create band', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Method-scoped so this coexists with bands_neon.mjs's GET handler on the
// same /api/bands path without ambiguity.
export const config = { path: '/api/bands', method: 'POST' };
