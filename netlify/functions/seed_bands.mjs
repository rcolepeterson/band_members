// POST /api/seed-bands — one-time (but idempotent, re-runnable) import of
// the CSV graph + existing Netlify Blobs band submissions into the new
// Postgres bands / band_members / memberships tables (PR 3a).
//
// Why the client POSTs the CSV rows instead of the function reading the CSV
// off disk: Netlify Functions don't reliably have file-system access to the
// built static site's artifacts (the CSV ships as a static asset, not a
// function dependency), so the caller (an admin, via a small script or the
// browser console) reads the CSV client-side and POSTs the parsed rows as
// JSON. This keeps the function itself dependency-free and avoids bundling
// concerns.
//
// Semantics (fill-missing, never overwrite):
//   - Upsert a band by lower(name). If it doesn't exist, insert it with
//     csv_origin=true (for CSV rows) or csv_origin=false (for blob
//     submissions) and whatever fields the row provides. If it already
//     exists, ONLY fill in columns that are currently null/empty — never
//     clobber a non-empty value. This matters because re-running the seed
//     (or seeding CSV rows after blob submissions, or vice versa) must not
//     stomp on richer data one source already contributed.
//   - Same fill-missing upsert for members, keyed by lower(name).
//   - Upsert the membership row by (band_id, member_id): same fill-missing
//     semantics for tenure; weight/relation keep their existing value once
//     set (see buildMembershipUpsert below) rather than flapping between
//     re-runs with different input order.
//
// Idempotency: safe to re-run. Because both the band/member upserts and the
// membership upsert are fill-missing (COALESCE against the existing value,
// not a blind overwrite), running this endpoint twice with the same input
// leaves the DB in the same state as running it once.
//
// Transaction shape: Neon's serverless driver's sql.transaction() is
// explicitly NON-interactive (see its type docs) — it takes an array of
// already-built query promises (or a plain, non-async callback that
// *returns* such an array) and executes them as one atomic unit. You cannot
// await an intermediate result inside transaction() and use it to build a
// later query in the same call. Because the membership upsert needs the
// band_id/member_id produced by the band/member upserts, we run two
// transactions:
//   1. sql.transaction([...band and member upserts...]) — every band and
//      member row upserted together, atomically, returning their ids.
//   2. sql.transaction([...membership upserts...]) — built from the ids
//      collected in step 1, atomically.
// Each step is atomic on its own; the whole endpoint is idempotent, so a
// failure between step 1 and step 2 just means re-running the endpoint
// finishes the job with no risk of duplicating data.

import { getStore } from '@netlify/blobs';
import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

// Same store/key as bands.mjs's BLOB_KEY / STORE_NAME. Duplicated here
// (rather than imported) because bands.mjs does not export these constants
// and PR 3a is explicitly told not to modify bands.mjs.
const BLOB_STORE_NAME = 'band-submissions';
const BLOB_KEY = 'submissions';

function asTrimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

// --- CSV row normalization --------------------------------------------------
// Mirrors buildMasterGraph()'s field reads in index.html (see PR description
// for the exact line reference). One CSV row = one band<->member membership.
function normalizeCsvRow(row) {
  if (!row || typeof row !== 'object') return null;
  const bandName = asTrimmedString(row.source);
  const memberName = asTrimmedString(row.target);
  if (!bandName || !memberName) return null;

  const instrument1 = asTrimmedString(row['Instrument 1'] || row['Intrument 1']);
  const instrument2 = asTrimmedString(row['Instrument 2'] || row['Intrument 2']);
  const memberYearsActive = asTrimmedString(
    row.memberYearsActive || row['Member Years Active'] || row.member_years_active ||
    row.tenure || row.Tenure
  );
  const personYearsActive = asTrimmedString(
    row.personYearsActive || row['Person Years Active'] || row.person_years_active
  );
  const bandYearsActive = asTrimmedString(row.yearsActive || row['Years Active'] || row.years_active);

  const weightNum = Number(row.weight);
  const weight = Number.isFinite(weightNum) && weightNum > 0 ? Math.trunc(weightNum) : 1;

  return {
    band: {
      name: bandName,
      city: asTrimmedString(row.city),
      state: asTrimmedString(row.state),
      country: asTrimmedString(row.country),
      genre: asTrimmedString(row.genre),
      years_active: bandYearsActive,
      label: '',
      albums: '',
      csv_origin: true,
    },
    member: {
      name: memberName,
      city: asTrimmedString(row.city),
      state: asTrimmedString(row.state),
      country: asTrimmedString(row.country),
      instrument1,
      instrument2,
      years_active: personYearsActive,
    },
    membership: {
      tenure: memberYearsActive,
      weight,
      relation: asTrimmedString(row.relation_type || row.relationship) || 'member_of',
    },
  };
}

