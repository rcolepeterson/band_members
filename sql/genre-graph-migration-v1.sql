-- Genre Graph live-pull — migration v1 (2026-11-26).
--
-- RUN THIS FIRST, in Neon's SQL editor, BEFORE the first deploy of the
-- genre-graph functions — OR run the migrate endpoint (POST /api/migrate),
-- which carries the identical DDL (see netlify/migrate.mjs, "band_genre_data
-- table" block). Either path is fine; they are kept in sync by
-- tests/genre-graph-endpoints.test.mjs.
--
-- It creates ONE new table, band_genre_data: the verified genre layer from
-- the 2026-11-24/25 merge (merge/merged_bands.jsonl), one row per band,
-- keyed by the band's existing UUID. It touches NO existing table: bands.genre
-- and bands.years_active stay verbatim forever (Aaron's additive-merge lock);
-- they are one source ("existing_db") inside the provenance record, not the
-- display layer.
--
-- SAFE TO RE-RUN: every statement is IF NOT EXISTS, so a second run is a
-- no-op. (Same idempotency convention as netlify/migrate.mjs and
-- sql/fantasy-migration-v1.sql.)
--
-- Debut year is deliberately NOT a column: it is computed at read time as
-- first_album_year ?? formation_year (the first-album rule, Aaron lock
-- 2026-11-24), so the rule can be re-applied later without re-importing.
--
-- The provenance jsonb carries the FULL merge record verbatim (first_album
-- .all_values, formation.values, conflicts, per-source detail). Nothing is
-- flattened away — per the locked provenance rule, the evidence is the asset.


-- band_genre_data -----------------------------------------------------------
-- One row per band. Queryable columns are the fields the Genre Graph page
-- and the band cards read on every load; fringe_genres and provenance are
-- jsonb because they are card detail, fetched per band on demand.
create table if not exists band_genre_data (
  band_id           uuid primary key references bands(id) on delete cascade,
  primary_genre     text,
  genre_tier        text,
  genre_sources     jsonb not null default '[]'::jsonb,
  genre_agreement   integer,
  fringe_genres     jsonb not null default '[]'::jsonb,
  first_album_year  integer,
  first_album_title text,
  first_album_source text,
  first_album_tier  text,
  formation_year    integer,
  end_year          integer,
  has_conflict      boolean not null default false,
  provenance        jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The page's read path filters/groups by primary_genre; the version check in
-- _graph_cache.mjs reads max(updated_at) + count(*), which the PK covers.
create index if not exists band_genre_data_primary_genre_idx
  on band_genre_data (primary_genre);
