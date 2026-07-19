// Structural tests for the PR 3b Edit UI (frontend half of the write path).
//
// Mirrors signup-flow.test.mjs's approach: index.html is read as a string
// and asserted against with targeted substring/regex checks, since the
// project's test runner (node --test) has no DOM/browser. Live-DOM /
// end-to-end behavior is verified manually against the deploy preview per
// the existing project convention (see PR notes).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// -----------------------------------------------------------------------
// 1. Pencil icon in the node-card header.
// -----------------------------------------------------------------------

test('node card contains a pencil edit button with aria-label "Edit this band"', () => {
  assert.ok(
    INDEX_HTML.includes('aria-label="Edit this band"'),
    'Expected an element with aria-label="Edit this band" (the pencil icon button).'
  );
});

test('the pencil edit button uses the node-card__edit class and an inline SVG', () => {
  const idx = INDEX_HTML.indexOf('id="node-card-edit"');
  assert.ok(idx > 0, 'Expected #node-card-edit to exist.');
  const nearby = INDEX_HTML.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(nearby.includes('node-card__edit'), 'Expected the node-card__edit class near #node-card-edit.');
  assert.ok(nearby.includes('<svg'), 'Expected an inline <svg> icon inside the pencil button.');
});

test('the pencil button is hidden by default (JS toggles visibility per node)', () => {
  const idx = INDEX_HTML.indexOf('id="node-card-edit"');
  const tagEnd = INDEX_HTML.indexOf('>', idx);
  const openTag = INDEX_HTML.slice(Math.max(0, idx - 120), tagEnd);
  assert.ok(openTag.includes('hidden'), 'Expected the pencil button to carry the hidden attribute in markup.');
});

// -----------------------------------------------------------------------
// 2. Signed-out "Sign in to edit this band" hint.
//
// Historically this slot held a redundant second "Edit this band" pill
// button (#node-card-edit-btn) alongside the pencil in the top-right
// corner. Two edit affordances on the same card were redundant, and the
// pill was signed-in-only — signed-out visitors saw nothing that
// mentioned editing existed, and at least one collaborator asked whether
// the edit feature was broken because of it.
//
// The pill was removed in favor of a single edit affordance (the pencil)
// plus a signed-out discovery hint in the same slot. Deeper structural
// tests for the removal live in welcome-nudge-and-edit-cleanup.test.mjs.
// -----------------------------------------------------------------------

test('node card contains a "Sign in to edit this band" hint for signed-out visitors', () => {
  assert.ok(
    INDEX_HTML.includes('id="node-card-signin-hint"'),
    'Expected #node-card-signin-hint to exist as the signed-out affordance ' +
      'that used to be filled by the removed #node-card-edit-btn pill.'
  );
  const idx = INDEX_HTML.indexOf('id="node-card-signin-hint"');
  const blockEnd = INDEX_HTML.indexOf('</div>', idx);
  const block = INDEX_HTML.slice(idx, blockEnd);
  assert.ok(
    block.includes('to edit this band'),
    'Expected the visible text "to edit this band" inside the hint.'
  );
  assert.ok(
    INDEX_HTML.includes('id="node-card-signin-link"'),
    'Expected an inline #node-card-signin-link button that opens the sign-up popover.'
  );
});

test('renderEditAffordances gates the pencil on sign-in + band type', () => {
  assert.ok(
    INDEX_HTML.includes('function renderEditAffordances'),
    'Expected a renderEditAffordances() function.'
  );
  const idx = INDEX_HTML.indexOf('function renderEditAffordances');
  const blockEnd = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, blockEnd);
  assert.ok(block.includes("node.type === 'band'"), 'Expected a band-type check.');
  assert.ok(block.includes('loadCurrentUser()'), 'Expected a signed-in check via loadCurrentUser().');
});

// -----------------------------------------------------------------------
// 3. setSubmissionMode supports a third 'edit-band' mode.
// -----------------------------------------------------------------------

test("setSubmissionMode accepts an 'edit-band' mode string", () => {
  assert.ok(
    INDEX_HTML.includes("'edit-band'"),
    "Expected the string 'edit-band' to appear (setSubmissionMode mode value)."
  );
  const fnIdx = INDEX_HTML.indexOf('function setSubmissionMode');
  assert.ok(fnIdx > 0, 'Expected a setSubmissionMode function.');
  const fnEnd = INDEX_HTML.indexOf('\n    }', INDEX_HTML.indexOf('\n    }', fnIdx) + 1);
  const fnBody = INDEX_HTML.slice(fnIdx, fnEnd + 6);
  assert.ok(fnBody.includes("'edit-band'"), "Expected setSubmissionMode's body to branch on 'edit-band'.");
});

