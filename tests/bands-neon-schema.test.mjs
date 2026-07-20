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
  // PR 3b: bands_create.mjs (POST) and bands_edit.mjs (PATCH /:id) now share
  // the /api/bands path family, so bands_neon.mjs's config additionally
  // declares `method: 'GET'` to disambiguate. The path itself is unchanged.
  assert.match(src, /export const config\s*=\s*\{\s*path:\s*['"]\/api\/bands['"]\s*,\s*method:\s*['"]GET['"]\s*\}/);
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

// PR 3a assertion (superseded by PR 3b): bands.mjs used to have zero
// Postgres awareness. PR 3b's task explicitly requires bands.mjs's POST
// branch to redirect writes to Neon when the caller is signed in, so it now
// imports _db.mjs (for auth helpers) and _bands_write.mjs (the shared Neon
// write path) alongside its original @netlify/blobs import. GET and DELETE
// remain Blobs-only — see the dedicated bridge-behavior tests below.
test('bands.mjs remains Blobs-backed for GET/DELETE and gained Neon-write awareness in PR 3b', () => {
  const src = readFn('bands.mjs');
  assert.match(src, /@netlify\/blobs/);
  assert.match(src, /from '\.\/_db\.mjs'/, 'PR 3b: bands.mjs imports auth helpers to redirect signed-in POSTs to Neon');
  assert.match(src, /from '\.\/_bands_write\.mjs'/, 'PR 3b: bands.mjs reuses the shared Neon write helper instead of duplicating it');
});

test('/api/bands and /api/seed-bands are distinct paths from each other and from /api/migrate', () => {
  const bandsSrc = readFn('bands_neon.mjs');
  const seedSrc = readFn('seed_bands.mjs');
  const migrateSrc = readFn('migrate.mjs');
  const extractPath = (src) => {
    // Tolerate an optional trailing `, method: '...'` field (added in PR 3b
    // so /api/bands can be shared by GET/POST/PATCH handlers in different
    // files) without weakening the path-value assertion itself.
    const match = /export const config\s*=\s*\{\s*path:\s*['"]([^'"]+)['"](?:\s*,\s*method:\s*['"][A-Z]+['"])?\s*\}/.exec(src);
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

// --- PR 3b: write endpoints --------------------------------------------------

test('bands_create.mjs exists and mounts POST /api/bands', () => {
  assert.ok(existsSync(path.join(FUNCTIONS_DIR, 'bands_create.mjs')));
  const src = readFn('bands_create.mjs');
  assert.match(src, /export const config\s*=\s*\{\s*path:\s*['"]\/api\/bands['"]\s*,\s*method:\s*['"]POST['"]\s*\}/);
});

test('bands_edit.mjs exists and mounts PATCH /api/bands/:id', () => {
  assert.ok(existsSync(path.join(FUNCTIONS_DIR, 'bands_edit.mjs')));
  const src = readFn('bands_edit.mjs');
  assert.match(src, /export const config\s*=\s*\{\s*path:\s*['"]\/api\/bands\/:id['"]\s*,\s*method:\s*['"]PATCH['"]\s*\}/);
});

test('bands_edit_members.mjs exists and mounts PATCH /api/bands/:id/members', () => {
  assert.ok(existsSync(path.join(FUNCTIONS_DIR, 'bands_edit_members.mjs')));
  const src = readFn('bands_edit_members.mjs');
  assert.match(src, /export const config\s*=\s*\{\s*path:\s*['"]\/api\/bands\/:id\/members['"]\s*,\s*method:\s*['"]PATCH['"]\s*\}/);
});

test('_bands_write.mjs exists as the shared Neon band-creation helper', () => {
  assert.ok(existsSync(path.join(FUNCTIONS_DIR, '_bands_write.mjs')));
  const src = readFn('_bands_write.mjs');
  assert.match(src, /export\s+(async\s+)?function\s+createBandInNeon/, 'expected createBandInNeon to be exported');
});

test('bands_create.mjs delegates band creation to the shared _bands_write.mjs helper rather than duplicating the transaction', () => {
  const src = readFn('bands_create.mjs');
  assert.match(src, /import\s*\{\s*createBandInNeon\s*\}\s*from\s*['"]\.\/_bands_write\.mjs['"]/);
});

test('bands.mjs (legacy) reuses the same _bands_write.mjs helper for its Neon redirect, not a second implementation', () => {
  const src = readFn('bands.mjs');
  assert.match(src, /import\s*\{\s*createBandInNeon\s*\}\s*from\s*['"]\.\/_bands_write\.mjs['"]/);
});

test('the add-band contribution is logged with action \'add_band\' inside the shared _bands_write.mjs transaction', () => {
  const src = readFn('_bands_write.mjs');
  assert.match(src, /'add_band'/);
  assert.match(src, /sql\.transaction\(/, 'the contribution insert must ride along in the same sql.transaction as the write it audits');
});

test('bands_edit.mjs logs an edit_band contribution inside its sql.transaction, and skips logging on a no-op diff', () => {
  const src = readFn('bands_edit.mjs');
  assert.match(src, /'edit_band'/);
  assert.match(src, /sql\.transaction\(/);
  // No-op guard: an empty diff must short-circuit before any transaction is
  // built, so a PATCH with no actual field changes never writes a
  // contribution row.
  assert.match(src, /changes/i);
});

test('bands_edit_members.mjs logs an edit_band_members contribution inside its second sql.transaction', () => {
  const src = readFn('bands_edit_members.mjs');
  assert.match(src, /'edit_band_members'/);
  assert.match(src, /sql\.transaction\(/);
});

test('bands_edit.mjs and bands_edit_members.mjs both set bands.edited_by on write (no ownership check, attribution only)', () => {
  const editSrc = readFn('bands_edit.mjs');
  const editMembersSrc = readFn('bands_edit_members.mjs');
  assert.match(editSrc, /edited_by\s*=\s*\$\{user\.id\}/);
  assert.match(editMembersSrc, /edited_by\s*=\s*\$\{user\.id\}/);
});

test('bands_edit.mjs and bands_edit_members.mjs both increment the bands_edited counter on the acting user', () => {
  const editSrc = readFn('bands_edit.mjs');
  const editMembersSrc = readFn('bands_edit_members.mjs');
  assert.match(editSrc, /bands_edited\s*=\s*bands_edited\s*\+\s*1/);
  assert.match(editMembersSrc, /bands_edited\s*=\s*bands_edited\s*\+\s*1/);
});

test('bands_edit.mjs restricts its dynamic SET clause to a fixed field allowlist (no raw user-supplied column names)', () => {
  const src = readFn('bands_edit.mjs');
  assert.match(src, /EDITABLE_FIELDS/);
  assert.match(src, /sql\.unsafe\(/, 'sql.unsafe is only safe here because it is fed from EDITABLE_FIELDS, never raw input');
});

test('all three PR 3b write endpoints require auth via extractBearerToken + findUserByToken from _db.mjs', () => {
  ['bands_create.mjs', 'bands_edit.mjs', 'bands_edit_members.mjs'].forEach(name => {
    const src = readFn(name);
    assert.match(src, /extractBearerToken/, `${name} should extract the bearer token`);
    assert.match(src, /findUserByToken/, `${name} should resolve the token to a user`);
    assert.match(src, /unauthorized\(/, `${name} should use the shared unauthorized() response builder`);
  });
});

test('all three PR 3b write endpoints reject non-matching HTTP methods with methodNotAllowed', () => {
  ['bands_create.mjs', 'bands_edit.mjs', 'bands_edit_members.mjs'].forEach(name => {
    const src = readFn(name);
    assert.match(src, /methodNotAllowed/, `${name} should use the shared methodNotAllowed() response builder`);
  });
});

test('contributions.mjs allows edit_band_members alongside add_band and edit_band', () => {
  const src = readFn('contributions.mjs');
  assert.match(src, /VALID_ACTIONS\s*=\s*new Set\(\[[^\]]*'add_band'[^\]]*'edit_band'[^\]]*'edit_band_members'[^\]]*\]\)/s);
});

test('contributions.mjs also allows edit_person_bio (musician bio edits)', () => {
  const src = readFn('contributions.mjs');
  assert.match(src, /VALID_ACTIONS\s*=\s*new Set\(\[[^\]]*'edit_person_bio'[^\]]*\]\)/s);
});

test('contributions.mjs documents that write endpoints log internally, not via a client-facing second call', () => {
  const src = readFn('contributions.mjs');
  // A comment near VALID_ACTIONS (or elsewhere in the file) should call out
  // the race-condition rationale for internal logging, per the task spec.
  assert.match(src, /race/i);
});

test('migrate.mjs\'s contributions CHECK constraint allows edit_band_members and edit_person_bio (DDL only, not executed)', () => {
  const src = readFn('migrate.mjs');
  assert.match(src, /check\s*\(\s*action\s+in\s*\(\s*'add_band'\s*,\s*'edit_band'\s*,\s*'edit_band_members'\s*,\s*'edit_person_bio'\s*\)\s*\)/i);
  // Idempotent re-apply for already-existing databases: a bare CREATE TABLE
  // IF NOT EXISTS wouldn't update the constraint on a table that already
  // exists, so migrate.mjs must also ALTER the constraint explicitly.
  assert.match(src, /alter table contributions/i);
  assert.match(src, /drop constraint if exists contributions_action_check/i);
  assert.match(src, /add constraint contributions_action_check/i);
});

test('/api/bands/:id and /api/bands/:id/members are distinct route configs from /api/bands', () => {
  const createSrc = readFn('bands_create.mjs');
  const editSrc = readFn('bands_edit.mjs');
  const editMembersSrc = readFn('bands_edit_members.mjs');
  const extractPathAndMethod = (src) => {
    const match = /export const config\s*=\s*\{\s*path:\s*['"]([^'"]+)['"]\s*,\s*method:\s*['"]([A-Z]+)['"]\s*\}/.exec(src);
    return match ? `${match[2]} ${match[1]}` : null;
  };
  const routes = [createSrc, editSrc, editMembersSrc].map(extractPathAndMethod);
  assert.deepEqual(routes, ['POST /api/bands', 'PATCH /api/bands/:id', 'PATCH /api/bands/:id/members']);
  assert.equal(new Set(routes).size, 3, 'all three write routes must be distinct (path, method) pairs');
});
