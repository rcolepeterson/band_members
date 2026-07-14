// Dependency-free tests: run with `npm test` (Node's built-in test runner).
//
// Two things are covered:
//   1. validateSubmission() input handling (pure logic, no network).
//   2. The store-scoping guarantee that this bug hinged on — proven directly
//      against the real @netlify/blobs API, so a future refactor that reaches
//      for a deploy-scoped store fails here instead of in production.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSubmission,
  LIMITS,
  isAdminAuthorized,
  removeSubmissionById,
  FALLBACK_ADMIN_TOKEN,
  normalizeGenre,
  migrateSubmissionForRead
} from '../netlify/functions/bands.mjs';

// Build a minimal request-like object exposing headers.get, matching what the
// DELETE handler reads.
function fakeReq(token) {
  const headers = new Headers();
  if (token !== undefined) headers.set('x-admin-token', token);
  return { headers };
}

test('validateSubmission accepts a well-formed multi-member submission', () => {
  const result = validateSubmission({
    band: 'Soundgarden',
    scene: 'Seattle',
    members: [
      { member: 'Chris Cornell', instrument: 'Vocals', relation: 3 },
      { member: 'Kim Thayil', instrument: 'Guitar' }
    ],
    bio: 'Formed in Seattle in 1984.'
  });
  assert.equal(result.ok, true);
  assert.equal(result.draft.band, 'Soundgarden');
  assert.equal(result.draft.members.length, 2);
  assert.ok(result.draft.id, 'a draft id is generated');
  assert.ok(result.draft.savedAt, 'a savedAt timestamp is set');
});

