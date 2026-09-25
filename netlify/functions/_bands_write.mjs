// Shared "create a band in Neon" write path, used by both bands_create.mjs
// (the new POST /api/bands endpoint) and bands.mjs's legacy POST branch
// (the migration bridge — see the big comment block in bands.mjs).
//
// Why factor this out instead of duplicating: bands.mjs's legacy POST needs
// to perform EXACTLY the same DB write bands_create.mjs does (insert band +
// upsert members + insert memberships + log one contribution + bump the
// counter), just fed from a different input shape (the old submission draft
// vs. the new { name, members: [...] } body). Duplicating the transaction
// logic in two files would be a correctness hazard: the two copies WILL
// drift, and a future schema change would need to be applied twice. Instead,
// both callers normalize their own input into the same internal shape and
// call `createBandInNeon()`.
//
// This module does NOT do request/response handling (no Response objects,
// no method checks) — it's pure DB logic so it can be called from either
// endpoint's request lifecycle. Callers are responsible for auth, body
// validation shape, and translating errors into HTTP responses.

// Input shape expected by createBandInNeon():
// {
//   name, city, state, country, genre, years_active, label, albums,
//   members: [ { id?, name?, instrument1, instrument2, tenure, weight, relation } ],
//   userId,
// }
//
// Returns one of:
//   { conflict: true, existingBandId, existingName, existingCity, existingCountry }
//   { missingMemberIds: [...] }
//   { ok: true, band, memberIds, membershipsCreated }

// ---------------------------------------------------------------------------
// Band identity: name + city (+country).
//
// Two records with the same band name are the SAME band only when their
// locations also match. Same name + different city (Skid Row in Toms River,
// NJ vs. Skid Row in Aberdeen, WA) are different bands and must both be
// creatable. This is the shared rule — index.html mirrors it for the
// add-band dialog's client-side duplicate check (see the "Mirrors
// _bands_write.mjs" comment there), so keep the two in sync.
// ---------------------------------------------------------------------------

// Lowercase, drop apostrophes, fold every other non-alphanumeric run to a
// single space: "Tom's River, NJ" and "Toms River NJ" become "toms river nj".
export function normalizeIdentityKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// City is a soft attribute: users type "Seattle" where the data says
// "Seattle, WA". Two cities match when the smaller token set is fully
// contained in the larger one. A blank city on either side is conservative
// (treated as a match) so missing data can never silently fork a band.
export function citiesMatch(a, b) {
  const ka = normalizeIdentityKey(a);
  const kb = normalizeIdentityKey(b);
  if (!ka || !kb) return true;
  const ta = ka.split(' ');
  const tb = kb.split(' ');
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  return small.every((token) => bigSet.has(token));
}

// Full identity comparison for { name, city, country } shapes.
export function sameBandIdentity(a, b) {
  if (!a || !b) return false;
  if (normalizeIdentityKey(a.name) !== normalizeIdentityKey(b.name)) return false;
  const ca = normalizeIdentityKey(a.country);
  const cb = normalizeIdentityKey(b.country);
  if (ca && cb && ca !== cb) return false;
  return citiesMatch(a.city, b.city);
}

