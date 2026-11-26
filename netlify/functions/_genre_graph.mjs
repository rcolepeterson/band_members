// Shared logic for the Genre Graph live-pull endpoints
// (genre_graph.mjs, genre_graph_band.mjs, genre_graph_portal.mjs,
// genre_graph_apply.mjs).
//
// The verified genre layer lives in band_genre_data (one row per band,
// keyed by band UUID — never by name; same-name bands stay distinct, the
// Sweet Water collision is the cautionary tale). The bands table's own
// genre/years_active columns are untouched: they are one source
// ("existing_db") inside the provenance record, not the display layer.
//
// Everything here is pure or takes `sql` as a parameter so tests can drive
// it against pglite with the real schema (same pattern as
// _graph_cache.mjs and scripts/apply-enrichments.mjs).

// Tables whose changes invalidate the /api/genre-graph payload: bands for
// name/city/country, band_genre_data for the genre layer itself. Registered
// in _graph_cache.mjs's KNOWN_TABLES allowlist.
export const GENRE_TABLES = ['bands', 'band_genre_data'];

// Blob key prefix for the genre payload in the shared graph-cache store.
export const GENRE_CACHE_PREFIX = 'api-genre-graph';

// The four agreement tiers from the cross-validation design (Aaron lock
// 2026-11-23): solid = 3+ independent sources, good = 2, provisional = 1,
// conflict = sources disagree (surfaced, never silently picked).
export const GENRE_TIERS = ['solid', 'good', 'provisional', 'conflict'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Debut year is computed at read time, never stored: first album year,
// formation year as fallback (Aaron lock 2026-11-24 — the album finalizes
// the sound; formation is context). Storing both years separately means
// the rule can be re-applied without re-importing anything.
export function debutYearOf(row) {
  if (!row) return null;
  if (row.first_album_year != null) return row.first_album_year;
  if (row.formation_year != null) return row.formation_year;
  return null;
}

// ---------------------------------------------------------------------------
// Apply-path validation
//
// The apply endpoint accepts rows in the band_genre_data column shape (the
// payload generator in scripts/apply-genre-data.mjs maps merge records to
// this shape). Validation is deliberately permissive about VALUES (the
// merge file is the reviewed surface; junk years like the 1912 collision
// were already nulled upstream by the collision sweep) and strict about
// SHAPE (types, UUID, tier vocabulary) so a malformed payload can't write
// garbage columns.
// ---------------------------------------------------------------------------

function cleanYear(v, field, errors) {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 1800 || v > 2100) {
    errors.push(`${field} must be an integer year 1800-2100 or null`);
    return null;
  }
  return v;
}

function cleanText(v, field, errors, maxLen = 500) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    errors.push(`${field} must be a string or null`);
    return null;
  }
  return v.slice(0, maxLen);
}

function cleanJsonArray(v, field, errors) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  return v;
}

// Normalize one incoming apply row. Returns { row } on success or
// { errors: [...] } listing every shape problem found.
export function normalizeGenreRow(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['row must be an object'] };
  }
  if (!isUuid(input.band_id)) {
    errors.push('band_id must be a UUID');
  }
  const tier = cleanText(input.genre_tier, 'genre_tier', errors, 40);
  if (tier !== null && !GENRE_TIERS.includes(tier)) {
    errors.push(`genre_tier must be one of ${GENRE_TIERS.join('/')}`);
  }
  // first_album_tier deliberately does NOT share the genre-tier vocabulary:
  // the merge file carries its own first-album confidence words
  // (provisional / high / review / dropped_collision / aaron_correction).
  // It is stored verbatim as provenance, length-capped only.
  const faTier = cleanText(input.first_album_tier, 'first_album_tier', errors, 60);
  let agreement = input.genre_agreement;
  if (agreement === undefined) agreement = null;
  if (agreement !== null && (!Number.isInteger(agreement) || agreement < 0 || agreement > 50)) {
    errors.push('genre_agreement must be an integer 0-50 or null');
    agreement = null;
  }
  const provenance = input.provenance;
  if (provenance !== null && provenance !== undefined &&
      (typeof provenance !== 'object' || Array.isArray(provenance))) {
    errors.push('provenance must be an object');
  }
  const row = {
    band_id: typeof input.band_id === 'string' ? input.band_id.toLowerCase() : input.band_id,
    primary_genre: cleanText(input.primary_genre, 'primary_genre', errors, 200),
    genre_tier: tier,
    genre_sources: cleanJsonArray(input.genre_sources, 'genre_sources', errors),
    genre_agreement: agreement,
    fringe_genres: cleanJsonArray(input.fringe_genres, 'fringe_genres', errors),
    first_album_year: cleanYear(input.first_album_year, 'first_album_year', errors),
    first_album_title: cleanText(input.first_album_title, 'first_album_title', errors, 500),
    first_album_source: cleanText(input.first_album_source, 'first_album_source', errors, 100),
    first_album_tier: faTier,
    formation_year: cleanYear(input.formation_year, 'formation_year', errors),
    end_year: cleanYear(input.end_year, 'end_year', errors),
    has_conflict: input.has_conflict === true,
    provenance: provenance && typeof provenance === 'object' ? provenance : {},
  };
  if (errors.length) return { errors };
  return { row };
}

