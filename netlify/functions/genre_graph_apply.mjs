// POST /api/genre-graph/apply — admin-only upsert into band_genre_data.
//
// This is the write path for the verified genre layer (spec 2026-11-26
// §3). Aaron's workflow, unchanged in shape: review the merge file, run
// scripts/apply-genre-data.mjs in dry-run mode (this endpoint with
// dry_run:true — reads and diffs, writes nothing), read the diff, then
// run it for real. Re-running is safe: upsert by band_id is idempotent.
//
// Hard rules baked in here:
//  - Admin token only (x-admin-token header, same guard as migrate.mjs).
//    The verified layer is not open-editable until band-claiming arrives
//    (spec decision 7).
//  - Writes ONLY to band_genre_data. bands.genre / bands.years_active are
//    never touched — additive merge lock (Aaron, 2026-11-24).
//  - Rows whose band_id has no matching band are reported, never written
//    (the one-word Sweetwater synthetic-UUID case: apply the member-graph
//    add first, re-key, re-run).
//  - A batch with any invalid row is rejected whole (400) — no partial
//    writes from a malformed payload.
//
// Body: { dry_run?: boolean, rows: [genre row, ...] } — rows in the
// band_genre_data column shape (see normalizeGenreRow in _genre_graph.mjs).
// Batches are capped; the apply script chunks the full payload.

import {
  getSql,
  isDbConfigured,
  json,
  ok,
  unauthorized,
  badRequest,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';
import {
  normalizeGenreRow,
  diffGenreRows,
  upsertGenreRows,
  GENRE_COLUMNS,
} from './_genre_graph.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';
export const MAX_APPLY_ROWS = 1000;

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth first — unauthenticated callers should not learn whether the DB
  // env var is configured (same ordering as migrate.mjs).
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('request body must be JSON');
  }
  const dryRun = body?.dry_run === true;
  const rawRows = body?.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return badRequest('rows must be a non-empty array');
  }
  if (rawRows.length > MAX_APPLY_ROWS) {
    return badRequest(`rows exceeds the ${MAX_APPLY_ROWS}-row batch cap; send smaller batches`);
  }

  // Validate the whole batch before touching the DB.
  const rows = [];
  const rowErrors = [];
  const seen = new Set();
  rawRows.forEach((raw, i) => {
    const { row, errors } = normalizeGenreRow(raw);
    if (errors) {
      rowErrors.push({ index: i, band_id: raw?.band_id ?? null, errors });
      return;
    }
    if (seen.has(row.band_id)) {
      rowErrors.push({ index: i, band_id: row.band_id, errors: ['duplicate band_id in batch'] });
      return;
    }
    seen.add(row.band_id);
    rows.push(row);
  });
  if (rowErrors.length) {
    return json(400, { ok: false, error: 'invalid rows; nothing written', row_errors: rowErrors });
  }

  const sql = getSql();
  const ids = rows.map((r) => r.band_id);

  try {
    const [bandRows, existingRows] = await Promise.all([
      sql`select id from bands where id = any(${ids}::uuid[])`,
      sql`
        select band_id, primary_genre, genre_tier, genre_sources, genre_agreement,
               fringe_genres, first_album_year, first_album_title, first_album_source,
               first_album_tier, formation_year, end_year, has_conflict, provenance
        from band_genre_data
        where band_id = any(${ids}::uuid[])
      `,
    ]);
    const bandIds = new Set(bandRows.map((r) => r.id));
    const existingById = new Map(existingRows.map((r) => [r.band_id, r]));
    const diff = diffGenreRows(existingById, bandIds, rows);

    const summary = {
      dry_run: dryRun,
      received: rows.length,
      inserts: diff.inserts.length,
      updates: diff.updates.length,
      unchanged: diff.unchanged.length,
      missing_band: diff.missingBand.map((r) => r.band_id),
      update_fields: diff.updates.map((u) => ({ band_id: u.row.band_id, fields: u.fields })),
    };

    if (dryRun) return ok(summary);

    const toWrite = [...diff.inserts, ...diff.updates.map((u) => u.row)];
    if (toWrite.length) await upsertGenreRows(sql, toWrite);
    return ok({ ...summary, written: toWrite.length });
  } catch (err) {
    console.error('genre_graph_apply POST failed', err);
    return serverError('genre apply failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/genre-graph/apply', method: 'POST' };

// Re-exported for the SQL cross-check test (every column the endpoint
// writes must exist in the migration).
export { GENRE_COLUMNS };