test('setSubmissionMode still accepts legacy boolean callers (backward compatible)', () => {
  // Pre-existing call sites pass literal `true`/`false` -- these must not
  // have been rewritten, since that would be an unrelated behavior change.
  assert.ok(INDEX_HTML.includes('setSubmissionMode(true)'), 'Expected at least one legacy setSubmissionMode(true) call site.');
  assert.ok(INDEX_HTML.includes('setSubmissionMode(false)'), 'Expected at least one legacy setSubmissionMode(false) call site.');
});

// -----------------------------------------------------------------------
// 4. Edit popover markup: title, metadata inputs, members list, add-member,
//    save/cancel buttons.
// -----------------------------------------------------------------------

test('edit-band panel exists with a title element and is hidden by default', () => {
  const idx = INDEX_HTML.indexOf('id="edit-band-panel"');
  assert.ok(idx > 0, 'Expected #edit-band-panel to exist.');
  const openTag = INDEX_HTML.slice(Math.max(0, idx - 60), INDEX_HTML.indexOf('>', idx));
  assert.ok(openTag.includes('hidden'), 'Expected #edit-band-panel to carry the hidden attribute by default.');
  assert.ok(INDEX_HTML.includes('id="edit-band-title"'), 'Expected an #edit-band-title element for the "Edit band: <name>" heading.');
});

test('edit-band form includes all documented band metadata inputs', () => {
  const requiredIds = [
    'edit-band-name', 'edit-band-city', 'edit-band-state', 'edit-band-country',
    'edit-band-years-active', 'edit-band-label', 'edit-band-genre', 'edit-band-albums'
  ];
  requiredIds.forEach(id => {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `Expected an input with id="${id}".`);
  });
});

test('edit-band form includes a members container and an add-member button', () => {
  assert.ok(INDEX_HTML.includes('id="edit-members-container"'), 'Expected #edit-members-container.');
  assert.ok(INDEX_HTML.includes('id="edit-add-member-row-btn"'), 'Expected #edit-add-member-row-btn.');
});

test('edit-band form has Save changes and Cancel buttons', () => {
  assert.ok(INDEX_HTML.includes('id="edit-band-save-btn"'), 'Expected #edit-band-save-btn.');
  const saveIdx = INDEX_HTML.indexOf('id="edit-band-save-btn"');
  const saveBlockEnd = INDEX_HTML.indexOf('</button>', saveIdx);
  assert.ok(INDEX_HTML.slice(saveIdx, saveBlockEnd).includes('Save changes'), 'Expected the label "Save changes".');
  assert.ok(INDEX_HTML.includes('id="edit-band-cancel-btn"'), 'Expected #edit-band-cancel-btn.');
});

test('buildEditMemberRow renders name, instrument1, instrument2, tenure fields plus a remove button', () => {
  assert.ok(INDEX_HTML.includes('function buildEditMemberRow'), 'Expected a buildEditMemberRow() function.');
  const idx = INDEX_HTML.indexOf('function buildEditMemberRow');
  const endIdx = INDEX_HTML.indexOf('function addEditMemberRow', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('edit-member-name-input'), 'Expected a name input class.');
  assert.ok(block.includes('edit-member-instrument1-input'), 'Expected an instrument1 input class.');
  assert.ok(block.includes('edit-member-instrument2-input'), 'Expected an instrument2 input class.');
  assert.ok(block.includes('edit-member-tenure-input'), 'Expected a tenure input class.');
  assert.ok(block.includes('data-remove-edit-row'), 'Expected a remove-row control.');
  assert.ok(block.includes('dataset.memberId'), 'Expected each row to track its membership via a member id data attribute.');
});

// -----------------------------------------------------------------------
// 5. Datalist suggest-match for adding members.
// -----------------------------------------------------------------------

test('an existing-members datalist is defined and referenced by the new-member-row name input', () => {
  assert.ok(INDEX_HTML.includes('id="existing-members-datalist"'), 'Expected <datalist id="existing-members-datalist">.');
  assert.ok(INDEX_HTML.includes("list', 'existing-members-datalist'") || INDEX_HTML.includes('list="existing-members-datalist"'),
    'Expected some input to bind list=existing-members-datalist.');
});

