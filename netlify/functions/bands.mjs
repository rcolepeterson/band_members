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

// Field limits — reject obviously malicious/oversized input server-side too,
// mirroring the client validation.
const LIMITS = {
  band: 120,
  scene: 80,
  member: 120,
  instrument: 120,
  bio: 2000,
  meta: 200, // yearsActive / label / albums
  maxMembers: 50,
  maxBodyBytes: 64 * 1024 // 64 KB is far more than a legitimate submission needs
};

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

  const scene = asTrimmedString(payload.scene) || 'Seattle';
  if (scene.length > LIMITS.scene) return { ok: false, error: 'Scene name is too long.' };

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
    scene,
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
  const store = getStore(STORE_NAME);

  if (req.method === 'GET') {
    try {
      const submissions = await readSubmissions(store);
      return jsonResponse({ submissions });
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

  return jsonResponse({ error: 'Method not allowed.' }, 405);
}

// Exported for isolated unit testing of the validation logic (see repo verify step).
export { validateSubmission, LIMITS };
