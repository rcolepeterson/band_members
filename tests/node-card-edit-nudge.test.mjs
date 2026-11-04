// Signed-out pencil nudge (2026-11-04): on a band or musician card the
// pencil used to vanish for signed-out visitors, leaving only a "Sign in
// to edit" text hint buried below the members list. The pencil is now the
// nudge: it stays visible when signed out and opens the sign-in panel,
// and the bottom hint no longer shows, keeping a single edit affordance.
//
// House style: index.html read as a string, targeted regex checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'graph/index.html'), 'utf8');

function renderEditAffordancesBody() {
  const fnMatch = INDEX_HTML.match(
    /function\s+renderEditAffordances\s*\(\s*node\s*\)\s*\{([\s\S]*?)\n\s{4}\}/
  );
  assert.ok(fnMatch, 'Expected function renderEditAffordances(node) in index.html.');
  return fnMatch[1];
}

test('pencil stays visible for signed-out band/musician nodes (the nudge)', () => {
  const body = renderEditAffordancesBody();
  assert.match(
    body,
    /nodeCardEditBtn\.hidden\s*=\s*!\(canEdit\s*\|\|\s*showSigninHint\)/,
    'Expected the pencil to be visible when canEdit OR showSigninHint, ' +
      'so signed-out visitors still see an edit affordance at the top of the card.'
  );
});

test('signed-out pencil click opens the sign-in panel, signed-in click still edits', () => {
  const body = renderEditAffordancesBody();
  assert.match(
    body,
    /nodeCardEditBtn\.onclick\s*=\s*canEdit\s*\?\s*\(ev\)\s*=>\s*\{[^}]*openEditBandPopover\(node\)/,
    'Expected the pencil onclick to still call openEditBandPopover(node) when canEdit is true.'
  );
  assert.match(
    body,
    /:\s*showSigninHint\s*\?\s*\(ev\)\s*=>\s*\{\s*ev\.stopPropagation\(\);\s*openSignupPopover\(\);\s*\}/,
    'Expected the pencil onclick to fall back to openSignupPopover() when signed out.'
  );
});

test('bottom sign-in hint no longer shows (pencil is the single nudge)', () => {
  const body = renderEditAffordancesBody();
  assert.match(
    body,
    /nodeCardSigninHint\.hidden\s*=\s*true/,
    'Expected the bottom hint to stay hidden now that the pencil carries the nudge.'
  );
  // Markup itself stays: existing structural tests assert its existence.
  assert.ok(
    INDEX_HTML.includes('id="node-card-signin-hint"'),
    'Expected the #node-card-signin-hint markup to remain in the card.'
  );
});