// --- Blob submission normalization ------------------------------------------
// A submission draft (see bands.mjs's validateSubmission()) has shape:
// { band, members: [{ member, instrument, relation }], city, state, country,
//   genre, yearsActive, label, albums, bio }. One draft can carry multiple
// members, so it expands into one entry per member (same shape as
// normalizeCsvRow's return, minus the CSV-only fields).
function normalizeBlobSubmission(draft) {
  if (!draft || typeof draft !== 'object') return [];
  const bandName = asTrimmedString(draft.band);
  if (!bandName) return [];

  const members = Array.isArray(draft.members) ? draft.members : [];
  const band = {
    name: bandName,
    city: asTrimmedString(draft.city),
    state: asTrimmedString(draft.state),
    country: asTrimmedString(draft.country),
    genre: asTrimmedString(draft.genre),
    years_active: asTrimmedString(draft.yearsActive),
    label: asTrimmedString(draft.label),
    albums: asTrimmedString(draft.albums),
    csv_origin: false,
  };

  return members
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const memberName = asTrimmedString(entry.member);
      if (!memberName) return null;
      const relationNum = Number(entry.relation);
      return {
        band,
        member: {
          name: memberName,
          city: band.city,
          state: band.state,
          country: band.country,
          instrument1: asTrimmedString(entry.instrument),
          instrument2: '',
          years_active: '',
        },
        membership: {
          tenure: '',
          weight: Number.isFinite(relationNum) && relationNum > 0 ? Math.trunc(relationNum) : 1,
          relation: 'member_of',
        },
      };
    })
    .filter(Boolean);
}

// Fill-missing upsert for one band. `on conflict (lower(name))` targets the
// bands_name_lower_idx unique index created in migrate.mjs.
function buildBandUpsert(sql, band) {
  return sql`
    insert into bands (name, city, state, country, genre, years_active, label, albums, csv_origin)
    values (
      ${band.name}, ${band.city || null}, ${band.state || null}, ${band.country || null},
      ${band.genre || null}, ${band.years_active || null}, ${band.label || null}, ${band.albums || null},
      ${band.csv_origin}
    )
    on conflict (lower(name)) do update set
      city = coalesce(nullif(bands.city, ''), excluded.city),
      state = coalesce(nullif(bands.state, ''), excluded.state),
      country = coalesce(nullif(bands.country, ''), excluded.country),
      genre = coalesce(nullif(bands.genre, ''), excluded.genre),
      years_active = coalesce(nullif(bands.years_active, ''), excluded.years_active),
      label = coalesce(nullif(bands.label, ''), excluded.label),
      albums = coalesce(nullif(bands.albums, ''), excluded.albums)
    returning id, lower(name) as key
  `;
}

// Fill-missing upsert for one member. `on conflict (lower(name))` targets the
// band_members_name_lower_idx unique index created in migrate.mjs.
function buildMemberUpsert(sql, member) {
  return sql`
    insert into band_members (name, city, state, country, instrument1, instrument2, years_active)
    values (
      ${member.name}, ${member.city || null}, ${member.state || null}, ${member.country || null},
      ${member.instrument1 || null}, ${member.instrument2 || null}, ${member.years_active || null}
    )
    on conflict (lower(name)) do update set
      city = coalesce(nullif(band_members.city, ''), excluded.city),
      state = coalesce(nullif(band_members.state, ''), excluded.state),
      country = coalesce(nullif(band_members.country, ''), excluded.country),
      instrument1 = coalesce(nullif(band_members.instrument1, ''), excluded.instrument1),
      instrument2 = coalesce(nullif(band_members.instrument2, ''), excluded.instrument2),
      years_active = coalesce(nullif(band_members.years_active, ''), excluded.years_active)
    returning id, lower(name) as key
  `;
}

