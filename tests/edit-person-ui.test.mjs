// Structural tests for the edit-person-bio PR's client half (musician bio
// editing). Mirrors edit-ui.test.mjs's approach: index.html is read as a
// string and asserted against with targeted substring/regex checks, since
// the project's test runner (node --test) has no DOM/browser. Live-DOM /
// end-to-end behavior is verified manually against the deploy preview per
// the existing project convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// -----------------------------------------------------------------------
// 1. #edit-person-panel markup: exists, hidden by default, has the
//    documented fields and buttons.
// -----------------------------------------------------------------------

test('#edit-person-panel exists and is hidden by default', () => {
  const idx = INDEX_HTML.indexOf('id="edit-person-panel"');
  assert.ok(idx > 0, 'Expected #edit-person-panel to exist.');
  const openTag = INDEX_HTML.slice(Math.max(0, idx - 60), INDEX_HTML.indexOf('>', idx));
  assert.ok(openTag.includes('hidden'), 'Expected #edit-person-panel to carry the hidden attribute by default.');
  assert.ok(openTag.includes('role="dialog"'), 'Expected #edit-person-panel to be a role="dialog".');
});

test('#edit-person-panel has a read-only musician name display (no rename control)', () => {
  assert.ok(INDEX_HTML.includes('id="edit-person-name"'), 'Expected an #edit-person-name element.');
  const idx = INDEX_HTML.indexOf('id="edit-person-name"');
  const tagEnd = INDEX_HTML.indexOf('>', idx);
  const openTag = INDEX_HTML.slice(Math.max(0, idx - 20), tagEnd + 1);
  assert.ok(
    !/^\s*<input/.test(openTag) && !openTag.includes('<input'),
    'Expected #edit-person-name to be a non-input element (read-only display), not an editable input.'
  );
});

test('#edit-person-panel has a bio textarea capped at 2000 characters', () => {
  assert.ok(INDEX_HTML.includes('id="edit-person-bio"'), 'Expected an #edit-person-bio textarea.');
  const idx = INDEX_HTML.indexOf('id="edit-person-bio"');
  const tagEnd = INDEX_HTML.indexOf('>', idx);
  const openTag = INDEX_HTML.slice(Math.max(0, idx - 20), tagEnd + 1);
  assert.ok(openTag.includes('<textarea'), 'Expected #edit-person-bio to be a <textarea>.');
  assert.ok(openTag.includes('maxlength="2000"'), 'Expected maxlength="2000" on the bio textarea.');
});

test('#edit-person-panel has a field note about the plain-text/no-links rule', () => {
  const idx = INDEX_HTML.indexOf('id="edit-person-bio"');
  const nearby = INDEX_HTML.slice(idx, idx + 500);
  assert.ok(
    nearby.includes('Plain text only') && nearby.includes('Links and promo URLs are not allowed'),
    'Expected the same plain-text/no-links field note used elsewhere (e.g. #member-bio) near #edit-person-bio.'
  );
});

test('#edit-person-panel has Save and Cancel controls, and a close button', () => {
  assert.ok(INDEX_HTML.includes('id="edit-person-save-btn"'), 'Expected #edit-person-save-btn.');
  const saveIdx = INDEX_HTML.indexOf('id="edit-person-save-btn"');
  const saveBlockEnd = INDEX_HTML.indexOf('</button>', saveIdx);
  assert.ok(INDEX_HTML.slice(saveIdx, saveBlockEnd).includes('Save bio'), 'Expected the label "Save bio".');
  assert.ok(INDEX_HTML.includes('id="edit-person-cancel-btn"'), 'Expected #edit-person-cancel-btn.');
  assert.ok(INDEX_HTML.includes('id="edit-person-close-btn"'), 'Expected #edit-person-close-btn (the \u00d7 close control).');
});

