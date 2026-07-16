import { getStore } from '@netlify/blobs';
import { getSql, isDbConfigured, extractBearerToken, findUserByToken } from './_db.mjs';
import { createBandInNeon } from './_bands_write.mjs';

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

// --- Audit log (PR 16 - 2026-07-14) -----------------------------------------
//
// Every accepted POST and every admin DELETE writes a one-shot record to a
// SEPARATE Netlify Blobs store, using a UNIQUE per-event key. This is
// deliberately NOT the same read-modify-write pattern as the main submissions
// blob: because each audit event lives at its own key, two concurrent
// submissions cannot silently overwrite each other's audit entries the way
// they could theoretically overwrite each other's submissions.
//
// Purpose: give us an independent record of every write so that if a user
// reports "I submitted my band and it disappeared", we can compare the audit
// store against the main submissions blob and detect a lost write. The audit
// store is APPEND-ONLY from the app's perspective (no code path here mutates
// an existing key).
//
// Failure policy: audit writes are fire-and-forget. If the audit store errors,
// we log to console.error (which surfaces in Netlify function logs) and
// continue - a failed audit write must never break a legitimate submission or
// deletion.
//
// Key format: `{isoTimestamp}-{submissionId}` - sorted alphabetically =
// sorted chronologically, so `store.list()` yields a natural timeline.
const AUDIT_STORE_NAME = 'band-submissions-audit';
function getAuditStore() {
  return getStore({ name: AUDIT_STORE_NAME, consistency: 'strong' });
}

// Best-effort audit-log write. Never throws; failure is logged and swallowed.
// `event` is a short string tag ('submission_accepted' | 'submission_deleted').
// `submissionId` is the id of the submission being acted on.
// `draft` is the full submission object (or the deleted one) for forensics.
// `req` is the incoming Request, used to record IP/User-Agent for spam triage.
// Split out purely so we can unit-test it without a Netlify Blobs mock.
// Reads the client IP + user-agent off the request, applying the standard
// Netlify precedence: x-nf-client-connection-ip is authoritative when
// present; x-forwarded-for is the fallback for proxy chains.
function extractClientMeta(req) {
  const ip =
    req.headers?.get?.('x-nf-client-connection-ip') ||
    (req.headers?.get?.('x-forwarded-for') || '').split(',')[0].trim() ||
    '';
  const userAgent = req.headers?.get?.('user-agent') || '';
  return { ip, userAgent };
}

async function writeAuditEntry(event, submissionId, draft, req) {
  try {
    const now = new Date().toISOString();
    const { ip, userAgent } = extractClientMeta(req);
    const entry = { event, at: now, submissionId, ip, userAgent, draft };
    const store = getAuditStore();
    // Randomize the tail so two events with the same submissionId in the same
    // millisecond (highly unlikely, but theoretically possible on POST retry)
    // still land at different keys.
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `${now}-${submissionId || 'noid'}-${rand}`;
    await store.setJSON(key, entry);
  } catch (err) {
    // Never surface audit failures to the caller. Log for later investigation.
    console.error('audit-log write failed', { event, submissionId, err: String(err) });
  }
}

// Admin auth for the DELETE handler. The secret lives in a Netlify
// environment variable (process.env.ADMIN_TOKEN); there is no fallback in
// source. If ADMIN_TOKEN is unset in a given deploy, this function fails
// closed and every DELETE request is rejected as unauthorized — that is the
// intended behavior. Set ADMIN_TOKEN under Site settings > Environment
// variables and redeploy to enable admin operations.
//
// Rotation: to invalidate an old token, update the value in Netlify env vars
// and redeploy. The old value (if any) becomes immediately non-authoritative
// because nothing else in the codebase compares against it.
//
// History note (PR #46): a hardcoded fallback token used to live here for
// bootstrapping. It was removed after being leaked-by-design into every clone
// of the repo; a fresh token was provisioned in Netlify and the old one
// rotated out. Don't reintroduce a fallback -- doing so re-broadcasts a
// permanent secret via git history the moment it lands.
const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
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
  genre: 80,
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

