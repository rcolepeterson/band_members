// Tests for the welcome-nudge + edit-affordance cleanup.
//
// Two coordinated changes are locked in here:
//
//   1. Welcome nudge for first-time signed-out visitors. Anchored under
//      #add-band-btn on desktop and #mobile-menu-btn on mobile, with a
//      Got-it / Sign-up-→ pair. Dismissed on click, on sign-in, or by
//      Escape; localStorage['bmft-welcome-seen'] persists the dismissal.
//      The nudge only exists to move signed-out visitors toward the
//      sign-up gate — one collaborator opened band cards, didn't see any
//      edit affordance, and asked whether editing was broken. The
//      affordance was gated on sign-in the whole time; nothing surfaced
//      that requirement in the graph UI. If this test suite fails, that
//      onboarding regression is back.
//
//   2. Single edit affordance on the node card. The bottom "Edit this
//      band" pill (#node-card-edit-btn) was removed in favor of the
//      top-right pencil (#node-card-edit) as the only edit control.
//      Signed-out visitors now see a "Sign in to edit this band" hint
//      in the same slot instead, wired to the same trigger the welcome
//      nudge uses.
//
// These are static-HTML/JS regex checks in the same style as
// mobile-toolbar-parity.test.mjs — no browser, no DOM. The point is to
// catch structural regressions during CI, not to prove runtime behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// ----------------------------------------------------------------------
// 1. Edit-affordance cleanup: the bottom pill is gone; the pencil stays.
// ----------------------------------------------------------------------

test('bottom "Edit this band" pill (#node-card-edit-btn) has been removed', () => {
  // The pill lived at index.html:2619 before the cleanup. If it comes
  // back, either the id was reintroduced or someone reverted the PR.
  assert.ok(
    !INDEX_HTML.includes('id="node-card-edit-btn"'),
    'Expected #node-card-edit-btn to be removed from index.html. ' +
      'The node card now has a single edit affordance — the top-right ' +
      'pencil (#node-card-edit). Reintroducing the bottom pill produces ' +
      'two edit buttons on the same card, which is the exact redundancy ' +
      'the cleanup addressed.'
  );
  // Its CSS should also be gone so we don't leave dead selectors.
  assert.ok(
    !INDEX_HTML.includes('.node-card__edit-btn'),
    'Expected .node-card__edit-btn CSS selectors to be removed. ' +
      'The pill they styled no longer exists in the DOM.'
  );
  // And the cached DOM lookup should be gone from the JS.
  assert.ok(
    !INDEX_HTML.includes('nodeCardEditTextBtn'),
    'Expected the nodeCardEditTextBtn variable and its handler binding ' +
      'to be removed. Leaving them behind produces a null-deref-shaped ' +
      'dead branch in renderEditAffordances.'
  );
});

test('pencil edit button (#node-card-edit) still exists and is still wired up', () => {
  // The remaining edit affordance. If this is gone, signed-in users
  // have no way to open the edit popover from the node card at all.
  assert.match(
    INDEX_HTML,
    /id="node-card-edit"[^>]*aria-label="Edit this band"/,
    'Expected #node-card-edit (the pencil) to still exist with its ' +
      'aria-label. This is now the single edit affordance on the node card.'
  );
  assert.match(
    INDEX_HTML,
    /nodeCardEditBtn\.onclick\s*=\s*canEdit\s*\?\s*\(ev\)\s*=>\s*\{[^}]*openEditBandPopover\(node\)/,
    'Expected the pencil onclick to still call openEditBandPopover(node) ' +
      'when canEdit is true. Without this the pencil is a visual affordance ' +
      'with no behavior behind it.'
  );
});

// ----------------------------------------------------------------------
// 2. "Sign in to edit" hint for signed-out band cards.
// ----------------------------------------------------------------------