export async function createBandInNeon(sql, input) {
  const { name, city, state, country, genre, years_active, label, albums, members, userId } = input;
  // Phase 3: optional { platform: url } map, already validated by the
  // caller (bands_create.mjs). Written in transaction 2 so the band and
  // its links commit atomically. Absent for seed_bands.mjs callers.
  const links = input.links || {};

  // Conflict check: same normalized name AND same location. A name match in
  // a different city is a different band — allowed through.
  const candidates = await sql`select id, name, city, country from bands where lower(name) = ${name.toLowerCase()}`;
  const clash = candidates.find((row) =>
    sameBandIdentity({ name, city, country }, { name: row.name, city: row.city, country: row.country })
  );
  if (clash) {
    return {
      conflict: true,
      existingBandId: clash.id,
      existingName: clash.name,
      existingCity: clash.city,
      existingCountry: clash.country,
    };
  }

  // Validate any member `id` references up front so we can fail cleanly
  // before building a transaction array.
  const idRefs = members.filter(m => m.id).map(m => m.id);
  if (idRefs.length) {
    const found = await sql`select id from band_members where id = any(${idRefs}::uuid[])`;
    const foundSet = new Set(found.map(r => r.id));
    const missing = idRefs.filter(id => !foundSet.has(id));
    if (missing.length) {
      return { missingMemberIds: missing };
    }
  }

  // --- Transaction 1: insert the band + upsert any new-by-name members ---
  const bandInsertPromise = sql`
    insert into bands (name, city, state, country, genre, years_active, label, albums, csv_origin, added_by, edited_by)
    values (${name}, ${city || null}, ${state || null}, ${country || null}, ${genre || null},
            ${years_active || null}, ${label || null}, ${albums || null}, false, ${userId}, ${userId})
    returning id, name, city, state, country, genre, years_active, label, albums, csv_origin, added_by, edited_by, created_at, updated_at
  `;

  const newByNameEntries = members.filter(m => !m.id && m.name);
  const memberUpsertPromises = newByNameEntries.map(m => sql`
    insert into band_members (name, instrument1, instrument2)
    values (${m.name}, ${m.instrument1 || null}, ${m.instrument2 || null})
    on conflict (lower(name)) do update set
      instrument1 = coalesce(nullif(band_members.instrument1, ''), excluded.instrument1),
      instrument2 = coalesce(nullif(band_members.instrument2, ''), excluded.instrument2)
    returning id, lower(name) as key
  `);

  const [bandRows, ...memberResultSets] = await sql.transaction([bandInsertPromise, ...memberUpsertPromises]);
  const band = bandRows[0];

  const resolvedMemberIds = [];
  let newByNameCursor = 0;
  for (const m of members) {
    if (m.id) {
      resolvedMemberIds.push(m.id);
    } else if (m.name) {
      const rows = memberResultSets[newByNameCursor++];
      resolvedMemberIds.push(rows && rows[0] ? rows[0].id : null);
    } else {
      resolvedMemberIds.push(null);
    }
  }

  // --- Transaction 2: memberships + contribution + counter increment -----
  const membershipPromises = [];
  const memberNamesForLog = [];
  for (let i = 0; i < members.length; i++) {
    const memberId = resolvedMemberIds[i];
    if (!memberId) continue;
    const m = members[i];
    membershipPromises.push(sql`
      insert into memberships (band_id, member_id, tenure, weight, relation)
      values (${band.id}, ${memberId}, ${m.tenure || null}, ${m.weight}, ${m.relation})
      on conflict (band_id, member_id) do nothing
      returning id, band_id, member_id, tenure, weight, relation
    `);
    memberNamesForLog.push(m.name || memberId);
  }

  const metadata = { member_count: memberNamesForLog.length, member_names: memberNamesForLog };
  const contributionPromise = sql`
    insert into contributions (user_id, action, band_id, band_name, metadata)
    values (${userId}, 'add_band', ${band.id}, ${band.name}, ${JSON.stringify(metadata)}::jsonb)
    returning id
  `;
  const counterPromise = sql`
    update users set bands_added = bands_added + 1, updated_at = now()
    where id = ${userId}
    returning bands_added
  `;

  // Phase 3: link upserts join the same atomic transaction. Non-empty
  // values upsert; a null value would delete — no rows exist yet on
  // create, so nulls are filtered here (defensive; the caller omits them).
  const linkPromises = Object.entries(links)
    .filter(([, url]) => url)
    .map(([platform, url]) => sql`
      insert into band_links (band_id, platform, url)
      values (${band.id}, ${platform}, ${url})
      on conflict (band_id, platform)
      do update set url = excluded.url, updated_at = now()
    `);

  const txResults = membershipPromises.length
    ? await sql.transaction([...membershipPromises, ...linkPromises, contributionPromise, counterPromise])
    : await sql.transaction([...linkPromises, contributionPromise, counterPromise]);

  const membershipResultSets = membershipPromises.length ? txResults.slice(0, membershipPromises.length) : [];
  const membershipsCreated = membershipResultSets.filter(rows => rows && rows.length).length;

  return {
    ok: true,
    band,
    memberIds: resolvedMemberIds.filter(Boolean),
    membershipsCreated,
  };
}
