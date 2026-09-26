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

    // signup-profile-fields: capture where a user lives and what they play.
    // All four columns are nullable — existing users predate the fields and
    // shouldn't be broken by the migration. New signups fill these in via the
    // form (see signup.mjs's validation), so going forward every new row will
    // have values. `instrument` accepts free-text including entries like
    // 'Music listener / connoisseur' for people who don't play, per the
    // product decision on 2026-07-19.
    //
    // Using `add column if not exists` (Postgres 9.6+) makes this idempotent
    // the same way the rest of this migrator is.
    await sql`alter table users add column if not exists city       text`;
    await sql`alter table users add column if not exists state      text`;
    await sql`alter table users add column if not exists country    text`;
    await sql`alter table users add column if not exists instrument text`;
    results.push('columns users.{city,state,country,instrument} ready');

    // contributions table ---------------------------------------------------
    // Append-only log. Each row is one recorded action by one user on one
    // band. The metadata column is jsonb so we can extend without migrations
    // (e.g. store the specific fields changed on an edit).
    await sql`
      create table if not exists contributions (
        id bigserial primary key,
        user_id uuid not null references users(id) on delete cascade,
        action text not null check (action in ('add_band','edit_band','edit_band_members','edit_person_bio')),
        band_id text,
        band_name text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table contributions ready');

    // Rate-limit counters. One row per bucket, reused, so the table's size tracks
    // the number of distinct callers rather than the number of requests. The cron
    // sweeps rows whose window is long past (see cron_verify_stale_bands).
    //
    // `bucket` is a namespaced string: 'signup:ip:1.2.3.4', 'band-create:tok:<id>'.
    // The token's USER ID is used rather than the token itself, so a rotated
    // credential does not hand its holder a fresh budget, and so the table never
    // stores a live secret.
    await sql`
      create table if not exists rate_limits (
        bucket text primary key,
        hits integer not null default 0,
        window_start timestamptz not null default now()
      )
    `;
    await sql`create index if not exists rate_limits_window_start_idx on rate_limits (window_start)`;
    results.push('table rate_limits ready');

    // PR 3b: bands_edit_members.mjs logs action='edit_band_members'. Because
    // `create table if not exists` is a no-op on a database that already has
    // this table (every deploy after the first), the CHECK constraint above
    // never gets a chance to pick up the new allowed value on its own. Drop
    // and recreate the constraint explicitly — same idempotent
    // drop-then-recreate pattern already used for the updated_at triggers
    // below, just applied to a CHECK constraint instead of a trigger.
    //
    // edit-person-bio PR: edit-person.mjs logs action='edit_person_bio' for
    // musician bio edits (band_id/band_name stay null for this action since
    // the edit isn't band-scoped — see edit-person.mjs). Same widen pattern.
    await sql`alter table contributions drop constraint if exists contributions_action_check`;
    await sql`
      alter table contributions
      add constraint contributions_action_check
      check (action in ('add_band','edit_band','edit_band_members','edit_person_bio'))
    `;
    results.push('constraint contributions_action_check ready (edit_band_members, edit_person_bio allowed)');

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

    // Case-insensitive uniqueness on (name, city, country), mirroring the
    // users_email_lower_idx pattern. Band identity is name + location, not
    // name alone: "Skid Row" in Toms River, NJ and "Skid Row" in Aberdeen,
    // WA are different bands and must coexist. This is also what
    // seed_bands.mjs upserts against.
    //
    // Migration note: the previous bands_name_lower_idx (name-only) is
    // dropped because it would reject the very duplicates this index
    // permits. Any data satisfying the old name-only constraint trivially
    // satisfies the new (name, city, country) one, so the swap is safe.
    //
    // The expression mirrors normalizeIdentityKey() in _bands_write.mjs
    // (lowercase, drop apostrophes, non-alnum runs become one space, trim)
    // so the DB-level backstop enforces the same identity the app
    // preflight checks: "Tom's River" and "Toms River" collide.
    await sql`drop index if exists bands_name_lower_idx`;
    await sql`
      create unique index if not exists bands_name_city_country_lower_idx
      on bands (
        btrim(regexp_replace(regexp_replace(lower(name), '[''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')),
        btrim(regexp_replace(regexp_replace(lower(coalesce(city, '')), '[''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')),
        btrim(regexp_replace(regexp_replace(lower(coalesce(country, '')), '[''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g'))
      )
    `;
    results.push('index bands_name_city_country_lower_idx ready');

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

    // verifications table ------------------------------------------------------
    // PR 4a: cross-check RESULT (not a lock — see _verify_helpers.mjs's header
    // comment) produced by comparing a band's row against MusicBrainz and
    // Wikipedia. One row per band (unique index on band_id below); re-running
    // /api/verify-band upserts this row rather than appending, since we only
    // ever care about the latest check.
    //
    // `verified_at` is the cache/invalidation clock: verify_band.mjs treats a
    // cached row as usable when it's both < 24h old AND newer than
    // bands.updated_at. That comparison is why there's no explicit
    // invalidation code in bands_edit.mjs / bands_edit_members.mjs — any edit
    // already bumps bands.updated_at via the existing bands_set_updated_at
    // trigger, which is sufficient to make verified_at look stale on the next
    // read. See the comments in those two files for the same pointer.
    //
    // `breakdown` is free-form JSONB (~4KB budget per row) holding the
    // per-field scores plus the specific values compared, so the shape can
    // evolve without a migration.
    await sql`
      create table if not exists verifications (
        id               bigserial primary key,
        band_id          uuid not null references bands(id) on delete cascade,
        verified_at      timestamptz not null default now(),
        overall_score    int not null check (overall_score between 0 and 100),
        breakdown        jsonb not null default '{}'::jsonb,
        musicbrainz_mbid text,
        musicbrainz_url  text,
        wikipedia_title  text,
        wikipedia_url    text
      )
    `;
    results.push('table verifications ready');

    // Idempotent guard for the CHECK constraint, matching the same
    // drop-then-recreate pattern used above for contributions_action_check —
    // `create table if not exists` is a no-op on every deploy after the
    // first, so if this constraint's definition ever changes, only an
    // explicit drop/add (not the CREATE TABLE) will pick it up.
    await sql`alter table verifications drop constraint if exists verifications_overall_score_check`;
    await sql`
      alter table verifications
      add constraint verifications_overall_score_check
      check (overall_score between 0 and 100)
    `;
    results.push('constraint verifications_overall_score_check ready');

    // One row per band — re-verifying upserts (on conflict (band_id) do
    // update ...) rather than appending a history of checks.
    await sql`
      create unique index if not exists verifications_band_id_idx
      on verifications (band_id)
    `;
    results.push('index verifications_band_id_idx ready');

    // notification_prefs table -------------------------------------------------
    // Phase 2: server-side notification preferences, one row per user.
    //   - email_enabled: master switch, default true. The engagement loop
    //     only works if people are in it; opting out is one tap away (user
    //     card toggle, one-click footer link in every email).
    //   - unsubscribed_at: when the user opted out (null = still in). Kept
    //     alongside email_enabled so we can distinguish "never touched the
    //     setting" from "actively unsubscribed" for analytics.
    //   - unsubscribe_token: per-user random secret powering the one-click
    //     footer link (/api/unsubscribe?token=...). No login required, and
    //     it can't be guessed. Generated lazily by ensureNotifyPrefs() in
    //     _notify.mjs so existing users get tokens on first use — no
    //     backfill migration needed.
    // Rows are created lazily (not at signup), so the table starts empty
    // and grows as users interact with notifications.
    await sql`
      create table if not exists notification_prefs (
        user_id           uuid primary key references users(id) on delete cascade,
        email_enabled     boolean not null default true,
        unsubscribed_at   timestamptz,
        unsubscribe_token text unique,
        created_at        timestamptz not null default now(),
        updated_at        timestamptz not null default now()
      )
    `;
    results.push('table notification_prefs ready');

    // Granular event-type toggles (PR 2): let users opt out of specific
    // notification types without killing all emails. All default true —
    // the engagement loop only works if people are in it.
    //   - notify_band_member_joined: new member joined a followed/touched band
    //   - notify_band_badge_added: new social badge on a followed/touched band
    //   - notify_band_edited: followed/touched band's card details edited
    //   - notify_member_band_changed: followed member joined/left a band
    //   - notify_member_edited: followed member's card edited
    await sql`
      alter table notification_prefs
      add column if not exists notify_band_member_joined boolean not null default true,
      add column if not exists notify_band_badge_added boolean not null default true,
      add column if not exists notify_band_edited boolean not null default true,
      add column if not exists notify_member_band_changed boolean not null default true,
      add column if not exists notify_member_edited boolean not null default true
    `;
    results.push('notification_prefs event-type columns ready');

    await sql`drop trigger if exists notification_prefs_set_updated_at on notification_prefs`;
    await sql`
      create trigger notification_prefs_set_updated_at
      before update on notification_prefs
      for each row execute function set_updated_at()
    `;
    results.push('trigger notification_prefs_set_updated_at ready');

    // band_notification_log table ----------------------------------------------
    // Phase 2: the 24-hour cooldown clock. One row per email actually sent,
    // keyed by (band, user, sent_at). notifyBandTouched() skips any user
    // with a row newer than 24h for the band being edited — that's the "one
    // email per band per day, max" promise in the user card. Only
    // successful sends are logged; a failed send retries on the next edit.
    await sql`
      create table if not exists band_notification_log (
        id         bigserial primary key,
        band_id    uuid not null references bands(id) on delete cascade,
        user_id    uuid not null references users(id) on delete cascade,
        sent_at    timestamptz not null default now()
      )
    `;
    results.push('table band_notification_log ready');

    // member_notification_log table ------------------------------------------
    // Mirrors band_notification_log: 24-hour cooldown per (member, user).
    await sql`
      create table if not exists member_notification_log (
        id         bigserial primary key,
        member_id  uuid not null references band_members(id) on delete cascade,
        user_id    uuid not null references users(id) on delete cascade,
        sent_at    timestamptz not null default now()
      )
    `;
    results.push('table member_notification_log ready');

    await sql`
      create index if not exists band_notification_log_band_user_sent_idx
      on band_notification_log (band_id, user_id, sent_at desc)
    `;
    results.push('index band_notification_log_band_user_sent_idx ready');

    // band_follows table ---------------------------------------------------------
    // Phase 2: explicit "Follow this band" action. Followers get update
    // emails for bands they care about but never edited — the "touched"
    // definition in _notify.mjs unions follows with creators/editors.
    // Composite PK gives us the uniqueness (one follow per user per band)
    // with no extra index; both FKs cascade so deleting a band or user
    // cleans up its follows.
    await sql`
      create table if not exists band_follows (
        user_id    uuid not null references users(id) on delete cascade,
        band_id    uuid not null references bands(id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (user_id, band_id)
      )
    `;
    results.push('table band_follows ready');

    await sql`
      create index if not exists band_follows_band_id_idx
      on band_follows (band_id)
    `;
    results.push('index band_follows_band_id_idx ready');

    // member_follows table ----------------------------------------------------
    // Mirrors band_follows: lets users follow individual members to track
    // their career moves across bands. Composite PK = one follow per user
    // per member; FKs cascade so deleting a member or user cleans up.
    await sql`
      create table if not exists member_follows (
        user_id    uuid not null references users(id) on delete cascade,
        member_id  uuid not null references band_members(id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (user_id, member_id)
      )
    `;
    results.push('table member_follows ready');

    await sql`
      create index if not exists member_follows_member_id_idx
      on member_follows (member_id)
    `;
    results.push('index member_follows_member_id_idx ready');

    // band_links table ---------------------------------------------------------
    // Phase 3: one row per (band, platform) holding the band's official
    // link for that platform. The platform CHECK mirrors LINK_PLATFORMS in
    // _links.mjs — keep the two in sync. Domain validation (spotify.com
    // URLs only in the spotify slot, etc.) happens in _links.mjs at write
    // time, not in the schema: hostnames are a moving target and a CHECK
    // constraint can't parse URLs. Composite PK gives the uniqueness with
    // no extra index; the band_id index serves the read path
    // (bands_neon.mjs selects the whole table in one go).
    await sql`
      create table if not exists band_links (
        band_id    uuid not null references bands(id) on delete cascade,
        platform   text not null check (platform in ('spotify','apple_music','youtube','bandcamp','instagram','tiktok','facebook','x','website')),
        url        text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (band_id, platform)
      )
    `;
    results.push('table band_links ready');

    await sql`
      create index if not exists band_links_band_id_idx
      on band_links (band_id)
    `;
    results.push('index band_links_band_id_idx ready');

    await sql`drop trigger if exists band_links_set_updated_at on band_links`;
    await sql`
      create trigger band_links_set_updated_at
      before update on band_links
      for each row execute function set_updated_at()
    `;
    results.push('trigger band_links_set_updated_at ready');

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