test('node card has a "Sign in to edit this band" hint for signed-out visitors', () => {
  assert.match(
    INDEX_HTML,
    /id="node-card-signin-hint"/,
    'Expected #node-card-signin-hint markup in the node card. ' +
      'This is the signed-out visitor\'s only in-card discovery path ' +
      'for the edit feature.'
  );
  assert.match(
    INDEX_HTML,
    /id="node-card-signin-link"[^>]*>Sign in<\/button>/,
    'Expected the hint to contain a <button id="node-card-signin-link">Sign in</button>. ' +
      'The inline "Sign in" text must be a button (or link) so it can ' +
      'route the user to the sign-up popover.'
  );
});

test('renderEditAffordances shows the pencil OR the hint, never both', () => {
  // Grab the function body.
  const fnMatch = INDEX_HTML.match(
    /function\s+renderEditAffordances\s*\(\s*node\s*\)\s*\{([\s\S]*?)\n\s{4}\}/
  );
  assert.ok(fnMatch, 'Expected function renderEditAffordances(node) in index.html.');
  const body = fnMatch[1];

  // The two visibility branches must be mutually exclusive: canEdit gates
  // the pencil, showSigninHint gates the hint, and showSigninHint is
  // signed-out band nodes only. Musician nodes get neither.
  assert.match(
    body,
    /const\s+isBand\s*=\s*node\.type\s*===\s*['"]band['"]/,
    'renderEditAffordances must gate on node.type === "band". ' +
      'Musician nodes should not see edit affordances or the sign-in hint.'
  );
  assert.match(
    body,
    /const\s+canEdit\s*=\s*isBand\s*&&\s*signedIn/,
    'canEdit must require both isBand and signedIn.'
  );
  assert.match(
    body,
    /const\s+showSigninHint\s*=\s*isBand\s*&&\s*!signedIn/,
    'showSigninHint must require isBand and NOT signedIn — otherwise ' +
      'signed-in users see the hint alongside the pencil.'
  );
  // The hint's inline "Sign in" link must route through openSignupPopover
  // so the welcome-nudge CTA and the in-card hint share one code path.
  assert.match(
    body,
    /nodeCardSigninLink\.onclick[\s\S]{0,200}openSignupPopover\s*\(\s*\)/,
    'Expected the sign-in hint\'s click handler to call openSignupPopover(). ' +
      'Sharing this trigger with the welcome nudge keeps the sign-up entry ' +
      'points from drifting apart over time.'
  );
});

test('openSignupPopover helper exists and dispatches to the right trigger by viewport', () => {
  // The helper is the single funnel from any "sign in" affordance
  // (welcome nudge CTA, node-card hint) into the existing add-band
  // popover, which already hosts the sign-up gate.
  const fnMatch = INDEX_HTML.match(
    /function\s+openSignupPopover\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/
  );
  assert.ok(fnMatch, 'Expected function openSignupPopover() in index.html.');
  const body = fnMatch[1];
  // Must consult the mobile media query so it prefers #mobile-add-band-btn
  // on mobile — that trigger has the hookPopoverForMobile bottom-sheet
  // path wired to it. Falling straight through to #add-band-btn on
  // mobile would open a popover inside .graph-overlay-top (display:none),
  // which is the exact bug PR #42/#44 fixed.
  assert.match(
    body,
    /matchMedia\(['"]\(max-width:\s*900px\)['"]\)/,
    'openSignupPopover must consult (max-width: 900px) so it picks the ' +
      'mobile trigger on mobile. Without this the sign-up path is stranded ' +
      'inside .graph-overlay-top (display:none) on phones.'
  );
  assert.match(
    body,
    /getElementById\(['"]mobile-add-band-btn['"]\)/,
    'openSignupPopover must reference #mobile-add-band-btn as its mobile ' +
      'trigger.'
  );
  assert.match(
    body,
    /getElementById\(['"]add-band-btn['"]\)/,
    'openSignupPopover must reference #add-band-btn as its desktop ' +
      'trigger.'
  );
});

// ----------------------------------------------------------------------
// 3. Welcome nudge markup + CSS + init hook.
// ----------------------------------------------------------------------

test('welcome nudge markup exists with title, body, dismiss, and CTA buttons', () => {
  assert.match(
    INDEX_HTML,
    /<div[^>]*id="welcome-nudge"[^>]*hidden/,
    'Expected <div id="welcome-nudge" ... hidden> markup. The nudge must ' +
      'start hidden and only become visible after initWelcomeNudge decides ' +
      'to show it.'
  );
  assert.match(
    INDEX_HTML,
    /id="welcome-nudge-dismiss"/,
    'Expected a #welcome-nudge-dismiss ("Got it") button inside the nudge.'
  );
  assert.match(
    INDEX_HTML,
    /id="welcome-nudge-cta"/,
    'Expected a #welcome-nudge-cta ("Sign up →") button inside the nudge.'
  );
  // Caret element makes the visual connection to the anchor button.
  assert.match(
    INDEX_HTML,
    /class="welcome-nudge__caret"/,
    'Expected a .welcome-nudge__caret element. Without it the nudge just ' +
      'floats near the top-right corner with no visual link to the button ' +
      'it\'s prompting the user to press.'
  );
});

test('welcome nudge CSS positions it as position:fixed with a fade-in transition', () => {
  // Locate the .welcome-nudge base rule.
  const ruleMatch = INDEX_HTML.match(/\.welcome-nudge\s*\{([^}]+)\}/);
  assert.ok(ruleMatch, 'Expected a .welcome-nudge CSS rule.');
  const rule = ruleMatch[1];
  assert.match(rule, /position:\s*fixed/, 'The welcome nudge must be position:fixed so it can be anchored to a moving button.');
  assert.match(rule, /opacity:\s*0/, 'The welcome nudge must start opacity:0 for the fade-in transition to work.');
  assert.match(
    INDEX_HTML,
    /\.welcome-nudge\.is-visible\s*\{[^}]*opacity:\s*1/,
    'Expected a .welcome-nudge.is-visible rule that sets opacity:1. This is ' +
      'the class initWelcomeNudge toggles to reveal the nudge.'
  );
});

test('initWelcomeNudge gates on signed-in state, dismissed flag, and delays 2s', () => {
  const fnMatch = INDEX_HTML.match(
    /\(function\s+initWelcomeNudge\(\)\s*\{([\s\S]*?)\n\s{8}\}\)\(\);/
  );
  assert.ok(fnMatch, 'Expected an initWelcomeNudge IIFE in index.html.');
  const body = fnMatch[1];

  // Gate 1: skip if signed in. Anonymous-visitor onboarding only.
  assert.match(
    body,
    /if\s*\(\s*loadCurrentUser\(\)\s*\)\s*return\s*;/,
    'initWelcomeNudge must early-return when loadCurrentUser() is truthy. ' +
      'Signed-in visitors do not need the sign-up nudge.'
  );
  // Gate 2: skip if the flag is already set.
  assert.match(
    body,
    /alreadyDismissed\(\)/,
    'initWelcomeNudge must check the localStorage flag before showing.'
  );
  assert.match(
    body,
    /localStorage\.getItem\(\s*STORAGE_KEY\s*\)/,
    'The dismissed check must read from localStorage. If the flag lives ' +
      'anywhere else it does not persist across sessions.'
  );
  // Gate 3: 2s delay so the graph has fully settled first.
  assert.match(
    body,
    /setTimeout\(\s*showNudge\s*,\s*2000\s*\)/,
    'Expected a 2000ms delay before showNudge is called so the nudge does ' +
      'not fight the initial graph fade-in / force-layout settle.'
  );
});

test('welcome nudge storage key is bmft-welcome-seen', () => {
  // Pin the storage key so we don't accidentally rename it and lose
  // the "already dismissed" signal for every current user.
  assert.match(
    INDEX_HTML,
    /STORAGE_KEY\s*=\s*['"]bmft-welcome-seen['"]/,
    "Expected the welcome nudge to store its dismissed flag under the " +
      "'bmft-welcome-seen' localStorage key. Renaming this key resurfaces " +
      "the nudge for every returning visitor."
  );
});

test('welcome nudge dismisses on Got-it, CTA, sign-in, and Escape', () => {
  const fnMatch = INDEX_HTML.match(
    /\(function\s+initWelcomeNudge\(\)\s*\{([\s\S]*?)\n\s{8}\}\)\(\);/
  );
  assert.ok(fnMatch, 'Expected an initWelcomeNudge IIFE in index.html.');
  const body = fnMatch[1];

  // Got it
  assert.match(
    body,
    /dismissBtn\.addEventListener\(\s*['"]click['"]\s*,\s*\(\)\s*=>\s*hideNudge\(/,
    'The Got-it button must call hideNudge() on click.'
  );
  // CTA also opens the sign-up popover.
  assert.match(
    body,
    /ctaBtn\.addEventListener\(\s*['"]click['"][\s\S]{0,200}openSignupPopover\(\)/,
    'The Sign-up CTA must open the sign-up popover in addition to dismissing ' +
      'the nudge. Without this the CTA is just another Got-it.'
  );
  // Escape closes.
  assert.match(
    body,
    /event\.key\s*!==?\s*['"]Escape['"][\s\S]{0,200}hideNudge/,
    'Expected an Escape-key listener that calls hideNudge.'
  );
  // Sign-in dismisses via the exposed hook.
  assert.match(
    body,
    /window\.__dismissWelcomeNudge\s*=\s*hideNudge/,
    'initWelcomeNudge must expose hideNudge as window.__dismissWelcomeNudge ' +
      'so setSignedInState can dismiss the nudge when the user signs in.'
  );
  // And setSignedInState must actually call it.
  assert.match(
    INDEX_HTML,
    /function setSignedInState[\s\S]{0,600}window\.__dismissWelcomeNudge/,
    'setSignedInState must dismiss the welcome nudge on sign-in via ' +
      'window.__dismissWelcomeNudge. Otherwise the nudge stays visible ' +
      'after sign-up, which contradicts its whole purpose.'
  );
});

test('welcome nudge anchors under #add-band-btn on desktop, #mobile-menu-btn on mobile', () => {
  const fnMatch = INDEX_HTML.match(
    /\(function\s+initWelcomeNudge\(\)\s*\{([\s\S]*?)\n\s{8}\}\)\(\);/
  );
  assert.ok(fnMatch, 'Expected an initWelcomeNudge IIFE in index.html.');
  const body = fnMatch[1];

  assert.match(
    body,
    /getElementById\(['"]add-band-btn['"]\)/,
    'The nudge must read #add-band-btn as its desktop anchor. This is the ' +
      'primary CTA in the desktop toolbar and the button whose behavior ' +
      'the nudge is explaining.'
  );
  assert.match(
    body,
    /getElementById\(['"]mobile-menu-btn['"]\)/,
    'The nudge must read #mobile-menu-btn as its mobile anchor. This is ' +
      'the hamburger button, which owns the top-right on mobile.'
  );
  // Anchor selection must gate on MOBILE_QUERY so the right anchor is
  // picked when the two are both present in the DOM.
  assert.match(
    body,
    /MOBILE_QUERY\.matches/,
    'Anchor selection must consult MOBILE_QUERY. Otherwise the nudge points ' +
      'at the wrong button on mobile or desktop.'
  );
  // Reposition on resize and on MOBILE_QUERY change so the nudge stays
  // glued to the current anchor across viewport shifts.
  assert.match(
    body,
    /window\.addEventListener\(\s*['"]resize['"][\s\S]{0,200}positionNudge/,
    'Expected a resize listener that reruns positionNudge. Without it the ' +
      'nudge drifts off its anchor on window resize.'
  );
  assert.match(
    body,
    /MOBILE_QUERY\.addEventListener\(\s*['"]change['"][\s\S]{0,200}positionNudge/,
    'Expected a MOBILE_QUERY change listener that reruns positionNudge. ' +
      'Without it the nudge stays glued to the wrong anchor when the ' +
      'viewport crosses the 900px breakpoint.'
  );
});
