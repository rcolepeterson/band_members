// Static/structural checks for the PR 3a schema + endpoint wiring. These
// tests grep source files rather than hitting a live DB, so they run
// hermetically and catch the class of mistake where the DDL or route config
// silently drifts from what the PR description locked in (e.g. someone
// renames a table, forgets a trigger, or accidentally mounts a new endpoint
// on a path that collides with an existing one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, '..', 'netlify', 'functions');

function readFn(name) {
  return readFileSync(path.join(FUNCTIONS_DIR, name), 'utf8');
}

// --- migrate.mjs: new tables/indexes/triggers -------------------------------

test('migrate.mjs defines the bands table', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create table if not exists bands\s*\(/i);
});

test('migrate.mjs defines the band_members table', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create table if not exists band_members\s*\(/i);
});

test('migrate.mjs defines the memberships table', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create table if not exists memberships\s*\(/i);
});

test('migrate.mjs gives bands a csv_origin column', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /csv_origin\s+boolean/i);
});

test('migrate.mjs references users(id) for bands.added_by / edited_by', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /added_by\s+uuid\s+references\s+users\(id\)/i);
  assert.match(src, /edited_by\s+uuid\s+references\s+users\(id\)/i);
});

test('migrate.mjs enforces case-insensitive uniqueness on bands.name and band_members.name', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create unique index if not exists bands_name_lower_idx/i);
  assert.match(src, /create unique index if not exists band_members_name_lower_idx/i);
});

test('migrate.mjs indexes bands.city and bands.genre', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create index if not exists bands_city_idx/i);
  assert.match(src, /create index if not exists bands_genre_idx/i);
});

test('migrate.mjs enforces a unique (band_id, member_id) constraint on memberships', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /unique\s*\(band_id,\s*member_id\)/i);
});

test('migrate.mjs indexes memberships by band_id and member_id', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create index if not exists memberships_band_id_idx/i);
  assert.match(src, /create index if not exists memberships_member_id_idx/i);
});

test('migrate.mjs wires updated_at triggers for bands and band_members reusing set_updated_at()', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /create trigger bands_set_updated_at[\s\S]*?execute function set_updated_at\(\)/i);
  assert.match(src, /create trigger band_members_set_updated_at[\s\S]*?execute function set_updated_at\(\)/i);
  // Both new triggers must DROP TRIGGER IF EXISTS first, matching the
  // existing users_set_updated_at re-run-safe pattern.
  assert.match(src, /drop trigger if exists bands_set_updated_at on bands/i);
  assert.match(src, /drop trigger if exists band_members_set_updated_at on band_members/i);
});

test('migrate.mjs remains admin-gated (unchanged auth pattern)', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /x-admin-token/i);
  assert.match(src, /isAdminAuthorized/);
});

test('migrate.mjs reports new steps so the response shows what was created', () => {
  const src = readFn('migrate.mjs');
  ['table bands ready', 'table band_members ready', 'table memberships ready'].forEach(step => {
    assert.ok(src.includes(step), `expected migrate.mjs to push step "${step}"`);
  });
});

// --- seed_bands.mjs ----------------------------------------------------------

test('seed_bands.mjs exists', () => {
  assert.ok(existsSync(path.join(FUNCTIONS_DIR, 'seed_bands.mjs')));
});

test('seed_bands.mjs uses sql.transaction', () => {
  const src = readFn('seed_bands.mjs');
  assert.match(src, /sql\.transaction\(/);
});

test('seed_bands.mjs is admin-gated via the shared x-admin-token pattern', () => {
  const src = readFn('seed_bands.mjs');
  assert.match(src, /x-admin-token/i);
  assert.match(src, /isAdminAuthorized/);
});

test('seed_bands.mjs mounts at /api/seed-bands', () => {
  const src = readFn('seed_bands.mjs');
  assert.match(src, /export const config\s*=\s*\{\s*path:\s*['"]\/api\/seed-bands['"]\s*\}/);
});

test('seed_bands.mjs reads the existing band-submissions blob store', () => {
  const src = readFn('seed_bands.mjs');
  assert.match(src, /band-submissions/);
});

test('seed_bands.mjs upserts use fill-missing semantics (coalesce/nullif against existing columns)', () => {
  const src = readFn('seed_bands.mjs');
  assert.match(src, /coalesce\(nullif\(bands\.\w+,\s*''\)/i);
  assert.match(src, /coalesce\(nullif\(band_members\.\w+,\s*''\)/i);
});

// --- bands_neon.mjs (GET /api/bands) ----------------------------------------

test('bands_neon.mjs exists', () => {
  assert.ok(existsSync(path.join(FUNCTIONS_DIR, 'bands_neon.mjs')));
});

test('bands_neon.mjs mounts at /api/bands', () => {
  const src = readFn('bands_neon.mjs');
  assert.match(src, /export const config\s*=\s*\{\s*path:\s*['"]\/api\/bands['"]\s*\}/);
});

test('bands_neon.mjs only allows GET (write path is a later PR)', () => {
  const src = readFn('bands_neon.mjs');
  assert.match(src, /req\.method !== 'GET'/);
  assert.match(src, /methodNotAllowed/);
});

test('bands_neon.mjs imports shared helpers from _db.mjs instead of duplicating them', () => {
  const src = readFn('bands_neon.mjs');
  assert.match(src, /from '\.\/_db\.mjs'/);
  assert.match(src, /\bok\b/);
  assert.match(src, /dbUnavailable/);
});

test('bands_neon.mjs selects from bands, band_members, and memberships', () => {
  const src = readFn('bands_neon.mjs');
  assert.match(src, /from\s+bands/i);
  assert.match(src, /from\s+band_members/i);
  assert.match(src, /from\s+memberships/i);
});

// --- Route non-collision with the legacy blob endpoint ----------------------

test('the legacy bands.mjs has no config export, so it stays on the default /.netlify/functions/bands path', () => {
  const src = readFn('bands.mjs');
  assert.doesNotMatch(src, /export const config/);
});

test('bands.mjs is untouched by PR 3a (still Blobs-backed, no Postgres import)', () => {
  const src = readFn('bands.mjs');
  assert.match(src, /@netlify\/blobs/);
  assert.doesNotMatch(src, /@neondatabase\/serverless/);
  assert.doesNotMatch(src, /from '\.\/_db\.mjs'/);
});

test('/api/bands and /api/seed-bands are distinct paths from each other and from /api/migrate', () => {
  const bandsSrc = readFn('bands_neon.mjs');
  const seedSrc = readFn('seed_bands.mjs');
  const migrateSrc = readFn('migrate.mjs');
  const extractPath = (src) => {
    const match = /export const config\s*=\s*\{\s*path:\s*['"]([^'"]+)['"]\s*\}/.exec(src);
    return match ? match[1] : null;
  };
  const bandsPath = extractPath(bandsSrc);
  const seedPath = extractPath(seedSrc);
  const migratePath = extractPath(migrateSrc);
  assert.equal(bandsPath, '/api/bands');
  assert.equal(seedPath, '/api/seed-bands');
  assert.equal(migratePath, '/api/migrate');
  const paths = new Set([bandsPath, seedPath, migratePath]);
  assert.equal(paths.size, 3, 'all three routes must be distinct');
});
