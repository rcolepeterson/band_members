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
import { ensureGameExclusionsTable } from './_game_exclusions.mjs';

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

    // four-option sign-in: provider identity columns.
    // provider: which identity source the row belongs to — 'email' for the
    //   original passwordless flow (the default, so existing rows are email
    //   rows), or 'google' / 'facebook' / 'instagram' for OAuth rows.
    // provider_user_id: the provider's stable user id (Google `sub`,
    //   Facebook `id`, Instagram `id`). Unique per provider — one OAuth
    //   identity can only ever belong to one row (race-safe linking in
    //   oauth_callback.mjs relies on this index).
    // avatar_url: provider profile photo, refreshed on each OAuth sign-in.
    // email_verified: true ONLY when the provider asserted a verified email.
    //   The email flow stays unverified by design; the linking rule in
    //   _oauth.mjs (decideIdentity) relies on this flag, so nothing may set
    //   it true except a provider's verified claim.
    await sql`alter table users add column if not exists provider         text not null default 'email'`;
    await sql`alter table users add column if not exists provider_user_id text`;
    await sql`alter table users add column if not exists avatar_url       text`;
    await sql`alter table users add column if not exists email_verified   boolean not null default false`;
    await sql`
      create unique index if not exists users_provider_uid_idx
        on users (provider, provider_user_id)
        where provider_user_id is not null
    `;
    results.push('columns users.{provider,provider_user_id,avatar_url,email_verified} ready');

    // player handles: the privacy-safe battle name shown on challenges and
    // matches instead of the real name. Nullable — existing users predate it
    // and get one auto-assigned on their first challenge/match creation
    // (see ensureHandle in me_handle.mjs); the auto-assign never overwrites
    // a handle the player chose themselves. Case-insensitive uniqueness via
    // the expression index below.
    await sql`alter table users add column if not exists handle text`;
    await sql`
      create unique index if not exists users_handle_lower_idx
      on users (lower(handle))
      where handle is not null
    `;
    results.push('column users.handle ready');

    // oauth_states: one-shot CSRF states for the OAuth round-trip. The site
    // has no cookies or server sessions, so the state lives server-side:
    // 15-minute TTL, consumed exactly once by /api/oauth/callback.
    // oauth_authorize.mjs sweeps expired rows opportunistically.
    await sql`
      create table if not exists oauth_states (
        state      text primary key,
        provider   text not null,
        return_to  text not null,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table oauth_states ready');

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

    // Band bios: free-text "where the band is from / what they did" shown
    // on the band card. Same plain-text, no-links rules as member bios —
    // enforced at write time (bands_edit.mjs / bands_create.mjs), not here.
    await sql`alter table bands add column if not exists bio text`;
    results.push('column bands.bio ready');

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

    // Onboarding email toggle + sent log (thank-you from Aaron, day-2 drip).
    await sql`
      alter table notification_prefs
      add column if not exists email_onboarding boolean not null default true
    `;
    await sql`
      create table if not exists onboarding_emails (
        user_id        uuid primary key references users(id) on delete cascade,
        kind           text not null check (kind in ('blast', 'drip')),
        credits_granted integer not null,
        sent_at        timestamptz not null default now()
      )
    `;
    results.push('onboarding email prefs + log ready');

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

    // daily_snapshots table ---------------------------------------------------
    // Growth dashboard: one row per day capturing graph + social metrics.
    // Backfilled from Aaron's manual spreadsheet (Aug 31 2026 →), then
    // appended by the daily snapshot job. Never updated, only inserted —
    // the history IS the product (time-travel charts on the ops board).
    await sql`
      create table if not exists daily_snapshots (
        snapshot_date       date primary key,
        node_count          integer,
        user_count          integer,
        follows_count       integer,
        bands_added         integer not null default 0,
        ig_sixdegrees       integer,
        ig_vimana17         integer,
        fb_sixdegrees       integer,
        fb_aaron            integer,
        notes               text,
        created_at          timestamptz not null default now()
      )
    `;
    results.push('table daily_snapshots ready');

    // shared_chains table ----------------------------------------------------
    // Game share cards: one row per "Share the chain" tap. The row is the
    // permanent record behind a share link (?game=<id>) — the edge function
    // reads it for the og:title, and the card renderer draws the chain from
    // it. Rows are never updated or deleted; a shared link must keep working.
    await sql`
      create table if not exists shared_chains (
        id         text primary key,
        chain      jsonb not null,
        mode       text not null,
        hops       integer not null,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table shared_chains ready');

    // game_sponsors table ----------------------------------------------------
    // Sponsor ribbon on the game card ("This week's game is brought to you
    // by"). One row per sponsor: an icon shown in the ribbon, an optional
    // link the icon taps through to, and a sort_order for the left-to-right
    // display order (ties break by creation time). Rows are only ever
    // written through /api/game-sponsors with the admin token; the game card
    // reads them with a plain GET. Empty table = the card shows its tasteful
    // "your brand here" placeholder instead.
    await sql`
      create table if not exists game_sponsors (
        id         uuid primary key default gen_random_uuid(),
        name       text not null,
        icon_url   text not null,
        link_url   text,
        sort_order integer not null default 0,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table game_sponsors ready');

    await sql`
      create index if not exists game_sponsors_sort_order_idx
      on game_sponsors (sort_order, created_at)
    `;
    results.push('index game_sponsors_sort_order_idx ready');

    // game_challenges table --------------------------------------------------
    // Remote head-to-head: one row per invite. The challenger picks band_a
    // and gets an unguessable token; the invite link is
    // /game/?invite=<token>. The invitee picks band_b on their own device,
    // which flips the row to 'answered'. Picks are OPEN (the invitee sees
    // band_a before choosing), matching the pass-and-play table behavior.
    // Band refs are the game client's graph node ids (display-name strings,
    // not band UUIDs) — validated for shape at the API layer, resolved
    // against the loaded graph on the client. Rows are never deleted: an old
    // link keeps showing its matchup.
    await sql`
      create table if not exists game_challenges (
        id            uuid primary key default gen_random_uuid(),
        token         text not null unique,
        challenger_id uuid not null references users(id) on delete cascade,
        invitee_id    uuid references users(id) on delete set null,
        band_a        text not null,
        band_b        text,
        status        text not null default 'open' check (status in ('open','answered')),
        created_at    timestamptz not null default now(),
        answered_at   timestamptz
      )
    `;
    results.push('table game_challenges ready');

    await sql`
      create index if not exists game_challenges_challenger_id_idx
      on game_challenges (challenger_id)
    `;
    results.push('index game_challenges_challenger_id_idx ready');

    await sql`
      create index if not exists game_challenges_invitee_id_idx
      on game_challenges (invitee_id)
    `;
    results.push('index game_challenges_invitee_id_idx ready');

    // game_matches table -----------------------------------------------------
    // Structured head-to-head: best-of-N / timed / open-ended matches.
    // A match is a series of rounds; each round is two plays (one serve
    // each, tennis-style alternation — the challenger leads odd rounds).
    // Scoring: higher hop count wins the round; tie rounds are replayed.
    // plays is a JSONB array of {round, server_id, band_a, band_b, hops}.
    // pending_server_id + pending_band_a describe the in-flight serve:
    //   pending_band_a set   -> waiting on the defender to pick band_b
    //   pending_band_a null  -> waiting on pending_server to pick band_a
    await sql`
      create table if not exists game_matches (
        id                    uuid primary key default gen_random_uuid(),
        token                 text not null unique,
        challenger_id         uuid not null references users(id) on delete cascade,
        invitee_id            uuid references users(id) on delete set null,
        format                text not null check (format in ('best3','best5','best7','timed','open')),
        status                text not null default 'open' check (status in ('open','active','complete')),
        challenger_round_wins integer not null default 0,
        invitee_round_wins     integer not null default 0,
        current_round         integer not null default 1,
        pending_server_id     uuid references users(id) on delete set null,
        pending_band_a        text,
        plays                 jsonb not null default '[]',
        created_at            timestamptz not null default now(),
        ends_at               timestamptz,
        completed_at          timestamptz
      )
    `;
    results.push('table game_matches ready');

    await sql`
      create index if not exists game_matches_challenger_id_idx
      on game_matches (challenger_id)
    `;
    results.push('index game_matches_challenger_id_idx ready');

    await sql`
      create index if not exists game_matches_invitee_id_idx
      on game_matches (invitee_id)
    `;
    results.push('index game_matches_invitee_id_idx ready');

    // Daily Chain tables -----------------------------------------------------
    // The Wordle-style daily: one band pair per day (lottery, date-seeded),
    // the player builds the chain link-by-link from multiple-choice options.
    await sql`
      create table if not exists daily_chains (
        date         text primary key,  -- YYYY-MM-DD, Pacific
        band_a       uuid not null references bands(id) on delete cascade,
        band_b       uuid not null references bands(id) on delete cascade,
        optimal_hops integer not null,
        created_at   timestamptz not null default now()
      )
    `;
    results.push('table daily_chains ready');

    await sql`
      create table if not exists daily_runs (
        id              uuid primary key default gen_random_uuid(),
        user_id         uuid not null references users(id) on delete cascade,
        chain_date      text not null references daily_chains(date) on delete cascade,
        status          text not null default 'active',
        current_band_id uuid not null,
        hops_used       integer not null default 0,
        hints_used      integer not null default 0,
        picks           jsonb not null default '[]',
        current_options jsonb,
        escaped         jsonb not null default '[]',
        created_at      timestamptz not null default now(),
        completed_at    timestamptz,
        unique (user_id, chain_date)
      )
    `;
    results.push('table daily_runs ready');

    await sql`
      create index if not exists daily_runs_user_id_idx
      on daily_runs (user_id)
    `;
    results.push('index daily_runs_user_id_idx ready');

    // Completion ledger — streaks are derived from this, never stored.
    await sql`
      create table if not exists daily_completions (
        user_id    uuid not null references users(id) on delete cascade,
        chain_date text not null,
        via_freeze boolean not null default false,
        created_at timestamptz not null default now(),
        primary key (user_id, chain_date)
      )
    `;
    results.push('table daily_completions ready');

    // Purchased archive days (playing a missed day repairs the streak).
    await sql`
      create table if not exists daily_unlocks (
        user_id    uuid not null references users(id) on delete cascade,
        chain_date text not null,
        created_at timestamptz not null default now(),
        primary key (user_id, chain_date)
      )
    `;
    results.push('table daily_unlocks ready');

    // Credit economy columns on users.
    await sql`alter table users add column if not exists credits      integer not null default 50`;
    results.push('column users.credits ready');
    await sql`alter table users add column if not exists freeze_count integer not null default 0`;
    results.push('column users.freeze_count ready');

    // Daily Chain replays ----------------------------------------------------
    // v1 allowed one run per user per day (unique(user_id, chain_date)).
    // Replays need many: replace with unique(user_id, chain_date, run_number).
    // Existing rows keep run_number = 1, so Aaron's in-progress run survives.
    await sql`alter table daily_runs add column if not exists run_number integer not null default 1`;
    await sql`alter table daily_runs drop constraint if exists daily_runs_user_id_chain_date_key`;
    const _rr = await sql`select 1 from pg_constraint where conname = 'daily_runs_user_replay_key'`;
    if (!_rr[0]) {
      await sql`alter table daily_runs add constraint daily_runs_user_replay_key unique (user_id, chain_date, run_number)`;
    }
    results.push('daily_runs replay support ready');

    // Solo Run tables --------------------------------------------------------
    // Solo v2 (Oct 2026): the guessing game — the tree deals a pair (or the
    // player picks band A and the tree supplies band B), and the player
    // builds the chain link-by-link from multiple-choice options, Daily
    // Chain style. Free to start; hints and blackhole escapes cost credits.
    // No streaks, no archive — each run is a fresh deal.
    await sql`
      create table if not exists solo_runs (
        id              uuid primary key default gen_random_uuid(),
        user_id         uuid not null references users(id) on delete cascade,
        status          text not null default 'active',
        band_a          uuid not null references bands(id) on delete cascade,
        band_b          uuid not null references bands(id) on delete cascade,
        optimal_hops    integer not null,
        current_band_id uuid not null,
        hops_used       integer not null default 0,
        hints_used      integer not null default 0,
        picks           jsonb not null default '[]',
        current_options jsonb,
        escaped         jsonb not null default '[]',
        created_at      timestamptz not null default now(),
        completed_at    timestamptz
      )
    `;
    results.push('table solo_runs ready');

    await sql`
      create index if not exists solo_runs_user_id_idx
      on solo_runs (user_id)
    `;
    results.push('index solo_runs_user_id_idx ready');

    // duplicate_flags table --------------------------------------------------
    // Duplicate-band monitor (see scanDuplicateBands in
    // cron_verify_stale_bands.mjs). One row per detected true-duplicate pair
    // (same name + same city + same country, e.g. the Sep-2026 Sweet Water
    // double). Pairs the monitor flags stay open until a maintainer
    // resolves them (delete/merge the bad node), at which point
    // resolved_at is stamped — the monitor never re-flags a resolved pair,
    // and never flags same-name-different-city bands (the two Skid Rows are
    // legitimately different bands).
    await sql`
      create table if not exists duplicate_flags (
        id          bigserial primary key,
        band_ids    uuid[] not null,
        detected_at timestamptz not null default now(),
        resolved_at timestamptz,
        note        text
      )
    `;
    results.push('table duplicate_flags ready');

    await sql`
      create index if not exists duplicate_flags_resolved_at_idx
      on duplicate_flags (resolved_at)
    `;
    results.push('index duplicate_flags_resolved_at_idx ready');

    // game_analytics_events table --------------------------------------------
    // Anonymous + signed-in game engagement tracking (Cole's request, Oct 2026).
    // Fire-and-forget events from the game client: game_started, move_made,
    // hint_clicked, game_completed. The ops board aggregates these into
    // Games Started per User, Win/Loss/Abandon Rate, Hint Clicks, and
    // Average Moves per Game.
    //
    // Privacy: user_id is NULL for anonymous players. session_id is a
    // client-generated UUID per game — no cross-session tracking for anon.
    await sql`
      create table if not exists game_analytics_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid references users(id) on delete set null,
        session_id text not null,
        event_type text not null,
        game_mode text,
        band_a text,
        band_b text,
        result text,
        moves_count integer,
        hints_used integer,
        duration_seconds integer,
        created_at timestamptz not null default now()
      )
    `;
    results.push('table game_analytics_events ready');

    await sql`
      create index if not exists game_analytics_events_type_date_idx
      on game_analytics_events (event_type, created_at)
    `;
    results.push('index game_analytics_events_type_date_idx ready');

    await sql`
      create index if not exists game_analytics_events_session_idx
      on game_analytics_events (session_id, event_type)
    `;
    results.push('index game_analytics_events_session_idx ready');

    // Guest play support (Aaron/Cole, 2026-10-08): guests play free without
    // sign-up; credits tracked against a guest session, migrated on signup.
    await sql`alter table users add column if not exists is_guest boolean not null default false`;
    results.push('column users.is_guest ready');
    await sql`alter table users add column if not exists guest_session_id text`;
    results.push('column users.guest_session_id ready');
    await sql`
      create unique index if not exists users_guest_session_id_idx
      on users (guest_session_id) where guest_session_id is not null
    `;
    results.push('index users_guest_session_id_idx ready');

    // Bands the game never uses but the explorer keeps (Cole, 2026-10-09).
    // Seeded with Supergroup A/B; see _game_exclusions.mjs.
    await ensureGameExclusionsTable(sql);
    results.push('table game_excluded_bands ready');

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
