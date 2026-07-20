// Regression tests for the PR 2 signup + attribution wiring.
//
// This suite protects the visible plumbing of the signup flow: the
// popover HTML shape, the JS helpers that read/write the signed-in
// user, and the exact hook point where /api/contributions is fired
// after a successful band submission.
//
// These assertions are intentionally structural (they read index.html
// as a string) rather than DOM-runtime, because our test runner is
// node --test with no browser. Playwright checks live-DOM behavior
// separately during manual verification of the deploy preview.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// -----------------------------------------------------------------------
// HTML structure: signup popover lives inside the existing Add-your-band
// popover, with two toggle sections. This is the shape setSignedInState
// depends on, so if the markup drifts, the runtime toggle silently
// breaks.
// -----------------------------------------------------------------------

test('Add-your-band popover contains a [data-signup-only] section', () => {
  // Take the substring from the popover's id attribute to the sentinel
  // comment '/data-signed-in-only' we placed at the very end of it.
  const popStart = INDEX_HTML.indexOf('id="add-band-popover"');
  const popEnd = INDEX_HTML.indexOf('/data-signed-in-only', popStart);
  assert.ok(
    popStart > 0 && popEnd > popStart,
    'Expected #add-band-popover block bounded by /data-signed-in-only sentinel.'
  );
  const block = INDEX_HTML.slice(popStart, popEnd);
  assert.ok(
    block.includes('<div data-signup-only>'),
    'Expected <div data-signup-only> inside the #add-band-popover block.'
  );
});

test('Add-your-band popover contains a [data-signed-in-only] section', () => {
  assert.match(
    INDEX_HTML,
    /<div data-signed-in-only hidden>/,
    'Expected #add-band-popover to contain a <div data-signed-in-only hidden> child.'
  );
});

test('signup form has name and email fields with required attribute', () => {
  assert.match(INDEX_HTML, /id="signup-name"[^>]*required/);
  assert.match(INDEX_HTML, /id="signup-email"[^>]*required/);
  assert.match(INDEX_HTML, /id="signup-email"[^>]*type="email"/);
});

test('signup form has a submit button and a status region', () => {
  assert.match(INDEX_HTML, /id="signup-submit-btn"/);
  assert.match(INDEX_HTML, /id="signup-status"[^>]*aria-live="polite"/);
});

// Profile fields added in PR signup-profile-fields. All four required at
// signup so the field-presence assertion below also asserts the `required`
// HTML attribute. The instrument field's placeholder must hint at the
// "Music listener" alternative so people who don't play know what to type;
// the label copy is also asserted for the same reason.
test('signup form has required city / state / country / instrument fields', () => {
  for (const id of ['signup-city', 'signup-state', 'signup-country', 'signup-instrument']) {
    const re = new RegExp(`id="${id}"[^>]*required`);
    assert.match(INDEX_HTML, re, `Expected #${id} to be present and required.`);
  }
});

test('signup instrument field hints at "Music listener" for non-players', () => {
  // Grab the input tag itself so we don't accidentally match the surrounding
  // documentation or another element.
  const match = INDEX_HTML.match(/<input id="signup-instrument"[^>]*>/);
  assert.ok(match, 'Expected #signup-instrument input to be present.');
  assert.match(
    match[0],
    /Music listener/,
    'Expected #signup-instrument placeholder to hint at the "Music listener" option.'
  );
});

test('signup submit handler POSTs the profile fields to /api/signup', () => {
  // The submit handler builds a JSON body containing every profile field.
  // We assert on the object-literal shape rather than the exact whitespace
  // so the test survives minor reformatting. Anchor on SIGNUP_ENDPOINT so
  // we don't accidentally match one of the other fetch/JSON.stringify sites
  // in index.html (contributions, verify-band, etc.).
  const anchorIdx = INDEX_HTML.indexOf('fetch(SIGNUP_ENDPOINT');
  assert.ok(
    anchorIdx > 0,
    'Expected fetch(SIGNUP_ENDPOINT, ...) call inside submit handler.'
  );
  // Look at the next ~600 chars — enough to cover fetch options + body.
  const window = INDEX_HTML.slice(anchorIdx, anchorIdx + 600);
  for (const key of ['name:', 'email:', 'city:', 'state:', 'country:', 'instrument:']) {
    assert.ok(
      window.includes(key),
      `Expected signup submit body to include "${key}" property.`
    );
  }
});

test('signed-in strip has a sign-out button', () => {
  assert.match(INDEX_HTML, /id="sign-out-btn"/);
  assert.match(INDEX_HTML, /data-current-user-name/);
});

