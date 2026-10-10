// Shared Neon-transfer optimization: serve the full band graph from
// Netlify Blobs unless the underlying data has actually changed.
//
// Why (2026-10-10): the project hit Neon's monthly network-transfer limit.
// /api/bands returns ~8 MB and /api/game-graph ~3 MB; both were re-read
// from Neon on every CDN refresh (~24/day each after PR #354's 1-hour
// cache). Now each endpoint first runs a cheap version query
// (max(updated_at) + count(*) per table, a few KB), and only re-reads the
// full tables when the version changed. Unchanged data is served from a
// Blobs copy keyed by that version, so Neon sees ~zero bytes for it.
//
// Blobs store choice: getStore (NOT getDeployStore) — the site-wide store
// survives redeploys (see the comment in bands.mjs). Strong consistency so
// a just-written copy is readable immediately.
//
// Safety nets (per the plan):
//  - any Blob error falls back to reading Neon exactly as before;
//  - the copy is rebuilt at least once every 24h regardless of version;
//  - an admin-only refresh endpoint (admin_refresh_graph.mjs) forces a rebuild.
//
// The core functions take `sql` and `store` as parameters so tests can pass
// mocks without a live DB or Blobs.

import { getStore } from '@netlify/blobs';

// Tables whose changes invalidate the /api/bands payload.
export const BANDS_TABLES = ['bands', 'band_members', 'memberships', 'band_links'];
// Tables whose changes invalidate the /api/game-graph payload (no links).
export const GAME_TABLES = ['bands', 'band_members', 'memberships'];

// Allowlist for dynamic table names. The Neon sql tag binds ${} as query
// parameters, which cannot be table identifiers, so table names are
// interpolated into the query string directly — safe ONLY because they come
// from these hardcoded constants, never from user input.
const KNOWN_TABLES = new Set([...BANDS_TABLES, ...GAME_TABLES]);

function assertKnownTable(table) {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`unknown table for version check: ${table}`);
  }
  return table;
}

// How often the saved copy is rebuilt even when the version is unchanged.
export const MAX_BLOB_AGE_MS = 24 * 60 * 60 * 1000;

export function getGraphStore() {
  return getStore({ name: 'graph-cache', consistency: 'strong' });
}

// Cheap "data version": for each table, the latest update timestamp and
// row count. Any insert/update/delete changes at least one of the two.
// Returns a string like "bands:2026-10-10T12:00:00.000Z:3023|...".
//
// Lazy schema guard: memberships gained its updated_at column after the
// other tables. If the column is missing, add it (idempotent) and continue.
// Only adds; never changes or drops existing data.
export async function getDataVersion(sql, tables) {
  for (const table of tables) {
    const t = assertKnownTable(table);
    await sql`
      alter table ${sql.unsafe(t)}
      add column if not exists updated_at timestamptz not null default now()
    `;
  }
  const parts = [];
  for (const table of tables) {
    const t = assertKnownTable(table);
    const rows = await sql`
      select max(updated_at) as max_updated, count(*) as n
      from ${sql.unsafe(t)}
    `;
    const r = rows[0] || {};
    const maxUpdated = r.max_updated instanceof Date
      ? r.max_updated.toISOString()
      : String(r.max_updated ?? '');
    parts.push(`${t}:${maxUpdated}:${r.n ?? 0}`);
  }
  return parts.join('|');
}

// Blob key for a payload version. `prefix` distinguishes the endpoints
// ('api-bands', 'api-game-graph').
export function blobKeyFor(prefix, version) {
  // The version string contains timestamps and counts; hash it to keep the
  // key short and filesystem-safe.
  let h = 0;
  for (let i = 0; i < version.length; i++) {
    h = (Math.imul(h, 31) + version.charCodeAt(i)) | 0;
  }
  return `${prefix}-v${(h >>> 0).toString(36)}`;
}

// Metadata key tracking when each prefix's copy was last built.
function metaKeyFor(prefix) {
  return `${prefix}-meta`;
}

/**
 * Serve a JSON-serializable payload, reading the full tables from Neon only
 * when the data version changed (or the saved copy is older than 24h).
 *
 * @param {object} opts
 * @param {Function} opts.sql - the Neon sql tag function
 * @param {object} [opts.store] - Blobs store (defaults to getGraphStore());
 *   pass a mock in tests. Any throw from the store falls back to Neon.
 * @param {string[]} opts.tables - tables feeding getDataVersion
 * @param {string} opts.prefix - Blob key prefix ('api-bands' | 'api-game-graph')
 * @param {Function} opts.buildPayload - async () => payload object; the
 *   exact same queries the endpoint runs today
 * @param {Function} opts.toResponse - (payload, fromCache) => Response
 * @returns {Promise<Response>}
 */
export async function serveCachedGraph({
  sql,
  store,
  tables,
  prefix,
  buildPayload,
  toResponse,
}) {
  let activeStore = store;
  if (!activeStore) {
    try {
      activeStore = getGraphStore();
    } catch {
      activeStore = null; // Blobs unavailable -> straight to Neon
    }
  }

  // Compute the version first: it's the cheap query that decides everything.
  let version;
  try {
    version = await getDataVersion(sql, tables);
  } catch {
    // If even the version query fails, don't try to be clever.
    const payload = await buildPayload();
    return toResponse(payload, false);
  }

  const key = blobKeyFor(prefix, version);
  const metaKey = metaKeyFor(prefix);

  if (activeStore) {
    try {
      const [cached, metaRaw] = await Promise.all([
        activeStore.get(key, { type: 'json' }),
        activeStore.get(metaKey, { type: 'json' }),
      ]);
      const builtAt = metaRaw && typeof metaRaw.builtAt === 'number' ? metaRaw.builtAt : 0;
      const fresh = Date.now() - builtAt < MAX_BLOB_AGE_MS;
      if (cached && fresh) {
        return toResponse(cached, true);
      }
    } catch {
      // Any Blob read error -> fall through to Neon below.
    }
  }

  // Version changed, copy missing/stale, or Blobs errored: read Neon as
  // today, save the copy (best effort), serve it.
  const payload = await buildPayload();
  if (activeStore) {
    try {
      await Promise.all([
        activeStore.setJSON(key, payload),
        activeStore.setJSON(metaKey, { version, builtAt: Date.now() }),
      ]);
    } catch {
      // Best effort only; the response is what matters.
    }
  }
  return toResponse(payload, false);
}