// Column list for upserts/diffs, in table order (minus timestamps).
export const GENRE_COLUMNS = [
  'band_id', 'primary_genre', 'genre_tier', 'genre_sources', 'genre_agreement',
  'fringe_genres', 'first_album_year', 'first_album_title', 'first_album_source',
  'first_album_tier', 'formation_year', 'end_year', 'has_conflict', 'provenance',
];

// Structural equality for one stored row vs one incoming row, over the
// payload columns. JSONB comes back parsed from both Neon and pglite, so a
// canonical stringify is enough (key order in jsonb objects is not
// preserved by Postgres — sort keys before comparing).
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function genreRowEquals(a, b) {
  if (!a || !b) return false;
  for (const col of GENRE_COLUMNS) {
    if (col === 'band_id') continue; // same key by construction
    if (canonical(a[col] ?? null) !== canonical(b[col] ?? null)) return false;
  }
  return true;
}

// Which payload columns differ between two rows (for dry-run diffs).
export function genreRowDiffFields(a, b) {
  const out = [];
  for (const col of GENRE_COLUMNS) {
    if (col === 'band_id') continue;
    if (canonical(a?.[col] ?? null) !== canonical(b?.[col] ?? null)) out.push(col);
  }
  return out;
}

// Diff incoming rows against the current table contents.
//   existingById: Map<band_id, stored row>
//   bandIds:      Set<band_id> of bands that exist in the bands table
//   incoming:     normalized rows (from normalizeGenreRow)
// Returns { inserts, updates: [{row, fields}], unchanged, missingBand }.
// Rows whose band doesn't exist are reported, never written — the FK would
// reject them anyway, and the dry run should name them (the one-word
// Sweetwater synthetic-UUID case: apply the member-graph add first, then
// re-run; the upsert is idempotent).
export function diffGenreRows(existingById, bandIds, incoming) {
  const inserts = [];
  const updates = [];
  const unchanged = [];
  const missingBand = [];
  for (const row of incoming) {
    if (!bandIds.has(row.band_id)) {
      missingBand.push(row);
      continue;
    }
    const cur = existingById.get(row.band_id);
    if (!cur) inserts.push(row);
    else if (genreRowEquals(cur, row)) unchanged.push(row);
    else updates.push({ row, fields: genreRowDiffFields(cur, row) });
  }
  return { inserts, updates, unchanged, missingBand };
}

