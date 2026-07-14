import { getStore } from '@netlify/blobs';

// Shared backend for "Add your band" submissions.
//
// Storage model: a single JSON array of "draft" objects lives under one
// well-known key in a Netlify Blobs store. Each draft matches the exact shape
// the client's applyDraftToMaster() already knows how to fold into the graph,
// so the client stays the source of truth for draft->graph conversion and we
// avoid duplicating that logic on the server.
//
// This is intentionally simple (read-modify-write of one blob) — correct and
// reliable at this scale. There is no moderation queue: a successful POST is
// live for everyone on the next GET.

const STORE_NAME = 'band-submissions';
const BLOB_KEY = 'submissions';

// Admin auth for the DELETE handler. The real secret should live in a Netlify
// environment variable (process.env.ADMIN_TOKEN). The constant below is a
// TEMPORARY fallback for a repo with no Netlify env vars configured yet — move
// ADMIN_TOKEN to a real Netlify environment variable (Site settings >
// Environment variables) for real security, then delete this fallback constant.
const FALLBACK_ADMIN_TOKEN = 'wuMexYAcvCf4EMEjuey666YAGWLZ6Joq';
const ADMIN_TOKEN_HEADER = 'x-admin-token';

// Fail closed: authorize only when a non-empty expected token exists AND the
// caller presents exactly that token. env ADMIN_TOKEN takes precedence; the
// hardcoded fallback is used only when the env var is unset.
function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN || FALLBACK_ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

// Remove the submission with the given id. Returns { found, submissions } where
// submissions is the resulting list (unchanged when the id was not present).
function removeSubmissionById(submissions, id) {
  const next = submissions.filter(entry => entry?.id !== id);
  return { found: next.length !== submissions.length, submissions: next };
}

// --- Persistence guarantees (read this before changing store setup) ---------
//
// WHY getStore (and NOT getDeployStore): `@netlify/blobs` exposes two kinds of
// stores. getStore(name) returns a *site-wide* store: its data lives at the
// site level and is shared across every deploy and deploy context, so it
// survives redeploys forever until we explicitly delete it. getDeployStore()
// returns a *deploy-scoped* store whose data is pegged to a single deploy and
// is WIPED whenever that deploy is replaced — i.e. on every push/merge. Using
// getDeployStore here would make submissions vanish on the next deploy, which
// is exactly the failure we are fixing. Never swap this for getDeployStore, and
// never pass a `deployID` to getStore (that also switches it to deploy scope).
//
// WHY consistency: 'strong': by default Blobs reads are eventually consistent
// and served from an edge cache. Right after a fresh deploy that cache is cold,
// so an immediate read (e.g. curl straight after a merge) can return an empty
// list even though the blob still exists in the persistent site store. Strong
// consistency reads from the source of truth (the uncached edge endpoint that
// Netlify injects into the function environment), so a submission is visible
// immediately and every redeploy still sees the full history. It also protects
// our read-modify-write of the single submissions blob from lost updates caused
// by a stale read.
//
// siteID/token are read automatically from the Netlify Functions environment
// (NETLIFY_BLOBS_CONTEXT), which is the documented setup for Functions v2 — we
// intentionally do NOT hardcode them.
function getSubmissionsStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

// Field limits — reject obviously malicious/oversized input server-side too,
// mirroring the client validation.
const LIMITS = {
  band: 120,
  city: 80,
  state: 2,
  country: 3,
  member: 120,
  instrument: 120,
  bio: 2000,
  meta: 200, // yearsActive / label / albums
  maxMembers: 50,
  maxBodyBytes: 64 * 1024 // 64 KB is far more than a legitimate submission needs
};

// ---------------------------------------------------------------------------
// Location schema helpers (server-side mirror of the client's helpers in
// index.html). Nodes/drafts carry city (plain text), state (USPS 2-letter,
// US only), and country (ISO 3166-1 alpha-3). Kept in sync by hand with the
// client copy until the shared scripts/location-helpers.mjs module lands.
// ---------------------------------------------------------------------------