// Genre normalization: trim + title-case each word. Keep in sync with
// scripts/location-helpers.mjs::normalizeGenre and the client-side inline
// copy in index.html.
function normalizeGenre(raw) {
  const trimmed = asTrimmedString(raw);
  if (!trimmed) return '';
  return trimmed.replace(/(^|[\s\-\/])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
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

// Given a raw stored submission, return its normalized genre value. Pre-genre
// submissions have no `genre` field at all; they surface as ''. Kept alongside
// resolveSubmissionLocation so the read path handles every soft attribute the
// same way (lazy migration in memory, blob left untouched on disk).
function resolveSubmissionGenre(record) {
  if (!record || typeof record !== 'object') return '';
  return normalizeGenre(record.genre);
}

// Long-form band metadata (yearsActive / label / albums). Pre-metadata
// submissions have no such fields; they surface as ''. Read-time lazy
// migration in memory only.
function resolveSubmissionMeta(record) {
  if (!record || typeof record !== 'object') return { yearsActive: '', label: '', albums: '' };
  return {
    yearsActive: asTrimmedString(record.yearsActive),
    label: asTrimmedString(record.label),
    albums: asTrimmedString(record.albums),
  };
}

// Migrate a stored submission (as read from the blob) to the new shape for
// the response payload. Leaves the underlying blob untouched — the lazy
// migration only ever happens in memory, on read.
function migrateSubmissionForRead(record) {
  if (!record || typeof record !== 'object') return record;
  const location = resolveSubmissionLocation(record);
  const genre = resolveSubmissionGenre(record);
  const meta = resolveSubmissionMeta(record);
  const { scene, ...rest } = record;
  return { ...rest, ...location, genre, ...meta };
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

  const genre = normalizeGenre(payload.genre);
  if (genre.length > LIMITS.genre) return { ok: false, error: 'Genre is too long.' };

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
    genre,
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

// --- PR 3b migration bridge --------------------------------------------
//
// This is the trickiest file in PR 3b, so read this block before touching
// the POST handler below.
//
// Context: PR 3a moved the READ path (GET /api/bands) to Neon Postgres, but
// left this legacy Blobs endpoint (POST /.netlify/functions/bands) as the
// only write path, because the client's "Add your band" form still posts
// here. PR 3b adds the real Neon write path (bands_create.mjs at
// POST /api/bands) but we can't just delete this endpoint: any browser tab
// with cached JS from before this deploy is still going to POST here, and
// breaking that silently drops real submissions on the floor.
//
// So instead, this endpoint becomes a BRIDGE:
//   - If the caller is signed in (valid bearer token), we validate the
//     submission with the SAME validateSubmission() the client contract has
//     always relied on, then translate the resulting draft into a Neon
//     write via the shared createBandInNeon() helper (the same function
//     bands_create.mjs uses, so there is exactly one Neon write
//     implementation in this codebase, not two that can drift).
//   - If Neon reports a name conflict (the band already exists), we DO NOT
//     error out to the client — we fall back to the OLD blob write path.
//     This matches today's UX: a duplicate submission still gets queued and
//     shown to the user as "your submission is in", rather than surfacing a
//     409 that the old client-side success handler has no branch for.
//   - If the caller is anonymous (no bearer token), we skip Neon entirely
//     and keep the OLD blob write path. Anonymous submissions still work
//     exactly as before — signup is a soft nudge, not a hard gate.
//   - In EVERY case (Neon success, Neon conflict->blob fallback, or
//     anonymous->blob), we still write the SAME audit-log entry to the
//     'band-submissions-audit' blob store, so there remains ONE unified
//     audit trail regardless of which backend actually took the write. This
//     is why writeAuditEntry() is called from a single place after the
//     if/else below, not duplicated inside each branch.
//   - The HTTP response shape is kept IDENTICAL to the pre-PR-3b shape
//     ({ submission: {...draft...} }, 201) in every case, so the client's
//     existing success handler (which reads `submission` off the response)
//     keeps working unmodified. The Neon-backed band id is not surfaced
//     here; the client doesn't use it today, and adding it is out of scope
//     for the migration bridge (a future PR can widen this response once
//     the client is updated to consume it).
//
// Translation from draft -> Neon create-band input:
//   name = draft.band
//   members = draft.members.map(m => ({
//     name: m.member, instrument1: m.instrument, tenure: '',
//     weight: Number(m.relation) || 2, relation: 'member_of',
//   }))
// draft.members entries are always { member, instrument, relation } per
// validateSubmission()'s normalization, so there is no id-reference case
// here (legacy submissions never reference an existing member by id) —
// every member in a legacy submission is a new-by-name entry.
function draftToNeonCreateInput(draft, userId) {
  return {
    name: draft.band,
    city: draft.city,
    state: draft.state,
    country: draft.country,
    genre: draft.genre,
    years_active: draft.yearsActive,
    label: draft.label,
    albums: draft.albums,
    members: (draft.members || []).map(m => {
      const relationNum = Number(m.relation);
      return {
        name: m.member,
        instrument1: m.instrument || '',
        instrument2: '',
        tenure: '',
        weight: Number.isFinite(relationNum) && relationNum > 0 ? relationNum : 2,
        relation: 'member_of',
      };
    }),
    userId,
  };
}

// Attempt the Neon write for a signed-in submitter. Returns
// { landedInNeon: true } on success, or { landedInNeon: false } if we should
// fall back to the blob path (name conflict, or any Neon-side error — a DB
// outage must never block a legitimate submission, matching the existing
// fire-and-forget audit philosophy in this file).
async function tryNeonWrite(draft, user) {
  try {
    const sql = getSql();
    const input = draftToNeonCreateInput(draft, user.id);
    const result = await createBandInNeon(sql, input);
    if (result.conflict || result.missingMemberIds) {
      // Conflict: band already exists in Neon -> fall back to blob so the
      // submission is still queued/visible, matching current UX.
      // missingMemberIds: shouldn't happen (legacy drafts never reference
      // ids), but fail safe into the blob path rather than erroring the
      // whole request if it somehow does.
      return { landedInNeon: false };
    }
    return { landedInNeon: true, band: result.band };
  } catch (err) {
    console.error('bands.mjs: Neon write failed, falling back to blob path', err);
    return { landedInNeon: false };
  }
}

export default async function handler(req) {
  const store = getSubmissionsStore();

  if (req.method === 'GET') {
    // Admin-only audit-log browse mode. Returns the raw stream of
    // submission_accepted / submission_deleted events, newest first, so we
    // can reconcile the audit trail against the main submissions blob and
    // catch lost writes. Keyed off the same x-admin-token header the DELETE
    // handler uses. Public GETs (no header) fall through to the normal
    // submissions list.
    const url = new URL(req.url);
    if (url.searchParams.get('audit') === '1') {
      if (!isAdminAuthorized(req)) {
        return jsonResponse({ error: 'Unauthorized.' }, 401);
      }
      try {
        const auditStore = getAuditStore();
        const listing = await auditStore.list();
        // Fetch every event body in parallel. At current scale (event count ==
        // submission count, ~hundreds) this is trivially cheap; if the audit
        // store ever grows past ~10k entries, add ?limit / ?since filters.
        const entries = await Promise.all(
          (listing.blobs || []).map(async b => {
            try { return await auditStore.get(b.key, { type: 'json' }); }
            catch { return null; }
          })
        );
        // ISO timestamp prefix on each key => reverse-lexicographic sort is
        // newest-first without parsing dates.
        const sorted = entries.filter(Boolean).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
        return jsonResponse({ events: sorted, count: sorted.length });
      } catch (error) {
        return jsonResponse({ error: 'Could not read audit log.' }, 500);
      }
    }
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

    // --- Migration bridge: try Neon first if signed in, else/else-fallback
    // to the original blob write path. See the big comment block above
    // draftToNeonCreateInput() for the full rationale. `landedInNeon` tracks
    // which path actually took the write, purely so the audit-log entry
    // below can record it — the HTTP response shape is identical either way.
    let landedInNeon = false;
    const token = extractBearerToken(req);
    if (token && isDbConfigured()) {
      try {
        const sql = getSql();
        const user = await findUserByToken(sql, token);
        if (user) {
          const neonResult = await tryNeonWrite(result.draft, user);
          landedInNeon = neonResult.landedInNeon;
        }
        // Invalid/revoked token: fall through to the anonymous/blob path
        // rather than 401ing — this endpoint has never required auth, and a
        // stale cached token shouldn't suddenly block a submission.
      } catch (error) {
        console.error('bands.mjs: signed-in Neon redirect check failed, falling back to blob path', error);
        landedInNeon = false;
      }
    }

    if (!landedInNeon) {
      try {
        // Read-modify-write the single submissions blob. This is the ORIGINAL
        // write path, now reached when: the caller is anonymous, the DB isn't
        // configured, the token didn't resolve to a user, the band already
        // exists in Neon (conflict fallback), or the Neon write errored.
        const submissions = await readSubmissions(store);
        submissions.push(result.draft);
        await store.setJSON(BLOB_KEY, submissions);
      } catch (error) {
        return jsonResponse({ error: 'Could not save submission.' }, 500);
      }
    }

    // Unified audit trail: write the SAME audit entry regardless of which
    // backend (Neon or Blob) actually took the write, so admins reconciling
    // the audit log don't need to know which path a given submission used.
    // Fire-and-forget (writeAuditEntry swallows its own errors), but awaited
    // per Functions v2's no-orphan-promises-after-response rule.
    await writeAuditEntry('submission_accepted', result.draft.id, { ...result.draft, landedInNeon }, req);

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
      // Grab the doomed draft for the audit record before we drop it.
      const deleted = submissions.find(s => s?.id === id) || null;
      await store.setJSON(BLOB_KEY, remaining);
      // Audit AFTER the persistent write, same reasoning as POST: writing to
      // the audit store before the main store means a partial failure could
      // record a deletion that never actually happened.
      await writeAuditEntry('submission_deleted', id, deleted, req);
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
  extractClientMeta,
  parseLegacyScene,
  resolveSubmissionLocation,
  resolveSubmissionGenre,
  resolveSubmissionMeta,
  migrateSubmissionForRead,
  normalizeCountryCode,
  normalizeStateCode,
  normalizeGenre
};