// -----------------------------------------------------------------------
// JS wiring: the constants + functions the runtime depends on all live
// in one section. If they're removed, the whole flow collapses silently
// (no runtime error — the page just stays in the anonymous state).
// -----------------------------------------------------------------------

test('session helpers are defined in the client', () => {
  for (const symbol of [
    'BMFT_USER_KEY',
    'SIGNUP_ENDPOINT',
    'ME_ENDPOINT',
    'CONTRIBUTIONS_ENDPOINT',
    'function loadCurrentUser',
    'function saveCurrentUser',
    'function clearCurrentUser',
    'function setSignedInState',
    'function verifyStoredUser',
    'async function logContribution'
  ]) {
    assert.ok(
      INDEX_HTML.includes(symbol),
      `Expected to find "${symbol}" in index.html`
    );
  }
});

test('signup endpoint constant points at /api/signup', () => {
  assert.match(INDEX_HTML, /const SIGNUP_ENDPOINT = '\/api\/signup'/);
});

test('me endpoint constant points at /api/me', () => {
  assert.match(INDEX_HTML, /const ME_ENDPOINT = '\/api\/me'/);
});

test('contributions endpoint constant points at /api/contributions', () => {
  assert.match(INDEX_HTML, /const CONTRIBUTIONS_ENDPOINT = '\/api\/contributions'/);
});

test('BMFT_USER_KEY constant matches the localStorage key used at runtime', () => {
  // Must match the key used by loadCurrentUser/saveCurrentUser/clearCurrentUser.
  // Playwright and other regressions expect exactly 'bmft-user'.
  assert.match(INDEX_HTML, /const BMFT_USER_KEY = 'bmft-user'/);
});

// -----------------------------------------------------------------------
// Contribution hook: the whole point of PR 2 is that a successful
// add-band call also logs a contribution. The hook must be BETWEEN
// the postSharedSubmission resolve and finishAndReport, so it only
// runs on real backend successes (not on offline fallbacks, which we
// treat as unattributed until the user re-submits online).
// -----------------------------------------------------------------------

test('logContribution is called after a successful backend add-band POST', () => {
  const successBlock = INDEX_HTML.slice(
    INDEX_HTML.indexOf('const storedRecord = await postSharedSubmission(draft)'),
    INDEX_HTML.indexOf('finishAndReport(result, true);')
  );
  assert.ok(
    successBlock.includes("logContribution('add_band'"),
    'Expected logContribution(\'add_band\', ...) between postSharedSubmission success and finishAndReport(result, true).'
  );
});

test('logContribution is NOT called from the offline fallback branch', () => {
  // The catch block is the offline safety net; contributions there
  // would incorrectly attribute drafts that never reached the shared
  // backend. We look at the substring from the catch to the next
  // finishAndReport(..., false).
  const catchStart = INDEX_HTML.indexOf('// Offline/error safety net');
  assert.ok(catchStart > 0, 'Expected the offline fallback comment to still exist.');
  const catchEnd = INDEX_HTML.indexOf('finishAndReport(result, false)', catchStart);
  assert.ok(catchEnd > catchStart, 'Expected finishAndReport(..., false) after the offline fallback comment.');
  const fallbackBlock = INDEX_HTML.slice(catchStart, catchEnd);
  assert.ok(
    !fallbackBlock.includes('logContribution('),
    'logContribution must not run in the offline fallback branch — attribution is only for confirmed backend writes.'
  );
});

// -----------------------------------------------------------------------
// Mobile: hookPopoverForMobile('add-band-popover') is registered exactly
// once, and the signup popover shares the same #add-band-popover host,
// so no additional registration is required. Guard against a future PR
// accidentally introducing a separate #signup-popover that lacks the
// mobile bottom-sheet CSS rule (the exact regression class documented
// in the popover-hook-guard comments).
// -----------------------------------------------------------------------

test('signup UI reuses #add-band-popover rather than adding a new popover', () => {
  assert.ok(
    !INDEX_HTML.includes('id="signup-popover"'),
    'The signup UI must live inside #add-band-popover, not a separate #signup-popover, ' +
    'so it inherits the mobile bottom-sheet CSS and the existing hookPopoverForMobile ' +
    'registration. If you split them, you must also register the new popover with ' +
    'hookPopoverForMobile AND add it to the .is-open-mobile selector list.'
  );
});

// -----------------------------------------------------------------------
// CSS: the signed-in strip + link-btn must be styled. If the rules go
// missing the sign-out link looks like naked black text on the dark
// popover background.
// -----------------------------------------------------------------------

test('signed-in-strip and link-btn have CSS rules', () => {
  assert.match(INDEX_HTML, /\.signed-in-strip\s*{/);
  assert.match(INDEX_HTML, /\.link-btn\s*{/);
});
