// One-shot schema bootstrapper for the Neon Postgres database.
//
// Design: idempotent DDL. Every statement uses IF NOT EXISTS / IF NOT EXISTS
// so running this endpoint many times is safe — subsequent runs are a no-op
// per statement. This is deliberately a callable function, not a build-time
// migration, because:
//
// 1. Netlify Functions don't have a hook that runs once per deploy against
//    long-lived state. A one-off HTTP call is the honest way.
// 2. Rerunning this after adding new columns / tables is fine — that's the
//    whole point of the IF NOT EXISTS pattern.
// 3. It's guarded by the same ADMIN_TOKEN as the DELETE handler in bands.mjs,
//    so only the maintainer can trigger it.
//
// Not attempting to be a general migration framework (no version table, no
// rollback, no sequencing). If we outgrow this it's a small refactor to
// something like node-pg-migrate, but that's not warranted at hobby scale.
//
// Schema summary:
//   users         — one row per signed-up person (email is the natural key)
//   contributions — append-only log of add/edit actions per user
//   bands         — one row per band (PR 3a: migrated out of CSV/Blobs)
//   band_members  — one row per person
//   memberships   — join table linking a band to a member, with tenure
//
// PR 3a note: bands now live in Postgres, not just CSV. The CSV remains in
// the repo as a 2-week fallback (see index.html's loadGraphData()), and rows
// imported from it are flagged csv_origin=true on the bands table so future
// features (verification, edit locks) can treat them differently from
// bands added through the app. See seed_bands.mjs for the one-time import
// of CSV rows + existing Blobs submissions into these tables.

