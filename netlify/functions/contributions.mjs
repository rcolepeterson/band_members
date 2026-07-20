// POST /api/contributions — record a user action against a band.
//
// Called by the client immediately after a successful add or edit action.
// The action itself (writing the band draft, updating the CSV, etc.) is
// handled by the existing bands.mjs function; this endpoint's sole job is
// attribution + counter increment.
//
// Why separate endpoints instead of folding attribution into bands.mjs:
//   - bands.mjs accepts anonymous writes today. When we gate that behind
//     signup in a later PR, it may end up merging with this. For now we
//     ship the attribution channel as an additive layer that doesn't touch
//     the existing submission flow, minimizing regression risk.
//   - Different failure modes: a DB outage should not block a legitimate
//     band submission. Keeping the endpoints separate means the client can
//     fire-and-forget the attribution call without blocking on it.
//
// Auth: bearer token in Authorization header. Anonymous callers get 401.
//
// Idempotency: not currently enforced. If the client retries after a
// timeout, we may record two contributions for one action. That's an
// acceptable tradeoff for now (counters overcount slightly under network
// pathology; the contributions log preserves both events with timestamps
// so we can dedupe offline if needed). If this becomes a problem, we'll
// add a client-generated event_id + unique constraint.

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

// PR 3b note: bands_create.mjs / bands_edit.mjs / bands_edit_members.mjs log
// their own contribution rows DIRECTLY inside the same sql.transaction() as
// the actual write (see those files). The client's edit UI should NOT also
// call this endpoint for edits — doing so would be a race (a client-fired
// contribution could land before, after, or independent of whether the
// underlying write actually succeeded, since the two HTTP calls aren't
// atomic with each other). This endpoint remains the attribution channel for
// the legacy add-band flow (index.html's logContribution('add_band', ...)
// after a successful postSharedSubmission) and stays generally reachable for
// any future direct-call use case, which is why 'edit_band_members' is added
// to VALID_ACTIONS below even though nothing calls this endpoint with it today.
//
// edit-person-bio PR: edit-person.mjs follows the exact same internal-logging
// pattern (see its header) and logs action='edit_person_bio' directly inside
// its own sql.transaction(), never through this endpoint. 'edit_person_bio'
// is added to VALID_ACTIONS for the same reachability reason as
// 'edit_band_members' above.
const VALID_ACTIONS = new Set(['add_band', 'edit_band', 'edit_band_members', 'edit_person_bio']);

async function parseJsonBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Best-effort sanitizer for the free-form metadata payload. Enforces
// (a) top-level is an object, (b) size cap, (c) JSON-serializable. We DON'T
// try to validate the semantic shape because different actions carry
// different metadata (add vs edit vs future actions); the app layer owns
// that schema.
function sanitizeMetadata(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return null;
  }
  // 8 KB is generous — realistic edit diffs are a few hundred bytes.
  if (serialized.length > 8 * 1024) return null;
  return input;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth first so anonymous callers can't infer DB config state.
  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  if (!isDbConfigured()) return dbUnavailable();

  const body = await parseJsonBody(req);
  if (!body || typeof body !== 'object') {
    return badRequest('request body must be JSON');
  }

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!VALID_ACTIONS.has(action)) {
    return badRequest("action must be one of 'add_band', 'edit_band', 'edit_band_members', or 'edit_person_bio'", { field: 'action' });
  }

  // band_id + band_name are optional — a "add" action may not have a stable
  // band_id yet (the client picks it), and downstream analytics can join on
  // band_name as a fallback. We accept them if provided.
  const band_id =
    typeof body.band_id === 'string' && body.band_id.length <= 200
      ? body.band_id.trim()
      : null;
  const band_name =
    typeof body.band_name === 'string' && body.band_name.length <= 200
      ? body.band_name.trim()
      : null;

  const metadata = sanitizeMetadata(body.metadata);
  if (metadata === null) {
    return badRequest('metadata must be a JSON object under 8KB', { field: 'metadata' });
  }

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    // Two writes, one transaction so a mid-write failure can't leave the
    // counter and log out of sync. Neon's HTTP driver supports `sql.transaction()`
    // taking an array of statements executed atomically.
    // edit_person_bio counts toward bands_edited too -- there's no separate
    // "members edited" counter on the users table, and a musician-bio edit
    // is conceptually the same kind of contribution as a band edit for
    // leaderboard/analytics purposes.
    const counterColumn = action === 'add_band' ? 'bands_added' : 'bands_edited';

    // Neon's serverless driver `sql.transaction` accepts an array of
    // pre-built queries. We need one INSERT (log) + one UPDATE (counter),
    // both within a single transaction for atomicity.
    const [inserted, updated] = await sql.transaction([
      sql`
        insert into contributions (user_id, action, band_id, band_name, metadata)
        values (${user.id}, ${action}, ${band_id}, ${band_name}, ${JSON.stringify(metadata)}::jsonb)
        returning id, created_at
      `,
      // Neon's tagged template can't parameterize a column name, so we
      // switch on the pre-validated column here. Safe: `counterColumn` is
      // constrained to one of two string literals above, not user input.
      counterColumn === 'bands_added'
        ? sql`update users set bands_added = bands_added + 1, updated_at = now()
              where id = ${user.id}
              returning bands_added, bands_edited`
        : sql`update users set bands_edited = bands_edited + 1, updated_at = now()
              where id = ${user.id}
              returning bands_added, bands_edited`,
    ]);

    return ok({
      contribution: {
        id: inserted[0].id,
        action,
        band_id,
        band_name,
        created_at: inserted[0].created_at,
      },
      counters: {
        bands_added: updated[0].bands_added,
        bands_edited: updated[0].bands_edited,
      },
    });
  } catch (err) {
    console.error('contributions failed', err);
    return serverError('contribution failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/contributions' };