// Fill-missing upsert for one membership, keyed by (band_id, member_id) —
// the unique constraint from migrate.mjs. `tenure` fills in if missing;
// `weight`/`relation` are left at their existing value once a row exists
// (rather than being overwritten by whichever re-run happens to run last),
// matching the "never clobber existing data" rule.
function buildMembershipUpsert(sql, bandId, memberId, membership) {
  return sql`
    insert into memberships (band_id, member_id, tenure, weight, relation)
    values (${bandId}, ${memberId}, ${membership.tenure || null}, ${membership.weight}, ${membership.relation})
    on conflict (band_id, member_id) do update set
      tenure = coalesce(nullif(memberships.tenure, ''), excluded.tenure)
    returning id
  `;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('request body must be JSON');
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.rows)) {
    return badRequest('body must be { rows: [...] }', { field: 'rows' });
  }

  const sql = getSql();

  // Normalize CSV rows into band/member/membership entries.
  const csvEntries = body.rows.map(normalizeCsvRow).filter(Boolean);

  // Pull existing blob submissions (best-effort — a blob read failure
  // shouldn't block the CSV import, since that's the bulk of the data).
  let blobEntries = [];
  let blobSubmissionCount = 0;
  try {
    const store = getStore({ name: BLOB_STORE_NAME, consistency: 'strong' });
    const existing = await store.get(BLOB_KEY, { type: 'json' });
    const submissions = Array.isArray(existing) ? existing : [];
    blobSubmissionCount = submissions.length;
    blobEntries = submissions.flatMap(normalizeBlobSubmission);
  } catch (err) {
    console.error('seed_bands: could not read blob submissions (continuing with CSV only)', err);
  }

  const allEntries = [...csvEntries, ...blobEntries];
  if (allEntries.length === 0) {
    return ok({
      counts: {
        bands_upserted: 0,
        members_upserted: 0,
        memberships_upserted: 0,
        blob_submissions_imported: blobSubmissionCount,
      },
    });
  }

  try {
    // Dedupe bands/members by lower(name) before building the query arrays.
    // This isn't required for correctness (the upsert is idempotent even
    // with duplicates), but avoids sending hundreds of redundant statements
    // for bands/members that appear in many rows (which every CSV band with
    // >1 member does).
    //
    // While deduping, we MERGE fill-missing across the different rows that
    // reference the same band or member. Example: Mark Arm appears in the
    // CSV first via Green River (instrument2=''), and later via Mudhoney
    // (instrument2='guitar'). If we only kept the first row we'd drop the
    // guitar. Merging picks the first non-empty value for each field across
    // all rows mentioning that member/band, which matches the semantics of
    // the ON CONFLICT ... COALESCE(nullif(...)) SQL upsert but does it in
    // memory before we send anything to the DB.
    function mergeFillMissing(existing, incoming) {
      const merged = { ...existing };
      for (const key of Object.keys(incoming)) {
        const cur = merged[key];
        const next = incoming[key];
        const curEmpty = cur === null || cur === undefined || cur === '';
        const nextEmpty = next === null || next === undefined || next === '';
        if (curEmpty && !nextEmpty) merged[key] = next;
      }
      return merged;
    }
    const bandsByKey = new Map();
    const membersByKey = new Map();
    for (const entry of allEntries) {
      const bandKey = entry.band.name.toLowerCase();
      const memberKey = entry.member.name.toLowerCase();
      if (bandsByKey.has(bandKey)) {
        bandsByKey.set(bandKey, mergeFillMissing(bandsByKey.get(bandKey), entry.band));
      } else {
        bandsByKey.set(bandKey, entry.band);
      }
      if (membersByKey.has(memberKey)) {
        membersByKey.set(memberKey, mergeFillMissing(membersByKey.get(memberKey), entry.member));
      } else {
        membersByKey.set(memberKey, entry.member);
      }
    }

    // --- Transaction 1: upsert every distinct band and member -------------
    const bandUpsertPromises = Array.from(bandsByKey.values()).map(band => buildBandUpsert(sql, band));
    const memberUpsertPromises = Array.from(membersByKey.values()).map(member => buildMemberUpsert(sql, member));

    const [bandResultSets, memberResultSets] = await Promise.all([
      bandUpsertPromises.length ? sql.transaction(bandUpsertPromises) : Promise.resolve([]),
      memberUpsertPromises.length ? sql.transaction(memberUpsertPromises) : Promise.resolve([]),
    ]);

    const bandIdByKey = new Map();
    bandResultSets.forEach(rows => {
      const row = rows[0];
      if (row) bandIdByKey.set(row.key, row.id);
    });
    const memberIdByKey = new Map();
    memberResultSets.forEach(rows => {
      const row = rows[0];
      if (row) memberIdByKey.set(row.key, row.id);
    });

    // --- Transaction 2: upsert every membership using the ids above -------
    // Dedupe by (band_id, member_id) for the same reason as above.
    const membershipByKey = new Map();
    for (const entry of allEntries) {
      const bandId = bandIdByKey.get(entry.band.name.toLowerCase());
      const memberId = memberIdByKey.get(entry.member.name.toLowerCase());
      if (!bandId || !memberId) continue;
      const key = `${bandId}::${memberId}`;
      if (!membershipByKey.has(key)) {
        membershipByKey.set(key, { bandId, memberId, membership: entry.membership });
      }
    }

    const membershipUpsertPromises = Array.from(membershipByKey.values()).map(({ bandId, memberId, membership }) =>
      buildMembershipUpsert(sql, bandId, memberId, membership)
    );

    if (membershipUpsertPromises.length) {
      await sql.transaction(membershipUpsertPromises);
    }

    return ok({
      counts: {
        bands_upserted: bandIdByKey.size,
        members_upserted: memberIdByKey.size,
        memberships_upserted: membershipByKey.size,
        blob_submissions_imported: blobSubmissionCount,
      },
    });
  } catch (err) {
    console.error('seed_bands failed', err);
    return serverError('seed failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/seed-bands' };
