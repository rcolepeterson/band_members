// GET /api/bands — public read endpoint serving the band/member/membership
// graph from Neon Postgres.
//
// This is the PR 3a read path: the client's loadGraphData() (index.html)
// tries this endpoint first and falls back to the CSV if it fails for any
// reason (network error, non-2xx, or an empty payload before the one-time
// seed has run). See index.html's loadGraphData() for the fallback logic.
//
// Why a separate file from bands.mjs: bands.mjs is the legacy Netlify Blobs
// endpoint mounted at the default `/.netlify/functions/bands` path (no
// `config.path` export there). This file mounts at `/api/bands` via
// `config.path` below, so the two coexist without any routing conflict —
// Netlify Functions v2 routes by `config.path`, not by filename. bands.mjs
// is left untouched and stays live as the write path (POST) and the fallback
// data source for two weeks per the migration plan.
//
// Scope of PR 3a: read-only. Writes (adding/editing a band through this new
// schema) land in PR 3b. A POST here deliberately returns 405 so the route
// shape is locked in now without committing to write semantics yet.
//
// PR 3b update: this file now declares `config.method: 'GET'` so it can
// coexist on the same /api/bands path with bands_create.mjs (POST) and
// bands_edit.mjs (PATCH /api/bands/:id) without route ambiguity — Netlify
// Functions v2 dispatches by (path, method) when multiple functions share a
// path but declare disjoint methods. The `req.method !== 'GET'` guard below
// is kept anyway as defense in depth (e.g. local dev quirks, future method
// additions to this same file).
//
// No auth: this is public graph data, same trust level as the CSV file it
// replaces.

import {
  getSql,
  isDbConfigured,
  ok,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    // Three independent selects rather than one big join: the client wants
    // nodes (bands, members) and edges (memberships) as separate arrays
    // anyway (see normalizeNeonToRows() in index.html), and keeping them
    // separate avoids repeating every band/member column once per
    // membership row over the wire.
    const [bands, members, memberships] = await Promise.all([
      sql`
        select id, name, city, state, country, genre, years_active, label, albums, csv_origin
        from bands
        order by name
      `,
      sql`
        select id, name, city, state, country, instrument1, instrument2, years_active, bio
        from band_members
        order by name
      `,
      sql`
        select id, band_id, member_id, tenure, weight, relation
        from memberships
      `,
    ]);

    return ok({ bands, members, memberships });
  } catch (err) {
    console.error('bands_neon GET failed', err);
    return serverError('could not load bands', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Netlify Functions v2 route config: mount at /api/bands for the client's
// new read path. Does NOT collide with bands.mjs, which has no `config`
// export and therefore only serves the legacy `/.netlify/functions/bands`
// path.
export const config = { path: '/api/bands', method: 'GET' };