test('#edit-person-panel does NOT include instrument, tenure, or rename inputs (bio-only scope)', () => {
  const idx = INDEX_HTML.indexOf('id="edit-person-panel"');
  const endIdx = INDEX_HTML.indexOf('id="edit-person-form"', idx);
  const formEndIdx = INDEX_HTML.indexOf('</form>', endIdx);
  const block = INDEX_HTML.slice(idx, formEndIdx);
  assert.ok(!block.includes('edit-person-instrument'), 'Did not expect an instrument input inside the edit-person panel.');
  assert.ok(!block.includes('edit-person-tenure'), 'Did not expect a tenure input inside the edit-person panel.');
  assert.ok(!block.includes('<input') || !block.match(/edit-person-name["'].*type=["']text/), 'Expected the name field to remain read-only, not a text input.');
});

// -----------------------------------------------------------------------
// 2. openEditPersonPopover / closeEditPersonPopover wiring.
// -----------------------------------------------------------------------

test('openEditPersonPopover populates the name and bio fields from the node', () => {
  const idx = INDEX_HTML.indexOf('function openEditPersonPopover');
  assert.ok(idx > 0, 'Expected an openEditPersonPopover(node) function.');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes("getElementById('edit-person-name')"), 'Expected it to populate #edit-person-name.');
  assert.ok(block.includes("getElementById('edit-person-bio')"), 'Expected it to populate #edit-person-bio.');
  assert.ok(block.includes('node.bio'), 'Expected it to read node.bio for the textarea value.');
});

test('openEditPersonPopover resolves a backend id via findRawMemberByName with a name fallback', () => {
  const idx = INDEX_HTML.indexOf('function openEditPersonPopover');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('findRawMemberByName'), 'Expected openEditPersonPopover to call findRawMemberByName.');
  assert.ok(block.includes('node.id'), 'Expected a fallback to node.id (the display name) when no raw record is found.');
});

test('closeEditPersonPopover hides the panel and clears state', () => {
  const idx = INDEX_HTML.indexOf('function closeEditPersonPopover');
  assert.ok(idx > 0, 'Expected a closeEditPersonPopover() function.');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('panel.hidden = true'), 'Expected the panel to be hidden on close.');
});

test('cancel and close buttons are wired to closeEditPersonPopover', () => {
  assert.ok(
    INDEX_HTML.includes("getElementById('edit-person-close-btn')?.addEventListener('click', closeEditPersonPopover)"),
    'Expected the close (\u00d7) button wired to closeEditPersonPopover.'
  );
  assert.ok(
    INDEX_HTML.includes("getElementById('edit-person-cancel-btn')?.addEventListener('click', closeEditPersonPopover)"),
    'Expected the Cancel button wired to closeEditPersonPopover.'
  );
});

// -----------------------------------------------------------------------
// 3. Submit handler: POST /api/edit-person, bearer token, local graph
//    update, node-card refresh.
// -----------------------------------------------------------------------

test("edit-person form submit handler POSTs to '/api/edit-person'", () => {
  const idx = INDEX_HTML.indexOf("getElementById('edit-person-form')?.addEventListener('submit'");
  assert.ok(idx > 0, 'Expected the #edit-person-form submit handler.');
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes("fetch('/api/edit-person'"), 'Expected a fetch call to /api/edit-person.');
  assert.ok(block.includes("method: 'POST'"), 'Expected the request method to be POST.');
});

test('edit-person submit handler sends the bearer token from the signed-in user', () => {
  const idx = INDEX_HTML.indexOf("getElementById('edit-person-form')?.addEventListener('submit'");
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('loadCurrentUser()'), 'Expected a signed-in check via loadCurrentUser().');
  assert.ok(block.includes("'Authorization': 'Bearer ' + user.token"), 'Expected an Authorization: Bearer <token> header.');
});

test('edit-person submit handler sends { personId, bio } in the request body', () => {
  const idx = INDEX_HTML.indexOf("getElementById('edit-person-form')?.addEventListener('submit'");
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('personId: editPersonState.personId'), 'Expected personId in the JSON body.');
  assert.ok(block.includes('bio }'), 'Expected bio in the JSON body.');
});

