-- Fantasy Band Game — migration v1 (2026-11-07).
--
-- RUN THIS FIRST, in Neon's SQL editor, BEFORE the first deploy of the
-- fantasy functions. It creates only the two fantasy tables; it touches
-- no existing table and writes nothing to any graph table (fantasy value
-- never feeds back into the graph — spec §2 firewall rule).
--
-- SAFE TO RE-RUN: every statement is IF NOT EXISTS / ON CONFLICT, so a
-- second run is a no-op. (Same idempotency convention as
-- netlify/functions/migrate.mjs.)
--
-- Career wins are DERIVED, not stored: count won=true rows in
-- fantasy_lineups per user. There is deliberately no wins-counter table
-- and no counter column on users, so re-running the nightly settle can
-- never double-count a win.
--
-- Scoring constants live in the functions, not here: Gold line 69,
-- connection bonus +4/pair capped +16, crowd-split half strength
-- (adjusted V = V / (1 + 0.5 * share)), tiers Gold 10 / Platinum 25 wins.
-- The pool itself (100 players, locked prices) is embedded in the
-- functions (_fantasy_pool.mjs), not in the database.

create extension if not exists pgcrypto;

-- fantasy_lineups -----------------------------------------------------------
-- One row per user per Pacific day. `slots` is {V,G,B,D,W: member_id};
-- `picks` is the frozen display snapshot [{slot, member_id, name, V, price}]
-- so the card renders without re-joining the pool. Scores are recomputed
-- server-side from the embedded pool at submit time (provisional) and at
-- settle time (final) — the client never supplies a score.
--   provisional_score = sum(V) + connection bonus (no crowd-split yet)
--   final_score       = sum(V / (1 + 0.5*share)) + connection bonus
--   won               = final_score > 69 (strictly greater), set by settle
--   shares            = {member_id: pick share} for this lineup's five,
--                       written by settle for audit
create table if not exists fantasy_lineups (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  play_date        text not null,  -- YYYY-MM-DD, Pacific (same day rule as Daily)
  slots            jsonb not null,
  picks            jsonb not null default '[]'::jsonb,
  price_total      integer not null check (price_total between 0 and 100),
  value_sum        numeric(8,2) not null,
  connection_bonus integer not null default 0 check (connection_bonus between 0 and 16),
  pairs            jsonb not null default '[]'::jsonb,
  provisional_score numeric(8,2) not null,
  final_score      numeric(8,2),
  won              boolean,
  shares           jsonb not null default '{}'::jsonb,
  submitted_at     timestamptz not null default now(),
  settled_at       timestamptz,
  unique (user_id, play_date)
);

create index if not exists fantasy_lineups_play_date_idx
  on fantasy_lineups (play_date, provisional_score desc);

create index if not exists fantasy_lineups_user_id_idx
  on fantasy_lineups (user_id, play_date desc);

-- fantasy_days ---------------------------------------------------------------
-- One row per settled Pacific date: the settle's audit record and the
-- source of "yesterday's winner". `shares` is the full
-- {member_id: pick share} map for the day; `winner_user_id` /
-- `winner_score` name the day's top draft (final desc, connection bonus
-- desc, earliest submission). Re-settling a day upserts this row in place.
create table if not exists fantasy_days (
  play_date      text primary key,  -- YYYY-MM-DD, Pacific
  lineups        integer not null default 0,
  settled_at     timestamptz,
  settled_by     text,  -- 'cron' | 'manual'
  shares         jsonb not null default '{}'::jsonb,
  winner_user_id uuid references users(id) on delete set null,
  winner_score   numeric(8,2),
  created_at     timestamptz not null default now()
);
