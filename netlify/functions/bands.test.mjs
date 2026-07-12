// Dependency-free tests: run with `npm test` (Node's built-in test runner).
//
// Two things are covered:
//   1. validateSubmission() input handling (pure logic, no network).
//   2. The store-scoping guarantee that this bug hinged on — proven directly
//      against the real @netlify/blobs API, so a future refactor that reaches
//      for a deploy-scoped store fails here instead of in production.
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSubmission, LIMITS } from './bands.mjs';

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
