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
//
// Rationale for keeping bands OUT of the DB (for now):
//   The graph data still lives in CSV. Migrating the whole graph into
//   Postgres is a separate project. For attribution we only need to record
//   who did what against the existing band-id namespace (strings from the
//   CSV / draft submissions). If we later move bands into Postgres, this
//   log links up cleanly via band_id.

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
        action text not null check (action in ('add_band','edit_band')),
        band_id text,
        band_name text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table contributions ready');

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