function normalizeCountryCode(rawCountry) {
  const country = asTrimmedString(rawCountry).toUpperCase();
  if (!country) return '';
  return country.slice(0, 3);
}

function normalizeStateCode(rawState, country) {
  const state = asTrimmedString(rawState).toUpperCase();
  if (!state) return '';
  if (country && country !== 'USA') return ''; // discard non-US state values
  return state.slice(0, 2);
}

// Old-shape submissions (pre-refactor) stored a single 'scene' string, e.g.
// 'Seattle, WA' or bare 'Seattle'. This is Option A from the brief: legacy
// blobs are migrated lazily at READ time, not via a one-off data migration
// script, so the 14 pre-refactor submissions keep rendering correctly
// without ever being rewritten in storage.
const LEGACY_COUNTRY_ALIASES = {
  NZ: 'NZL',
  AU: 'AUS',
  EN: 'GBR',
  SCT: 'GBR',
  UK: 'GBR',
};
// Known-city lookup for bare-city legacy inputs (e.g. 'Parc Boys' was
// submitted with scene: 'Seattle' before this refactor; without this table,
// its locationKey would be 'USA||Seattle' and wouldn't match the CSV's
// 'USA|WA|Seattle'). Keep in sync with scripts/location-helpers.mjs.
const KNOWN_CITY_LOCATIONS = {
  seattle:       { state: 'WA', country: 'USA' },
  tacoma:        { state: 'WA', country: 'USA' },
  issaquah:      { state: 'WA', country: 'USA' },
  portland:      { state: 'OR', country: 'USA' },
  'los angeles': { state: 'CA', country: 'USA' },
  venice:        { state: 'CA', country: 'USA' },
  'palm desert': { state: 'CA', country: 'USA' },
  'san francisco': { state: 'CA', country: 'USA' },
  'new york':    { state: 'NY', country: 'USA' },
  'berkeley heights': { state: 'NJ', country: 'USA' },
  chicago:       { state: 'IL', country: 'USA' },
  champaign:     { state: 'IL', country: 'USA' },
  rockford:      { state: 'IL', country: 'USA' },
  cleveland:     { state: 'OH', country: 'USA' },
  'coral springs': { state: 'FL', country: 'USA' },
  'kansas city': { state: 'MO', country: 'USA' },
  'oklahoma city': { state: 'OK', country: 'USA' },
  auckland:      { state: '', country: 'NZL' },
  sydney:        { state: '', country: 'AUS' },
  melbourne:     { state: '', country: 'AUS' },
  london:        { state: '', country: 'GBR' },
  birmingham:    { state: '', country: 'GBR' },
  manchester:    { state: '', country: 'GBR' },
  glasgow:       { state: '', country: 'GBR' },
};
function parseLegacyScene(raw) {
  const trimmed = asTrimmedString(raw);
  if (!trimmed) return { city: '', state: '', country: '' };
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[0];
    const suffix = parts[1].toUpperCase();
    if (LEGACY_COUNTRY_ALIASES[suffix]) {
      return { city, state: '', country: LEGACY_COUNTRY_ALIASES[suffix] };
    }
    if (suffix.length === 3) {
      return { city, state: '', country: suffix };
    }
    if (suffix.length === 2) {
      return { city, state: suffix, country: 'USA' };
    }
    return { city: trimmed, state: '', country: 'USA' };
  }
  // Single-part bare-city input: look up the known-city table so the
  // resulting locationKey matches the CSV rows for the same scene.
  const rawCity = parts[0] || '';
  const known = KNOWN_CITY_LOCATIONS[rawCity.toLowerCase()];
  if (known) {
    return { city: rawCity, state: known.state, country: known.country };
  }
  return { city: rawCity, state: '', country: 'USA' };
}