test('rebuildExistingMembersDatalist populates the datalist from rawBandsData members', () => {
  assert.ok(INDEX_HTML.includes('function rebuildExistingMembersDatalist'), 'Expected a rebuildExistingMembersDatalist() function.');
  const idx = INDEX_HTML.indexOf('function rebuildExistingMembersDatalist');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('rawBandsData'), 'Expected the datalist builder to read from rawBandsData.');
});

// -----------------------------------------------------------------------
// 6. Submit logic: PATCH /api/bands/:id and /api/bands/:id/members calls.
// -----------------------------------------------------------------------

test("client issues a PATCH to '/api/bands/' + bandId for metadata changes", () => {
  assert.ok(
    /method:\s*'PATCH'[\s\S]{0,400}\/api\/bands\/|\/api\/bands\/[\s\S]{0,200}method:\s*'PATCH'/.test(INDEX_HTML),
    'Expected a PATCH fetch call against a /api/bands/ URL.'
  );
  assert.ok(INDEX_HTML.includes("'/api/bands/' + editBandState.bandId"), 'Expected the metadata PATCH to target /api/bands/<bandId>.');
});

test("client issues a PATCH to '/api/bands/:id/members' for roster changes", () => {
  assert.ok(
    INDEX_HTML.includes("'/api/bands/' + editBandState.bandId + '/members'"),
    'Expected the roster PATCH to target /api/bands/<bandId>/members.'
  );
});

test('edit-band save handler sends the bearer token from the signed-in user', () => {
  const idx = INDEX_HTML.indexOf("document.getElementById('edit-band-save-btn')?.addEventListener");
  assert.ok(idx > 0, 'Expected the edit-band-save-btn click handler.');
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('user.token'), 'Expected the handler to read user.token.');
  assert.ok(block.includes("'Authorization': 'Bearer ' + user.token"), 'Expected an Authorization: Bearer <token> header.');
});

test('edit-band save handler fires metadata + roster PATCH requests in parallel with Promise.all when both changed', () => {
  const idx = INDEX_HTML.indexOf("document.getElementById('edit-band-save-btn')?.addEventListener");
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('Promise.all(requests)'), 'Expected Promise.all(requests) to fire both PATCH calls in parallel.');
});

test('edit-band save handler refreshes the graph after a successful write', () => {
  const idx = INDEX_HTML.indexOf("document.getElementById('edit-band-save-btn')?.addEventListener");
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('loadGraphData()'), 'Expected a loadGraphData() call after a successful save.');
  assert.ok(block.includes('buildMasterGraph(rows)'), 'Expected the refreshed rows to be rebuilt via buildMasterGraph().');
});

// -----------------------------------------------------------------------
// 7. postSharedSubmission swap for signed-in users.
// -----------------------------------------------------------------------

test('postSharedSubmission branches on a signed-in user and posts to /api/bands with a bearer token', () => {
  const idx = INDEX_HTML.indexOf('async function postSharedSubmission');
  assert.ok(idx > 0, 'Expected postSharedSubmission to still exist.');
  const endIdx = INDEX_HTML.indexOf('\n    }', INDEX_HTML.lastIndexOf('return (data && data.submission) || draft;', idx + 5000));
  const block = INDEX_HTML.slice(idx, endIdx + 6);
  assert.ok(block.includes("loadCurrentUser()"), 'Expected a signed-in check.');
  assert.ok(block.includes("fetch('/api/bands'"), 'Expected a fetch to /api/bands for signed-in users.');
  assert.ok(block.includes('BANDS_ENDPOINT'), 'Expected the legacy BANDS_ENDPOINT fallback for anonymous users to remain.');
});

// -----------------------------------------------------------------------
// 8. No accidental introduction of banned terminology.
// -----------------------------------------------------------------------

test('the PR 3b edit-band code does not introduce "scrape"/"crawl" terminology', () => {
  // Scoped to the edit-band module itself rather than the whole file --
  // index.html has pre-existing, unrelated comments mentioning web
  // crawlers (Facebook's link-preview crawler, Netlify's build-time form
  // crawler) that predate this PR and are out of scope to touch.
  const startIdx = INDEX_HTML.indexOf('PR 3b: Edit-band popover.');
  const endIdx = INDEX_HTML.indexOf("document.getElementById('edit-band-save-btn')");
  assert.ok(startIdx > 0 && endIdx > startIdx, 'Expected to locate the edit-band module bounds.');
  const block = INDEX_HTML.slice(startIdx, endIdx).toLowerCase();
  assert.ok(!block.includes('scrape'), 'Did not expect the word "scrape" in the edit-band module.');
  assert.ok(!block.includes('crawl'), 'Did not expect the word "crawl" in the edit-band module.');
});