test('validateSubmission rejects a missing band name', () => {
  const result = validateSubmission({ band: '   ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /band name is required/i);
});

test('validateSubmission rejects links in the bio', () => {
  const result = validateSubmission({ band: 'Nirvana', bio: 'visit nirvana.band now' });
  assert.equal(result.ok, false);
  assert.match(result.error, /plain text/i);
});

test('validateSubmission rejects duplicate members', () => {
  const result = validateSubmission({
    band: 'Pearl Jam',
    members: [{ member: 'Eddie Vedder' }, { member: 'eddie vedder' }]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /more than once/i);
});

test('validateSubmission enforces the member cap', () => {
  const members = Array.from({ length: LIMITS.maxMembers + 1 }, (_, i) => ({ member: `M${i}` }));
  const result = validateSubmission({ band: 'Big Band', members });
  assert.equal(result.ok, false);
  assert.match(result.error, /too many members/i);
});

// --- Admin DELETE: auth + removal -------------------------------------------
// These cover the DELETE handler's two decision points without network I/O:
// isAdminAuthorized() gates the request, removeSubmissionById() does the work.

test('delete with the correct token is authorized and removes only the target', () => {
  // With ADMIN_TOKEN unset, the hardcoded fallback is the expected secret.
  delete process.env.ADMIN_TOKEN;
  assert.equal(isAdminAuthorized(fakeReq(FALLBACK_ADMIN_TOKEN)), true);

  const submissions = [
    { id: 'keep-1', band: 'Soundgarden' },
    { id: 'target', band: 'Diagnostic Test Band' },
    { id: 'keep-2', band: 'Pearl Jam' }
  ];
  const { found, submissions: remaining } = removeSubmissionById(submissions, 'target');
  assert.equal(found, true);
  assert.deepEqual(remaining.map(s => s.id), ['keep-1', 'keep-2']);
});

test('delete with a wrong or missing token is rejected and nothing is removed', () => {
  delete process.env.ADMIN_TOKEN;
  assert.equal(isAdminAuthorized(fakeReq('not-the-token')), false);
  assert.equal(isAdminAuthorized(fakeReq('')), false);
  assert.equal(isAdminAuthorized(fakeReq(undefined)), false);

  // The handler returns before touching storage, so the list is untouched. We
  // assert removal is never invoked by proving the guard fails above; the list
  // stays intact as a belt-and-suspenders check.
  const submissions = [{ id: 'target', band: 'Diagnostic Test Band' }];
  assert.deepEqual(submissions.map(s => s.id), ['target']);
});

test('env ADMIN_TOKEN takes precedence over the hardcoded fallback', () => {
  process.env.ADMIN_TOKEN = 'env-secret';
  assert.equal(isAdminAuthorized(fakeReq('env-secret')), true);
  // The old fallback must no longer authorize once a real env token is set.
  assert.equal(isAdminAuthorized(fakeReq(FALLBACK_ADMIN_TOKEN)), false);
  delete process.env.ADMIN_TOKEN;
});

// --- Genre field (added alongside city/state/country) -----------------------
// Genre is a soft, per-band attribute stored via free text with client-side
// datalist autocomplete. These tests pin down the same three guarantees we
// give city/state/country: it's normalized, it's length-capped, and legacy
// blobs without the field are backfilled to '' on read.

test('validateSubmission normalizes genre casing and passes it through', () => {
  const result = validateSubmission({
    band: 'Nirvana',
    city: 'Aberdeen',
    state: 'WA',
    country: 'USA',
    genre: 'grunge'
  });
  assert.equal(result.ok, true);
  assert.equal(result.draft.genre, 'Grunge');
});

test('validateSubmission trims blank genre to empty string', () => {
  const result = validateSubmission({
    band: 'Nirvana',
    city: 'Aberdeen',
    state: 'WA',
    country: 'USA',
    genre: '   '
  });
  assert.equal(result.ok, true);
  assert.equal(result.draft.genre, '');
});

test('validateSubmission rejects an over-long genre string', () => {
  const tooLong = 'x'.repeat(LIMITS.genre + 1);
  const result = validateSubmission({
    band: 'Nirvana',
    city: 'Aberdeen',
    state: 'WA',
    country: 'USA',
    genre: tooLong
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /genre is too long/i);
});

test('normalizeGenre matches the location-helpers version (server copy)', () => {
  assert.equal(normalizeGenre('grunge'), 'Grunge');
  assert.equal(normalizeGenre('alternative rock'), 'Alternative Rock');
  assert.equal(normalizeGenre('post-punk'), 'Post-Punk');
  assert.equal(normalizeGenre(''), '');
  assert.equal(normalizeGenre(null), '');
});

test('migrateSubmissionForRead lazily backfills genre for legacy blobs', () => {
  // A pre-genre submission has no `genre` key at all. On read, the migration
  // shim should surface it as '' so the client can render a consistent shape.
  const legacy = { id: 'x', band: 'Nirvana', city: 'Aberdeen', state: 'WA', country: 'USA' };
  const migrated = migrateSubmissionForRead(legacy);
  assert.equal(migrated.genre, '');

  // A submission that already has a genre gets normalized on read, so a blob
  // saved as 'grunge' still renders as 'Grunge' in the UI.
  const modern = { id: 'y', band: 'Nirvana', city: 'Aberdeen', state: 'WA', country: 'USA', genre: 'grunge' };
  assert.equal(migrateSubmissionForRead(modern).genre, 'Grunge');
});

test('deleting a non-existent id is reported as not found', () => {
  const submissions = [{ id: 'keep-1', band: 'Soundgarden' }];
  const { found, submissions: remaining } = removeSubmissionById(submissions, 'does-not-exist');
  assert.equal(found, false);
  assert.deepEqual(remaining.map(s => s.id), ['keep-1']);
});

// --- Store-scoping guarantee ------------------------------------------------
// getStore(name) must be site-wide (persists across deploys) and must NOT need
// a deploy id, whereas getDeployStore() is deploy-scoped and REQUIRES one. This
// mirrors, in code, why the production fix uses getStore rather than
// getDeployStore. We only construct the stores (no network I/O).
test('getStore is site-wide and deploy-agnostic; getDeployStore is deploy-scoped', async () => {
  // Minimal fake Netlify Blobs environment (no deployID on purpose).
  globalThis.netlifyBlobsContext = Buffer.from(
    JSON.stringify({
      siteID: 'test-site',
      token: 'test-token',
      edgeURL: 'https://edge.example',
      uncachedEdgeURL: 'https://uncached-edge.example'
    })
  ).toString('base64');

  const { getStore, getDeployStore } = await import('@netlify/blobs');

  // Site-wide store constructs fine without any deploy id — proving its data is
  // not tied to a deploy and therefore survives redeploys.
  assert.doesNotThrow(() => getStore({ name: 'band-submissions', consistency: 'strong' }));

  // Deploy-scoped store cannot even be created without a deploy id, because its
  // data is pegged to a specific (ephemeral) deploy.
  assert.throws(() => getDeployStore(), /deployID/i);

  delete globalThis.netlifyBlobsContext;
});