// Given a raw submission record (either new-shape with city/state/country,
// or old-shape with a single scene string), returns the normalized
// { city, state, country } this record should be treated as having. Applied
// at read time so every GET response is already in the new shape regardless
// of how it's stored on disk.
function resolveSubmissionLocation(record) {
  if (!record || typeof record !== 'object') return { city: '', state: '', country: '' };
  let city = asTrimmedString(record.city);
  let country = normalizeCountryCode(record.country);
  let state = normalizeStateCode(record.state, country);
  if (!city && !country && record.scene) {
    const legacy = parseLegacyScene(record.scene);
    city = legacy.city;
    country = legacy.country;
    state = legacy.state;
  }
  if (!country && city) country = 'USA';
  return { city, state, country };
}

// Migrate a stored submission (as read from the blob) to the new shape for
// the response payload. Leaves the underlying blob untouched — the lazy
// migration only ever happens in memory, on read.
function migrateSubmissionForRead(record) {
  if (!record || typeof record !== 'object') return record;
  const location = resolveSubmissionLocation(record);
  const { scene, ...rest } = record;
  return { ...rest, ...location };
}

// Mirror of the client's bioContainsBlockedLink() so link spam is rejected
// even if a caller bypasses the browser form.
const BLOCKED_LINK_RE = /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|io|co|fm|tv|gg|ly|me|info|biz|xyz|site|link|app|dev|music|band|rocks|live))/i;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Always serve the freshest submission list.
      'cache-control': 'no-store'
    }
  });
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Validate + normalize an incoming submission payload. Returns
// { ok: true, draft } on success or { ok: false, error } on rejection.
function validateSubmission(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Submission must be a JSON object.' };
  }

  const band = asTrimmedString(payload.band);
  if (!band) return { ok: false, error: 'A band name is required.' };
  if (band.length > LIMITS.band) return { ok: false, error: 'Band name is too long.' };

  // Accept the new city/state/country shape, or fall back to splitting a
  // legacy 'scene' string (a caller on old client code, or a hand-built
  // request). Mirrors applyDraftToMaster()'s same fallback on the client.
  let city = asTrimmedString(payload.city);
  let country = normalizeCountryCode(payload.country);
  let state = normalizeStateCode(payload.state, country);
  if (!city && !country && payload.scene) {
    const legacy = parseLegacyScene(payload.scene);
    city = legacy.city;
    country = legacy.country;
    state = legacy.state;
  }
  if (!city) city = 'Seattle';
  if (!country) country = 'USA';
  if (city.length > LIMITS.city) return { ok: false, error: 'City name is too long.' };
  if (state.length > LIMITS.state) return { ok: false, error: 'State must be a 2-letter USPS code.' };
  if (country.length > LIMITS.country) return { ok: false, error: 'Country must be a 3-letter ISO code.' };

  const bio = asTrimmedString(payload.bio);
  if (bio.length > LIMITS.bio) return { ok: false, error: 'Bio is too long.' };
  if (bio && BLOCKED_LINK_RE.test(bio)) {
    return { ok: false, error: 'Bio must be plain text only — no links, URLs, or promo sites.' };
  }

  // Accept the multi-member shape ({ members: [...] }) and the legacy
  // single-member shape ({ member, instrument, relation }).
  let rawMembers = Array.isArray(payload.members) ? payload.members : [];
  if (!rawMembers.length && asTrimmedString(payload.member)) {
    rawMembers = [{ member: payload.member, instrument: payload.instrument, relation: payload.relation }];
  }
  if (rawMembers.length > LIMITS.maxMembers) {
    return { ok: false, error: 'Too many members in one submission.' };
  }

  const members = [];
  const seen = new Set();
  for (const entry of rawMembers) {
    if (!entry || typeof entry !== 'object') continue;
    const member = asTrimmedString(entry.member);
    const instrument = asTrimmedString(entry.instrument);
    if (!member && !instrument) continue; // skip fully empty rows
    if (!member) return { ok: false, error: 'Each member row needs a name.' };
    if (member.length > LIMITS.member) return { ok: false, error: 'Member name is too long.' };
    if (instrument.length > LIMITS.instrument) return { ok: false, error: 'Instrument name is too long.' };
    const key = member.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `${member} is listed more than once.` };
    seen.add(key);
    // relation is a small numeric "closeness" weight in the form (1..n).
    const relationNum = Number(entry.relation);
    const relation = Number.isFinite(relationNum) && relationNum > 0 ? String(Math.min(relationNum, 10)) : '2';
    members.push({ member, instrument, relation });
  }

  const clampMeta = value => asTrimmedString(value).slice(0, LIMITS.meta);

  const draft = {
    id: (globalThis.crypto?.randomUUID?.() || `sub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`),
    band,
    members,
    city,
    state,
    country,
    yearsActive: clampMeta(payload.yearsActive),
    label: clampMeta(payload.label),
    albums: clampMeta(payload.albums),
    bio,
    mode: payload.mode === 'existing-band-connection' ? 'existing-band-connection' : 'new-band-entry',
    savedAt: new Date().toISOString()
  };

  return { ok: true, draft };
}