// Idempotent upsert of normalized rows into band_genre_data. Writes ONLY
// to band_genre_data — never to bands.genre / bands.years_active (additive
// lock). updated_at is stamped on every write so the graph-cache version
// check sees the change.
export async function upsertGenreRows(sql, rows) {
  const queries = rows.map((r) => sql`
    insert into band_genre_data (
      band_id, primary_genre, genre_tier, genre_sources, genre_agreement,
      fringe_genres, first_album_year, first_album_title, first_album_source,
      first_album_tier, formation_year, end_year, has_conflict, provenance,
      updated_at
    ) values (
      ${r.band_id}, ${r.primary_genre}, ${r.genre_tier},
      ${JSON.stringify(r.genre_sources)}::jsonb, ${r.genre_agreement},
      ${JSON.stringify(r.fringe_genres)}::jsonb, ${r.first_album_year},
      ${r.first_album_title}, ${r.first_album_source}, ${r.first_album_tier},
      ${r.formation_year}, ${r.end_year}, ${r.has_conflict},
      ${JSON.stringify(r.provenance)}::jsonb, now()
    )
    on conflict (band_id) do update set
      primary_genre = excluded.primary_genre,
      genre_tier = excluded.genre_tier,
      genre_sources = excluded.genre_sources,
      genre_agreement = excluded.genre_agreement,
      fringe_genres = excluded.fringe_genres,
      first_album_year = excluded.first_album_year,
      first_album_title = excluded.first_album_title,
      first_album_source = excluded.first_album_source,
      first_album_tier = excluded.first_album_tier,
      formation_year = excluded.formation_year,
      end_year = excluded.end_year,
      has_conflict = excluded.has_conflict,
      provenance = excluded.provenance,
      updated_at = now()
  `);
  if (typeof sql.transaction === 'function') {
    await sql.transaction(queries);
  } else {
    for (const q of queries) await q;
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Read-path shaping
// ---------------------------------------------------------------------------

// One slim row for GET /api/genre-graph. debut_year is computed here (read
// time) so the page never re-derives the rule differently.
export function slimGenreRow(r) {
  return {
    id: r.id,
    name: r.name,
    city: r.city ?? null,
    country: r.country ?? null,
    genre: r.primary_genre ?? null,
    tier: r.genre_tier ?? null,
    genre_sources: r.genre_sources || [],
    debut_year: debutYearOf(r),
    first_album_title: r.first_album_title ?? null,
    first_album_source: r.first_album_source ?? null,
    formation_year: r.formation_year ?? null,
    end_year: r.end_year ?? null,
    has_conflict: r.has_conflict === true,
  };
}

// Shape a portal neighborhood from raw membership rows, mirroring the
// embedded PORTAL snapshot's structure so the page renders both the same
// way:
//   entry: [[memberName, [otherBandName, ...]], ...] for the centre band
//   outer: { otherBandName: [[memberName, [otherBandName, ...]], ...] }
//          (only populated when degrees >= 3 — the third ring's members)
//   ids:   { bandName: bandId } for every band named, so the page can
//          re-centre by UUID instead of by name where it has the id.
//
// Inputs are plain row arrays (already fetched):
//   centre:      { id, name }
//   memberships: [{ band_id, member_id }] for every band in play
//   members:     [{ id, name }]
//   bands:       [{ id, name }] for every band in play
// The centre band's own name is excluded from each member's other-bands
// list (the embedded snapshot does the same).
export function shapePortalNeighborhood({ centre, memberships, members, bands, degrees = 2 }) {
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  const ids = {};
  for (const b of bands) ids[b.name] = b.id;

  const membersOf = new Map(); // band_id -> [member_id]
  const bandsOf = new Map();   // member_id -> [band_id]
  for (const ms of memberships) {
    if (!membersOf.has(ms.band_id)) membersOf.set(ms.band_id, []);
    membersOf.get(ms.band_id).push(ms.member_id);
    if (!bandsOf.has(ms.member_id)) bandsOf.set(ms.member_id, []);
    bandsOf.get(ms.member_id).push(ms.band_id);
  }

  const entryFor = (bandId) => {
    const selfName = bandName.get(bandId);
    return (membersOf.get(bandId) || []).map((mid) => {
      const others = (bandsOf.get(mid) || [])
        .filter((bid) => bid !== bandId)
        .map((bid) => bandName.get(bid))
        .filter((n) => n && n !== selfName);
      return [memberName.get(mid) || '', others];
    }).filter((pair) => pair[0]);
  };

  const entry = entryFor(centre.id);
  const outer = {};
  if (degrees >= 3) {
    const seen = new Set();
    for (const [, others] of entry) {
      for (const name of others) {
        if (seen.has(name)) continue;
        seen.add(name);
        const bid = ids[name];
        if (bid) outer[name] = entryFor(bid);
      }
    }
  }
  return { entry, outer, ids };
}
