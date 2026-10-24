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
const INDEX_HTML = readFileSync(join(__dirname, '..', 'graph', 'index.html'), 'utf8');

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

// Email carries `required` in the markup because it is step one and always on
// screen. Name moved into the profile step, which is hidden until the email comes
// back unknown -- and a hidden required input blocks submission with a browser
// message the visitor can neither see nor reach, so its required is set in JS
// alongside visibility instead. The tests below assert that guarantee where it now
// lives; presence in the markup is still asserted here.
test('signup form has name and email fields, with email required up front', () => {
  assert.match(INDEX_HTML, /id="signup-name"/);
  assert.match(INDEX_HTML, /id="signup-email"[^>]*required/);
  assert.match(INDEX_HTML, /id="signup-email"[^>]*type="email"/);
});

test('signup form has a submit button and a status region', () => {
  assert.match(INDEX_HTML, /id="signup-submit-btn"/);
  assert.match(INDEX_HTML, /id="signup-status"[^>]*aria-live="polite"/);
});

// Sign-up asks for the email only (2026-10-11). City, state, country and
// instrument were required here (PR signup-profile-fields); they moved to
// "Your card" in the account menu, filled in whenever someone wants.
test('sign-up no longer asks for city / state / country / instrument', () => {
  for (const id of ['signup-city', 'signup-state', 'signup-country', 'signup-instrument']) {
    assert.doesNotMatch(INDEX_HTML, new RegExp(`id="${id}"`), `#${id} left the sign-up form`);
  }
  // ...and the account menu is where they live now.
  for (const id of ['card-city', 'card-state', 'card-country', 'card-instrument']) {
    assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `#${id} is on Your card`);
  }
});

test('signup submit handler POSTs the email and optional name to /api/signup', () => {
  const anchorIdx = INDEX_HTML.indexOf('fetch(SIGNUP_ENDPOINT');
  assert.ok(anchorIdx > 0, 'Expected fetch(SIGNUP_ENDPOINT, ...) call inside submit handler.');
  const window = INDEX_HTML.slice(anchorIdx, anchorIdx + 900);
  assert.ok(window.includes('? { name, email }'), 'creation sends the email and the optional name');
  assert.ok(
    window.includes("{ intent: 'signin', email }"),
    'Expected an email-only sign-in body alongside the sign-up body.'
  );
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