async function readSubmissions(store) {
  const existing = await store.get(BLOB_KEY, { type: 'json' });
  return Array.isArray(existing) ? existing : [];
}

export default async function handler(req) {
  const store = getSubmissionsStore();

  if (req.method === 'GET') {
    try {
      const submissions = await readSubmissions(store);
      // Option A lazy migration: any stored submission still in the old
      // { scene: 'Seattle, WA' } shape (the 14 pre-refactor entries) is
      // migrated to { city, state, country } here, in memory, on every read.
      // The blob itself is never rewritten by this path.
      return jsonResponse({ submissions: submissions.map(migrateSubmissionForRead) });
    } catch (error) {
      return jsonResponse({ error: 'Could not read submissions.' }, 500);
    }
  }

  if (req.method === 'POST') {
    let payload;
    try {
      const raw = await req.text();
      if (raw.length > LIMITS.maxBodyBytes) {
        return jsonResponse({ error: 'Submission payload is too large.' }, 413);
      }
      payload = JSON.parse(raw);
    } catch (error) {
      return jsonResponse({ error: 'Request body must be valid JSON.' }, 400);
    }

    const result = validateSubmission(payload);
    if (!result.ok) {
      return jsonResponse({ error: result.error }, 400);
    }

    try {
      // Read-modify-write the single submissions blob.
      const submissions = await readSubmissions(store);
      submissions.push(result.draft);
      await store.setJSON(BLOB_KEY, submissions);
    } catch (error) {
      return jsonResponse({ error: 'Could not save submission.' }, 500);
    }

    return jsonResponse({ submission: result.draft }, 201);
  }

  if (req.method === 'DELETE') {
    // Admin-only: remove a single bad/spam/duplicate submission by id.
    if (!isAdminAuthorized(req)) {
      return jsonResponse({ error: 'Unauthorized.' }, 401);
    }

    const id = new URL(req.url).searchParams.get('id');
    if (!id) {
      return jsonResponse({ error: 'An id query parameter is required.' }, 400);
    }

    try {
      // Read-modify-write the single submissions blob.
      const submissions = await readSubmissions(store);
      const { found, submissions: remaining } = removeSubmissionById(submissions, id);
      if (!found) {
        return jsonResponse({ error: 'No submission with that id.' }, 404);
      }
      await store.setJSON(BLOB_KEY, remaining);
      return jsonResponse({ submissions: remaining });
    } catch (error) {
      return jsonResponse({ error: 'Could not delete submission.' }, 500);
    }
  }

  return jsonResponse({ error: 'Method not allowed.' }, 405);
}

// Exported for isolated unit testing of the validation logic (see repo verify step).
export {
  validateSubmission,
  LIMITS,
  isAdminAuthorized,
  removeSubmissionById,
  FALLBACK_ADMIN_TOKEN,
  parseLegacyScene,
  resolveSubmissionLocation,
  migrateSubmissionForRead,
  normalizeCountryCode,
  normalizeStateCode
};
