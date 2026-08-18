// PATCH /api/bands/:id/members — edit a band's membership roster (PR 3b
// write path): add members (existing-by-id or new-by-name), remove
// memberships, update tenure/weight/relation, rename a member (a
// member-level op that fans out across all of that person's bands), and
// overwrite a member's instruments.
//
// Route param extraction: same approach as bands_edit.mjs — prefer
// context.params.id, fall back to parsing the URL path.
//
// Auth: any signed-in user may edit any band's roster — no ownership model.
// Attribution is via `bands.edited_by` plus one contributions log entry per
// request (not per operation) capturing everything that changed.
//
// Every array in the request body is optional; the client only sends what
// actually changed. All operations for one request are applied in a single
// pass and logged as ONE contribution row so the audit trail reads as one
// coherent edit event rather than a flood of micro-events.
//
// Ordering rationale: we validate everything we can up front (band exists,
// membership ids belong to this band, referenced member ids exist, no name
// collisions) BEFORE writing anything, then perform all mutations across a
// minimal number of transactions. Because different operations need ids
// produced by earlier operations (e.g. an `add`-by-name member's freshly
// upserted id is needed for the membership insert), we follow the same
// two-transaction shape used in bands_create.mjs / seed_bands.mjs:
//   1. upsert-by-name members (for `add` entries with no id) + rename +
//      instrument overwrites — all row-level mutations that don't depend on
//      each other.
//   2. membership inserts (using ids resolved in step 1 or provided
//      directly), membership removals, membership updates, the
//      bands.edited_by touch, the contribution log entry, and the counter
//      increment.
//
// PR 4a note (passive cache invalidation): like bands_edit.mjs, this file
// makes no direct write to the `verifications` table. The bands.edited_by
// touch in step 2 goes through the same UPDATE-triggers-bands_set_updated_at
// path, so any roster edit here also bumps bands.updated_at and therefore
// silently invalidates that band's cached cross-check result (verify_band.mjs
// compares bands.updated_at against verifications.verified_at). No explicit
// invalidation code needed here.

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
  memberName: 120,
  instrument: 120,
  tenure: 200,
};

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractBandId(req, context) {
  const fromContext = context && context.params && typeof context.params.id === 'string' ? context.params.id.trim() : '';
  if (fromContext) return fromContext;
  try {
    const pathname = new URL(req.url).pathname;
    const match = /\/api\/bands\/([^/]+)\/members\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

export default async (req, context) => {
  if (req.method !== 'PATCH') return methodNotAllowed();

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

  const add = Array.isArray(body.add) ? body.add : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];
  const update = Array.isArray(body.update) ? body.update : [];
  const renameMember = Array.isArray(body.rename_member) ? body.rename_member : [];
  const memberInstruments = Array.isArray(body.member_instruments) ? body.member_instruments : [];

  if (!add.length && !remove.length && !update.length && !renameMember.length && !memberInstruments.length) {
    return badRequest('request body must include at least one of add/remove/update/rename_member/member_instruments');
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

    const bandRows = await sql`select id, name from bands where id = ${bandId} limit 1`;
    if (!bandRows.length) return notFound('no band with that id');
    const band = bandRows[0];

    // --- Validate `add` entries -------------------------------------------
    const addById = [];
    const addByName = [];
    for (const entry of add) {
      if (!entry || typeof entry !== 'object') continue;
      const id = asTrimmedString(entry.id);
      const name = asTrimmedString(entry.name);
      if (id) {
        addById.push({ id });
      } else if (name) {
        if (name.length > LIMITS.memberName) {
          return badRequest('member name is too long', { field: 'add' });
        }
        addByName.push({ name });
      }
      // silently skip fully-empty rows, matching bands_create's rule
    }
    if (addById.length) {
      const ids = addById.map(e => e.id);
      const found = await sql`select id from band_members where id = any(${ids}::uuid[])`;
      const foundSet = new Set(found.map(r => r.id));
      const missing = ids.filter(id => !foundSet.has(id));
      if (missing.length) {
        return badRequest('one or more referenced member ids do not exist', {
          field: 'add',
          missing_ids: missing,
        });
      }
    }

    // --- Validate `remove` ids belong to THIS band ------------------------
    const removeIds = remove.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
    if (removeIds.length) {
      const rows = await sql`select id, band_id from memberships where id = any(${removeIds}::bigint[])`;
      const byId = new Map(rows.map(r => [String(r.id), r]));
      for (const id of removeIds) {
        const row = byId.get(id);
        if (!row) return badRequest(`membership ${id} does not exist`, { field: 'remove' });
        if (String(row.band_id) !== String(bandId)) {
          return badRequest(`membership ${id} does not belong to this band`, { field: 'remove' });
        }
      }
    }

    // --- Validate `update` entries belong to THIS band --------------------
    const updateEntries = [];
    for (const entry of update) {
      if (!entry || typeof entry !== 'object') continue;
      const membershipId = asTrimmedString(entry.membership_id);
      if (!membershipId) return badRequest('update entries require a membership_id', { field: 'update' });
      updateEntries.push({
        membershipId,
        tenure: 'tenure' in entry ? asTrimmedString(entry.tenure).slice(0, LIMITS.tenure) : undefined,
        weight: 'weight' in entry ? (Number.isFinite(Number(entry.weight)) ? Math.trunc(Number(entry.weight)) : undefined) : undefined,
        relation: 'relation' in entry ? (asTrimmedString(entry.relation) || 'member_of') : undefined,
      });
    }
    if (updateEntries.length) {
      const ids = updateEntries.map(e => e.membershipId);
      const rows = await sql`select id, band_id from memberships where id = any(${ids}::bigint[])`;
      const byId = new Map(rows.map(r => [String(r.id), r]));
      for (const e of updateEntries) {
        const row = byId.get(e.membershipId);
        if (!row) return badRequest(`membership ${e.membershipId} does not exist`, { field: 'update' });
        if (String(row.band_id) !== String(bandId)) {
          return badRequest(`membership ${e.membershipId} does not belong to this band`, { field: 'update' });
        }
      }
    }

    // --- Validate `rename_member` entries + collisions ---------------------
    const renameEntries = [];
    for (const entry of renameMember) {
      if (!entry || typeof entry !== 'object') continue;
      const memberId = asTrimmedString(entry.member_id);
      const newName = asTrimmedString(entry.new_name);
      if (!memberId || !newName) {
        return badRequest('rename_member entries require member_id and new_name', { field: 'rename_member' });
      }
      if (newName.length > LIMITS.memberName) {
        return badRequest('new_name is too long', { field: 'rename_member' });
      }
      renameEntries.push({ memberId, newName });
    }
    const renameLog = [];
    if (renameEntries.length) {
      const ids = renameEntries.map(e => e.memberId);
      const existingMembers = await sql`select id, name from band_members where id = any(${ids}::uuid[])`;
      const existingById = new Map(existingMembers.map(r => [r.id, r]));
      for (const e of renameEntries) {
        const existingMember = existingById.get(e.memberId);
        if (!existingMember) return badRequest(`member ${e.memberId} does not exist`, { field: 'rename_member' });
        const collision = await sql`
          select id from band_members where lower(name) = ${e.newName.toLowerCase()} and id <> ${e.memberId} limit 1
        `;
        if (collision.length) {
          return badRequest(`another member already has the name "${e.newName}"`, {
            status: 409,
            error_code: 'name_collision',
            field: 'rename_member',
            existing_member_id: collision[0].id,
          });
        }
        renameLog.push({ member_id: e.memberId, old_name: existingMember.name, new_name: e.newName });
      }
    }

    // --- Validate `member_instruments` entries ------------------------------
    const instrumentEntries = [];
    for (const entry of memberInstruments) {
      if (!entry || typeof entry !== 'object') continue;
      const memberId = asTrimmedString(entry.member_id);
      if (!memberId) return badRequest('member_instruments entries require member_id', { field: 'member_instruments' });
      instrumentEntries.push({
        memberId,
        instrument1: 'instrument1' in entry ? asTrimmedString(entry.instrument1).slice(0, LIMITS.instrument) : undefined,
        instrument2: 'instrument2' in entry ? asTrimmedString(entry.instrument2).slice(0, LIMITS.instrument) : undefined,
      });
    }
    if (instrumentEntries.length) {
      const ids = instrumentEntries.map(e => e.memberId);
      const found = await sql`select id from band_members where id = any(${ids}::uuid[])`;
      const foundSet = new Set(found.map(r => r.id));
      const missing = ids.filter(id => !foundSet.has(id));
      if (missing.length) {
        return badRequest('one or more member_instruments member ids do not exist', {
          field: 'member_instruments',
          missing_ids: missing,
        });
      }
    }

    // --- Transaction 1: upsert-by-name adds, renames, instrument overwrites
    const byNameUpsertPromises = addByName.map(e => sql`
      insert into band_members (name)
      values (${e.name})
      on conflict (lower(name)) do update set name = band_members.name
      returning id, lower(name) as key
    `);
    const renamePromises = renameEntries.map(e => sql`
      update band_members set name = ${e.newName} where id = ${e.memberId} returning id
    `);
    const instrumentPromises = instrumentEntries.map(e => {
      if (e.instrument1 !== undefined && e.instrument2 !== undefined) {
        return sql`update band_members set instrument1 = ${e.instrument1 || null}, instrument2 = ${e.instrument2 || null} where id = ${e.memberId} returning id, instrument1, instrument2`;
      }
      if (e.instrument1 !== undefined) {
        return sql`update band_members set instrument1 = ${e.instrument1 || null} where id = ${e.memberId} returning id, instrument1, instrument2`;
      }
      return sql`update band_members set instrument2 = ${e.instrument2 || null} where id = ${e.memberId} returning id, instrument1, instrument2`;
    });

    const step1Queries = [...byNameUpsertPromises, ...renamePromises, ...instrumentPromises];
    const step1Results = step1Queries.length ? await sql.transaction(step1Queries) : [];

    const byNameResults = step1Results.slice(0, byNameUpsertPromises.length);
    const renameResults = step1Results.slice(byNameUpsertPromises.length, byNameUpsertPromises.length + renamePromises.length);
    const instrumentResults = step1Results.slice(byNameUpsertPromises.length + renamePromises.length);

    // Resolve every `add` entry (by-id + by-name) to a concrete member id.
    const resolvedAdds = [
      ...addById.map(e => ({ memberId: e.id, name: null })),
      ...addByName.map((e, i) => ({ memberId: byNameResults[i]?.[0]?.id || null, name: e.name })),
    ];

    // --- Detect already-linked memberships for `add` (skip duplicates) ----
    const addMemberIds = resolvedAdds.map(a => a.memberId).filter(Boolean);
    let alreadyLinkedSet = new Set();
    if (addMemberIds.length) {
      const existingMemberships = await sql`
        select member_id from memberships where band_id = ${bandId} and member_id = any(${addMemberIds}::uuid[])
      `;
      alreadyLinkedSet = new Set(existingMemberships.map(r => r.member_id));
    }

    // --- Transaction 2: memberships (add/remove/update) + band touch +
    //     contribution log + counter increment -----------------------------
    const membershipInsertPromises = [];
    const alreadyLinked = [];
    const addedForLog = [];
    for (const a of resolvedAdds) {
      if (!a.memberId) continue;
      if (alreadyLinkedSet.has(a.memberId)) {
        alreadyLinked.push(a.memberId);
        continue;
      }
      membershipInsertPromises.push(sql`
        insert into memberships (band_id, member_id, weight, relation)
        values (${bandId}, ${a.memberId}, 2, 'member_of')
        on conflict (band_id, member_id) do nothing
        returning id, band_id, member_id, tenure, weight, relation
      `);
      addedForLog.push(a.name || a.memberId);
    }

    const removePromises = removeIds.map(id => sql`delete from memberships where id = ${id}::bigint returning id`);

    const updatePromises = updateEntries.map(e => {
      const sets = [];
      if (e.tenure !== undefined) sets.push(sql`tenure = ${e.tenure || null}`);
      if (e.weight !== undefined) sets.push(sql`weight = ${e.weight}`);
      if (e.relation !== undefined) sets.push(sql`relation = ${e.relation}`);
      if (!sets.length) return sql`select id, band_id, member_id, tenure, weight, relation from memberships where id = ${e.membershipId}::bigint`;
      const setClause = sets.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`));
      return sql`update memberships set ${setClause} where id = ${e.membershipId}::bigint returning id, band_id, member_id, tenure, weight, relation`;
    });

    const metadata = {
      added: addedForLog,
      already_linked: alreadyLinked,
      removed: removeIds,
      updated: updateEntries.map(e => e.membershipId),
      renamed: renameLog,
      instrument_changes: instrumentEntries,
    };

    const bandTouchPromise = sql`update bands set edited_by = ${user.id} where id = ${bandId}`;
    const contributionPromise = sql`
      insert into contributions (user_id, action, band_id, band_name, metadata)
      values (${user.id}, 'edit_band_members', ${bandId}, ${band.name}, ${JSON.stringify(metadata)}::jsonb)
    `;
    const counterPromise = sql`update users set bands_edited = bands_edited + 1, updated_at = now() where id = ${user.id}`;

    const step2Queries = [
      ...membershipInsertPromises,
      ...removePromises,
      ...updatePromises,
      bandTouchPromise,
      contributionPromise,
      counterPromise,
    ];
    const step2Results = await sql.transaction(step2Queries);

    const addedRows = step2Results.slice(0, membershipInsertPromises.length).filter(r => r && r.length).map(r => r[0]);
    const removedRows = step2Results.slice(
      membershipInsertPromises.length,
      membershipInsertPromises.length + removePromises.length
    );
    const removedIds = removedRows.filter(r => r && r.length).map(r => r[0].id);
    const updatedRows = step2Results.slice(
      membershipInsertPromises.length + removePromises.length,
      membershipInsertPromises.length + removePromises.length + updatePromises.length
    ).filter(r => r && r.length).map(r => r[0]);

    return ok({
      added: addedRows,
      already_linked: alreadyLinked,
      removed: removedIds,
      updated: updatedRows,
      renames: renameLog,
      instrument_changes: instrumentResults.filter(r => r && r.length).map(r => r[0]),
    });
  } catch (err) {
    console.error('bands_edit_members failed', err);
    return serverError('could not edit band members', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/bands/:id/members', method: 'PATCH' };