test('edit-person submit handler updates the local graph node and reopens the node card on success (no full reload)', () => {
  const idx = INDEX_HTML.indexOf("getElementById('edit-person-form')?.addEventListener('submit'");
  const endIdx = INDEX_HTML.indexOf('\n    });', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('graphState.master.nodes'), 'Expected a direct update to graphState.master.nodes.');
  assert.ok(block.includes('node.bio = body.bio'), 'Expected node.bio to be updated from the response body.');
  // The submit handler closes the edit panel, and closeEditPersonPopover()
  // in turn reopens the previously-hidden node card via its
  // reopenNodeAfterClose bookkeeping. So the submit block itself no
  // longer calls openNodeCard directly; it just needs to close.
  assert.ok(block.includes('closeEditPersonPopover()'), 'Expected the edit panel to be closed after a successful save (which reopens the node card).');
  // Strip // line comments before checking for an actual loadGraphData()
  // *call* -- the handler's own explanatory comment mentions loadGraphData()
  // by name as a contrast to what it does NOT do, which would otherwise
  // produce a false positive here.
  const codeOnly = block.replace(/\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes('loadGraphData()'), 'Did not expect a full loadGraphData() call for a single-field bio edit.');
});

test('opening the edit-person panel hides the underlying node card, and closing it reopens the same node', () => {
  const openIdx = INDEX_HTML.indexOf('function openEditPersonPopover');
  const openEnd = INDEX_HTML.indexOf('\n    }', openIdx);
  const openBlock = INDEX_HTML.slice(openIdx, openEnd);
  assert.ok(openBlock.includes('reopenNodeAfterClose = node'), 'Expected the open handler to record the node so it can be reopened later.');
  assert.ok(openBlock.includes('closeNodeCard'), 'Expected the open handler to close the underlying node card (avoids z-index overlap on mobile).');

  const closeIdx = INDEX_HTML.indexOf('function closeEditPersonPopover');
  const closeEnd = INDEX_HTML.indexOf('\n    }', closeIdx);
  const closeBlock = INDEX_HTML.slice(closeIdx, closeEnd);
  // The reopen goes through selectMemberNode (the unified musician-selection
  // entry point) rather than openNodeCard directly, so the member's band
  // highlight is restored along with the card. See member-selection.test.mjs.
  assert.ok(
    closeBlock.includes('selectMemberNode(nodeToReopen'),
    'Expected the close handler to reopen the previously-hidden node card for the same node.'
  );
});

// -----------------------------------------------------------------------
// 4. Regression: the band pencil / edit-band flow still works, and the
//    edit-person addition didn't fork the shared affordance code path.
// -----------------------------------------------------------------------

test('regression: renderEditAffordances still routes band nodes to openEditBandPopover', () => {
  const idx = INDEX_HTML.indexOf('function renderEditAffordances');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes("node.type === 'band'"), 'Expected the band-type check to still be present.');
  assert.ok(block.includes('openEditBandPopover(node)'), 'Expected band nodes to still route to openEditBandPopover.');
});

test('regression: renderEditAffordances also routes musician nodes to openEditPersonPopover', () => {
  const idx = INDEX_HTML.indexOf('function renderEditAffordances');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes("node.type === 'person'"), 'Expected a person-type check.');
  assert.ok(block.includes('openEditPersonPopover(node)'), 'Expected musician nodes to route to openEditPersonPopover.');
});

test('regression: the pencil aria-label/title switches between "Edit this band" and "Edit this musician"', () => {
  const idx = INDEX_HTML.indexOf('function renderEditAffordances');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes("'Edit this musician'"), 'Expected the musician-specific label string.');
  assert.ok(block.includes("'Edit this band'"), 'Expected the band-specific label string to remain.');
});

test('regression: the sign-in hint text is node-type aware via #node-card-signin-hint-text', () => {
  assert.ok(INDEX_HTML.includes('id="node-card-signin-hint-text"'), 'Expected a #node-card-signin-hint-text span.');
  const idx = INDEX_HTML.indexOf('function renderEditAffordances');
  const endIdx = INDEX_HTML.indexOf('\n    }', idx);
  const block = INDEX_HTML.slice(idx, endIdx);
  assert.ok(block.includes('to edit this musician.'), 'Expected the musician-specific hint text.');
  assert.ok(block.includes('to edit this band.'), 'Expected the band-specific hint text to remain.');
});