import {
  getSql,
  isDbConfigured,
  json,
  ok,
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

export default async (req) => {
  // Only POST — GET is intentionally unimplemented so this endpoint doesn't
  // accidentally run because someone hit the URL in a browser tab.
  if (req.method !== 'POST') return methodNotAllowed();

  // Auth first — unauthenticated callers should not learn whether the DB
  // env var is configured.
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  const results = [];

  try {
    // users table -----------------------------------------------------------
    // - id: uuid, primary key. Neon's pgcrypto extension provides gen_random_uuid().
    // - email: citext would be nicer for case-insensitive uniqueness, but we
    //   normalize on write instead (see _db.mjs normalizeEmail) to avoid an
    //   extension dependency.
    // - token: opaque bearer secret for API auth. Stored plaintext because
    //   losing the DB means the attacker owns everything anyway, and hashing
    //   would prevent revocation-by-column-nullification.
    // - counters: denormalized on the users row for O(1) leaderboard reads.
    //   The contributions table remains the source of truth; counters are
    //   incremented in the same transaction as the log write.
    await sql`create extension if not exists pgcrypto`;
    results.push('extension pgcrypto ready');

    await sql`
      create table if not exists users (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        name text not null,
        token text not null unique,
        bands_added integer not null default 0,
        bands_edited integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    results.push('table users ready');

    // Case-insensitive uniqueness on email. `unique` above already enforces
    // exact uniqueness; this additional expression index catches the case
    // where two rows differ only by case (which shouldn't happen because we
    // normalize on write, but defense in depth is cheap).
    await sql`
      create unique index if not exists users_email_lower_idx
      on users (lower(email))
    `;
    results.push('index users_email_lower_idx ready');

    // contributions table ---------------------------------------------------
    // Append-only log. Each row is one recorded action by one user on one
    // band. The metadata column is jsonb so we can extend without migrations
    // (e.g. store the specific fields changed on an edit).
    await sql`
      create table if not exists contributions (
        id bigserial primary key,
        user_id uuid not null references users(id) on delete cascade,
        action text not null check (action in ('add_band','edit_band','edit_band_members')),
        band_id text,
        band_name text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table contributions ready');

    // PR 3b: bands_edit_members.mjs logs action='edit_band_members'. Because
    // `create table if not exists` is a no-op on a database that already has
    // this table (every deploy after the first), the CHECK constraint above
    // never gets a chance to pick up the new allowed value on its own. Drop
    // and recreate the constraint explicitly — same idempotent
    // drop-then-recreate pattern already used for the updated_at triggers
    // below, just applied to a CHECK constraint instead of a trigger.
    await sql`alter table contributions drop constraint if exists contributions_action_check`;
    await sql`
      alter table contributions
      add constraint contributions_action_check
      check (action in ('add_band','edit_band','edit_band_members'))
    `;
    results.push('constraint contributions_action_check ready (edit_band_members allowed)');

    // Query patterns we anticipate:
    //   - "list my contributions"       -> user_id + created_at desc
    //   - "leaderboard by action count" -> user_id + action (covered by (user_id, action))
    //   - "recent activity"             -> created_at desc
    await sql`
      create index if not exists contributions_user_id_created_at_idx
      on contributions (user_id, created_at desc)
    `;
    results.push('index contributions_user_id_created_at_idx ready');

    await sql`
      create index if not exists contributions_created_at_idx
      on contributions (created_at desc)
    `;
    results.push('index contributions_created_at_idx ready');

    // updated_at trigger for users. Not strictly needed today but avoids
    // stale-timestamp surprises when we start editing user rows.
    await sql`
      create or replace function set_updated_at()
      returns trigger as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$ language plpgsql
    `;
    // drop-and-create the trigger so re-running the migration keeps it in sync
    await sql`drop trigger if exists users_set_updated_at on users`;
    await sql`
      create trigger users_set_updated_at
      before update on users
      for each row execute function set_updated_at()
    `;
    results.push('trigger users_set_updated_at ready');

    // bands table ------------------------------------------------------------
    // PR 3a: bands move out of CSV/Blobs and into Postgres as first-class
    // rows. `csv_origin` marks rows imported from the base CSV (via
    // seed_bands.mjs) so future features (verification, edit locks) can
    // treat CSV-sourced data differently from app-added data. `added_by` /
    // `edited_by` are nullable references to users — nullable because CSV
    // rows have no attributable user, and ON DELETE SET NULL so deleting a
    // user account doesn't cascade into deleting the bands they touched.
    await sql`
      create table if not exists bands (
        id           uuid primary key default gen_random_uuid(),
        name         text not null,
        city         text,
        state        text,
        country      text,
        genre        text,
        years_active text,
        label        text,
        albums       text,
        csv_origin   boolean not null default false,
        added_by     uuid references users(id) on delete set null,
        edited_by    uuid references users(id) on delete set null,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now()
      )
    `;
    results.push('table bands ready');

    // Case-insensitive uniqueness on name, mirroring the users_email_lower_idx
    // pattern. This is also what seed_bands.mjs upserts against.
    await sql`
      create unique index if not exists bands_name_lower_idx
      on bands (lower(name))
    `;
    results.push('index bands_name_lower_idx ready');

    // Query patterns we anticipate: filtering the graph by scene (city) or
    // by genre, both of which the client's existing dropdowns already do
    // client-side against the CSV — these indexes prepare for pushing that
    // filtering server-side later.
    await sql`create index if not exists bands_city_idx on bands (city)`;
    results.push('index bands_city_idx ready');
    await sql`create index if not exists bands_genre_idx on bands (genre)`;
    results.push('index bands_genre_idx ready');

    // Reuses the same set_updated_at() function created above for users.
    await sql`drop trigger if exists bands_set_updated_at on bands`;
    await sql`
      create trigger bands_set_updated_at
      before update on bands
      for each row execute function set_updated_at()
    `;
    results.push('trigger bands_set_updated_at ready');

    // band_members table ------------------------------------------------------
    // One row per person. Instrument fields are limited to two (instrument1/
    // instrument2) matching the two most-used columns in the CSV
    // (`Intrument 1` / `Intrument 2` — the source data's columns 3 and 4 are
    // effectively always empty in practice; buildMasterGraph() in index.html
    // only ever reads the first two anyway).
    await sql`
      create table if not exists band_members (
        id            uuid primary key default gen_random_uuid(),
        name          text not null,
        city          text,
        state         text,
        country       text,
        instrument1   text,
        instrument2   text,
        years_active  text,
        bio           text,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now()
      )
    `;
    results.push('table band_members ready');

    await sql`
      create unique index if not exists band_members_name_lower_idx
      on band_members (lower(name))
    `;
    results.push('index band_members_name_lower_idx ready');

    await sql`drop trigger if exists band_members_set_updated_at on band_members`;
    await sql`
      create trigger band_members_set_updated_at
      before update on band_members
      for each row execute function set_updated_at()
    `;
    results.push('trigger band_members_set_updated_at ready');

    // memberships table ------------------------------------------------------
    // Join table linking a band to a member, one row per membership (i.e. one
    // row per CSV edge). `tenure` is the member's years active AT THIS band
    // (as opposed to band_members.years_active, which is the person's overall
    // career span). `weight` and `relation` mirror the CSV's `weight` and
    // `relation_type` columns. ON DELETE CASCADE on both foreign keys because
    // a membership has no meaning once either side is gone. The UNIQUE
    // constraint on (band_id, member_id) is what seed_bands.mjs upserts
    // against, and matches the real-world invariant: a person joins a given
    // band once (rejoining is modeled as one continuous or updated tenure,
    // not a second row).
    await sql`
      create table if not exists memberships (
        id           bigserial primary key,
        band_id      uuid not null references bands(id) on delete cascade,
        member_id    uuid not null references band_members(id) on delete cascade,
        tenure       text,
        weight       integer not null default 1,
        relation     text not null default 'member_of',
        created_at   timestamptz not null default now(),
        unique (band_id, member_id)
      )
    `;
    results.push('table memberships ready');

    await sql`
      create index if not exists memberships_band_id_idx
      on memberships (band_id)
    `;
    results.push('index memberships_band_id_idx ready');

    await sql`
      create index if not exists memberships_member_id_idx
      on memberships (member_id)
    `;
    results.push('index memberships_member_id_idx ready');

    return ok({ steps: results });
  } catch (err) {
    console.error('migrate failed', err);
    return serverError('migration failed', {
      message: err && err.message ? String(err.message) : 'unknown',
      completed_steps: results,
    });
  }
};

// Netlify Functions v2 route config: mount at /api/migrate for a clean URL.
export const config = { path: '/api/migrate' };
