// Regression tests for the explicit Sign In affordance (backlog #25).
//
// Before this feature the only auth entry point was the Add-your-band
// combo button, which reads "Sign up" for anonymous visitors (PR #51).
// That stranded the returning-user case: someone who already had an
// account but cleared cookies or switched devices had no obvious way
// back in that wasn't labelled as contributing a band. The project
// owner's placement call was "in the hamburger sheet on mobile, header
// on desktop", which is what these tests pin.
//
// Two structural invariants matter most and are easy to break silently:
//
//   1. Visibility is signed-out-only, and setSignedInState() is the
//      single owner of it. The markup ships both affordances `hidden`
//      so a user with a valid token never sees a flash of "Sign in".
//      If a future PR removes the setSignedInState wiring, the buttons
//      become permanently invisible rather than throwing — hence the
//      explicit assertions below.
//
//   2. Sign In reuses #add-band-popover instead of introducing a second
//      modal. A separate popover would need its own
//      hookPopoverForMobile registration AND its own .is-open-mobile
//      bottom-sheet CSS rule; without both, mobile users tap Sign In
//      and see nothing (the exact failure class documented in PR #44
//      and re-hit in PR #47).
//
// Assertions are structural (index.html read as a string) to match the
// house style — the runner is `node --test` with no browser/DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function sliceBetween(source, startRegex, endMarker) {
  const startMatch = source.match(startRegex);
  assert.ok(startMatch, `Expected to find start marker ${startRegex} in index.html`);
  const startIdx = startMatch.index;
  const endIdx = source.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `Expected end marker "${endMarker}" after start marker`);
  return source.slice(startIdx, endIdx);
}

function extractSiteHeader() {
  return sliceBetween(INDEX_HTML, /<header class="site-header"/, '</header>');
}

function extractMobileSheet() {
  return sliceBetween(
    INDEX_HTML,
    /<aside class="mobile-sheet" id="mobile-menu-sheet"/,
    '</aside>'
  );
}

// -----------------------------------------------------------------------
// Desktop placement: the header, NOT the graph toolbar.
// -----------------------------------------------------------------------

test('desktop Sign In button lives inside the site header', () => {
  const header = extractSiteHeader();
  assert.match(
    header,
    /id="sign-in-btn"/,
    'Expected #sign-in-btn inside <header class="site-header">. The graph ' +
      'toolbar (.graph-overlay-top) is already crowded, and the project ' +
      'owner chose the header for desktop placement (backlog #25).'
  );
});

test('desktop Sign In button is NOT placed in the graph toolbar', () => {
  // Guards the placement decision itself: dropping Sign In into
  // .graph-overlay-top would both crowd the toolbar and make it
  // display:none on mobile, silently duplicating the hamburger row.
  const overlayMatch = INDEX_HTML.match(
    /<div class="graph-overlay graph-overlay-top">([\s\S]*?)<\/main>/
  );
  assert.ok(overlayMatch, 'Expected .graph-overlay-top block in index.html.');
  assert.ok(
    !overlayMatch[1].includes('id="sign-in-btn"'),
    '#sign-in-btn must not live inside .graph-overlay-top — that container ' +
      'is display:none on mobile and is reserved for graph controls.'
  );
});

test('site header is no longer aria-hidden now that it holds a control', () => {
  // The header was left empty + aria-hidden="true" by the unified-toolbar
  // refactor. Re-tenanting it with a real button means the aria-hidden
  // must go, or the Sign In button is invisible to assistive tech.
  const headerTag = INDEX_HTML.match(/<header class="site-header"[^>]*>/);
  assert.ok(headerTag, 'Expected a <header class="site-header"> tag.');
  assert.ok(
    !/aria-hidden/.test(headerTag[0]),
    'The site header must not be aria-hidden="true" now that it contains ' +
      'the interactive #sign-in-btn — screen readers would skip it entirely.'
  );
});

test('desktop Sign In button carries the header-btn styling class', () => {
  const header = extractSiteHeader();
  const btn = header.match(/<button[^>]*id="sign-in-btn"[^>]*>/);
  assert.ok(btn, 'Expected a <button id="sign-in-btn"> in the site header.');
  assert.match(
    btn[0],
    /class="[^"]*\bheader-btn\b/,
    'Expected #sign-in-btn to use the existing .header-btn class so it ' +
      'inherits the frosted pill styling and the pointer-events:auto rule ' +
      '(.site-header itself is pointer-events:none).'
  );
});

test('header auth strip sits inside .header-right so mobile CSS hides it', () => {
  // .header-right is display:none under max-width:900px. That single rule
  // is what keeps the desktop button from doubling up with the hamburger
  // sheet row on phones, so both affordances must be inside it.
  const header = extractSiteHeader();
  const rightIdx = header.indexOf('class="header-right"');
  assert.ok(rightIdx > 0, 'Expected a .header-right container in the site header.');
  const rightBlock = header.slice(rightIdx);
  assert.ok(
    rightBlock.includes('id="sign-in-btn"'),
    'Expected #sign-in-btn inside .header-right.'
  );
  assert.ok(
    rightBlock.includes('id="header-user"'),
    'Expected the signed-in #header-user strip inside .header-right too.'
  );
  assert.match(
    INDEX_HTML,
    /@media \(max-width: 900px\)[\s\S]*?\.header-right\s*{\s*display:\s*none/,
    'Expected .header-right to be display:none at <=900px. Without it the ' +
      'desktop Sign In button and the mobile sheet row both show on phones.'
  );
});

// -----------------------------------------------------------------------
// Mobile placement: hamburger sheet only.
// -----------------------------------------------------------------------

test('mobile Sign In row lives inside the hamburger sheet', () => {
  const sheet = extractMobileSheet();
  assert.ok(
    sheet.includes('id="mobile-sign-in-btn"'),
    'Expected #mobile-sign-in-btn inside #mobile-menu-sheet — mobile users ' +
      'never see .site-header .header-right (display:none at <=900px).'
  );
  assert.ok(
    sheet.includes('id="mobile-sign-in-row"'),
    'Expected the #mobile-sign-in-row wrapper inside #mobile-menu-sheet; ' +
      'setSignedInState toggles the row, not just the button, so the row ' +
      'border/spacing disappears with it.'
  );
});

test('mobile sheet row order places Sign In above Add-your-band', () => {
  // Ordering convention from PR #63: identity actions precede
  // contribution actions. Expected top-to-bottom order in the sheet is
  // Sign in -> Add your band -> Share this graph -> Send feedback.
  // (PRs B/C insert Recently-added and Reset-view between Add-your-band
  // and Share; Sign In stays first either way.)
  const sheet = extractMobileSheet();
  const order = [
    'id="mobile-sign-in-btn"',
    'id="mobile-add-band-btn"',
    'id="mobile-share-btn"',
    'id="mobile-send-feedback-btn"',
  ];
  const positions = order.map((needle) => {
    const idx = sheet.indexOf(needle);
    assert.ok(idx > 0, `Expected ${needle} inside #mobile-menu-sheet.`);
    return { needle, idx };
  });
  const sorted = [...positions].sort((a, b) => a.idx - b.idx);
  assert.deepEqual(
    sorted.map((p) => p.needle),
    order,
    'Mobile hamburger sheet rows are out of order. Expected top-to-bottom: ' +
      'Sign in, Add your band, Share this graph, Send feedback (PR #63 ' +
      'convention — identity before contribution).'
  );
});

test('mobile Sign In button is NOT styled as a competing primary CTA', () => {
  // Add-your-band keeps the cyan gradient as the single primary CTA in the
  // sheet. Sign In uses the neutral tool-chip glass fill; two gradients
  // stacked made neither read as primary.
  assert.match(
    INDEX_HTML,
    /\.mobile-sheet-add-band \.mobile-sign-in-btn\s*{/,
    'Expected a .mobile-sheet-add-band .mobile-sign-in-btn CSS rule.'
  );
  const rule = INDEX_HTML.match(
    /\.mobile-sheet-add-band \.mobile-sign-in-btn\s*{([^}]*)}/
  );
  assert.ok(rule, 'Expected the mobile Sign In button rule to be parseable.');
  assert.ok(
    !/linear-gradient/.test(rule[1]),
    'Sign In should not use the cyan CTA gradient — Add-your-band remains ' +
      'the primary contribution CTA in the sheet.'
  );
});

// -----------------------------------------------------------------------
// Visibility: signed-out only, owned by setSignedInState.
// -----------------------------------------------------------------------

test('both Sign In affordances ship hidden so no signed-out flash occurs', () => {
  const signInBtn = INDEX_HTML.match(/<button[^>]*id="sign-in-btn"[^>]*>/);
  assert.ok(signInBtn, 'Expected <button id="sign-in-btn">.');
  assert.match(
    signInBtn[0],
    /\shidden\b/,
    'Expected #sign-in-btn to ship with the `hidden` attribute. ' +
      'setSignedInState() unhides it on load once the session is known; ' +
      'without this a returning user sees "Sign in" flash before their ' +
      'stored token is restored.'
  );
  const row = INDEX_HTML.match(/<div[^>]*id="mobile-sign-in-row"[^>]*>/);
  assert.ok(row, 'Expected <div id="mobile-sign-in-row">.');
  assert.match(
    row[0],
    /\shidden\b/,
    'Expected #mobile-sign-in-row to ship with the `hidden` attribute.'
  );
});

test('setSignedInState hides both Sign In affordances when signed in', () => {
  // isSignedIn is the boolean derived at the top of setSignedInState, so
  // `hidden = isSignedIn` is the signed-out-only rule and
  // `hidden = !isSignedIn` is the signed-in-only rule.
  const fn = sliceBetween(
    INDEX_HTML,
    /function setSignedInState\(user\) \{/,
    'function deriveUserInitials'
  );
  assert.match(
    fn,
    /signInBtn\.hidden = isSignedIn/,
    'Expected setSignedInState to hide #sign-in-btn when signed in.'
  );
  assert.match(
    fn,
    /mobileSignInRow\.hidden = isSignedIn/,
    'Expected setSignedInState to hide #mobile-sign-in-row when signed in.'
  );
  assert.match(
    fn,
    /headerUser\.hidden = !isSignedIn/,
    'Expected setSignedInState to show the #header-user strip only when ' +
      'signed in (inverse of the Sign In button).'
  );
  for (const id of ['sign-in-btn', 'mobile-sign-in-row', 'header-user']) {
    assert.ok(
      fn.includes(`getElementById('${id}')`),
      `Expected setSignedInState to look up #${id}.`
    );
  }
});

test('setSignedInState is called with the stored user on page load', () => {
  // If this call goes away, both affordances stay `hidden` forever —
  // a silent failure with no console error.
  assert.match(
    INDEX_HTML,
    /function initSignup\(\)\s*{\s*setSignedInState\(loadCurrentUser\(\)\)/,
    'Expected initSignup() to call setSignedInState(loadCurrentUser()) so ' +
      'the Sign In affordances are unhidden for signed-out visitors.'
  );
});

test('signed-in header strip shows identity and a sign-out control', () => {
  const header = extractSiteHeader();
  assert.ok(
    header.includes('id="header-user-initials"'),
    'Expected an initials chip (#header-user-initials) in the header strip.'
  );
  assert.ok(
    header.includes('data-current-user-name'),
    'Expected [data-current-user-name] in the header strip so the signed-in ' +
      'user can see which account they are posting as.'
  );
  assert.ok(
    header.includes('id="header-sign-out-btn"'),
    'Expected #header-sign-out-btn in the header strip.'
  );
  // The popover strip also carries [data-current-user-name], so
  // setSignedInState must write to ALL of them, not just the popover's.
  assert.match(
    INDEX_HTML,
    /document\.querySelectorAll\('\[data-current-user-name\]'\)/,
    'setSignedInState must fill every [data-current-user-name] element ' +
      '(the popover strip AND the new header strip) — a popover-scoped ' +
      'query would leave the header showing an em-dash.'
  );
});

test('header sign-out clears the session and resets the panel framing', () => {
  const handler = INDEX_HTML.match(
    /getElementById\('header-sign-out-btn'\)\?\.addEventListener\('click', \(\) => \{([\s\S]*?)\}\);/
  );
  assert.ok(handler, 'Expected a click handler on #header-sign-out-btn.');
  assert.match(handler[1], /clearCurrentUser\(\)/, 'Expected clearCurrentUser().');
  assert.match(handler[1], /setSignedInState\(null\)/, 'Expected setSignedInState(null).');
});

// -----------------------------------------------------------------------
// Wiring: both triggers open the shared popover in returning-user mode.
// -----------------------------------------------------------------------

test('desktop Sign In button opens the sign-in flow', () => {
  assert.match(
    INDEX_HTML,
    /getElementById\('sign-in-btn'\)\?\.addEventListener\('click',[\s\S]{0,400}openSignInFlow\(\)/,
    'Expected #sign-in-btn to call openSignInFlow() on click.'
  );
});

test('desktop Sign In click stops propagation so the panel is not insta-closed', () => {
  // #sign-in-btn lives in .site-header, outside the popover subtree, so the
  // document-level "click outside -> close popovers" handler would dismiss
  // the panel in the same tick. Same guard the mobile rows use.
  const handler = INDEX_HTML.match(
    /getElementById\('sign-in-btn'\)\?\.addEventListener\('click', \(event\) => \{([\s\S]*?)\}\);/
  );
  assert.ok(handler, 'Expected a click handler on #sign-in-btn taking (event).');
  assert.match(
    handler[1],
    /event\.stopPropagation\(\)/,
    'Expected event.stopPropagation() in the #sign-in-btn handler.'
  );
});

test('mobile Sign In button closes the sheet then opens the sign-in flow', () => {
  assert.match(
    INDEX_HTML,
    /getElementById\('mobile-sign-in-btn'\)[\s\S]{0,600}addEventListener/,
    'Expected a click handler bound to #mobile-sign-in-btn. (The generic ' +
      'tool-chip test in mobile-toolbar-parity also requires this, since ' +
      'PR #44 stopped the global toolChips handler from picking it up.)'
  );
  const handler = sliceBetween(
    INDEX_HTML,
    /const mobileSignInBtn = document\.getElementById\('mobile-sign-in-btn'\);/,
    '// Mobile Send-feedback button'
  );
  assert.match(
    handler,
    /closeSheet\(\)/,
    'Expected the mobile Sign In handler to closeSheet() first so the ' +
      'add-band bottom sheet does not overlap the closing hamburger sheet.'
  );
  assert.match(
    handler,
    /openSignInFlow\(\)/,
    'Expected the mobile Sign In handler to call openSignInFlow().'
  );
  assert.match(
    handler,
    /event\.stopPropagation\(\)/,
    'Expected event.stopPropagation() so the document-level click-outside ' +
      'handler does not dismiss the popover we just opened.'
  );
});

test('openSignInFlow opens #add-band-popover in signin mode', () => {
  const fn = sliceBetween(
    INDEX_HTML,
    /function openSignInFlow\(\) \{/,
    "getElementById('sign-in-btn')"
  );
  assert.match(
    fn,
    /setAuthMode\('signin'\)/,
    'Expected openSignInFlow to switch the panel to returning-user framing.'
  );
  assert.match(
    fn,
    /getElementById\('add-band-popover'\)/,
    'Expected openSignInFlow to target the shared #add-band-popover.'
  );
  assert.match(
    fn,
    /popover\.hidden = false/,
    'Expected openSignInFlow to set popover.hidden = false directly. ' +
      'hookPopoverForMobile observes the `hidden` attribute via ' +
      'MutationObserver, so this is what triggers the mobile ' +
      'detach-to-body + .is-open-mobile bottom-sheet rescue.'
  );
  assert.match(
    fn,
    /closeBottomPopovers\(popover\)/,
    'Expected openSignInFlow to close sibling popovers so the toolbar ' +
      'keeps its one-popover-at-a-time invariant.'
  );
});

test('openSignInFlow does not proxy-click the Add-your-band toggle', () => {
  // #add-band-btn is a toggle: proxy-clicking it while the popover is
  // already open would CLOSE it. It also resets the panel to signup
  // framing, which would undo setAuthMode('signin') — and because the
  // mobile add-band trigger awaits a 300ms sheet-close animation before
  // forwarding, no call-ordering trick fixes that reliably.
  const fn = sliceBetween(
    INDEX_HTML,
    /function openSignInFlow\(\) \{/,
    "getElementById('sign-in-btn')"
  );
  assert.ok(
    !/trigger\.click\(\)/.test(fn) && !/addBandBtn\.click\(\)/.test(fn),
    'openSignInFlow must not proxy-click #add-band-btn — it is a toggle and ' +
      'it resets the panel to signup framing.'
  );
});

// -----------------------------------------------------------------------
// Sign-in vs sign-up disambiguation.
// -----------------------------------------------------------------------

test('setAuthMode rewrites title, copy and submit label for both modes', () => {
  assert.match(INDEX_HTML, /const AUTH_MODE_COPY = \{/, 'Expected an AUTH_MODE_COPY map.');
  const map = sliceBetween(INDEX_HTML, /const AUTH_MODE_COPY = \{/, 'let currentAuthMode');
  for (const mode of ['signup:', 'signin:']) {
    assert.ok(map.includes(mode), `Expected AUTH_MODE_COPY to define ${mode}`);
  }
  for (const key of ['title:', 'copy:', 'submit:', 'pending:']) {
    assert.ok(
      map.split(key).length - 1 >= 2,
      `Expected both AUTH_MODE_COPY modes to define ${key}`
    );
  }
  const fn = sliceBetween(INDEX_HTML, /function setAuthMode\(mode\) \{/, '\n    }');
  for (const id of ['signup-panel-title', 'signup-panel-copy', 'signup-submit-btn']) {
    assert.ok(
      fn.includes(`getElementById('${id}')`),
      `Expected setAuthMode to rewrite #${id}.`
    );
  }
});

test('signin mode reuses the existing signup form and endpoint', () => {
  // The whole disambiguation is copy-level. /api/signup already implements
  // insert-or-return keyed on email (see netlify/functions/signup.mjs), so
  // a returning user gets their existing token back. No second endpoint,
  // no change to the identity model or session storage.
  assert.ok(
    !INDEX_HTML.includes("'/api/signin'") && !INDEX_HTML.includes('"/api/signin"'),
    'Sign In must not introduce a /api/signin endpoint — /api/signup is ' +
      'already insert-or-return on email. Adding one is a server-side auth ' +
      'change and out of scope.'
  );
  assert.ok(
    !INDEX_HTML.includes('id="signin-form"'),
    'Sign In must reuse #signup-form rather than adding a second form, so ' +
      'the PR #66 placeholder styling and the existing validation stay shared.'
  );
});

test('Sign In does not introduce a second popover', () => {
  // A separate popover would need its own hookPopoverForMobile
  // registration AND its own .is-open-mobile bottom-sheet CSS rule.
  // Missing either one means mobile users tap Sign In and see nothing.
  for (const badId of ['id="sign-in-popover"', 'id="signin-popover"']) {
    assert.ok(
      !INDEX_HTML.includes(badId),
      `Sign In must live inside #add-band-popover, not a separate ${badId}. ` +
        'See the popover-hook guard tests in mobile-toolbar-parity.test.mjs.'
    );
  }
});

test('Add-your-band entry points restore signup framing', () => {
  // Without this, a user who opens Sign In, dismisses it, then taps
  // "Sign up" / "Add your band" still sees "Welcome back" copy. The mobile
  // row forwards to #add-band-btn, so one listener covers both platforms.
  assert.match(
    INDEX_HTML,
    /getElementById\('add-band-btn'\)\?\.addEventListener\('click', \(\) => \{\s*setAuthMode\('signup'\);/,
    "Expected a #add-band-btn click listener that calls setAuthMode('signup')."
  );
});

test('openSignupPopover resets to signup framing', () => {
  // Shared programmatic entry point (welcome nudge CTA, node-card
  // "Sign in to edit" hint). Signup framing is the safe default for both
  // audiences because /api/signup is insert-or-return.
  const fn = sliceBetween(
    INDEX_HTML,
    /function openSignupPopover\(\) \{/,
    'const isMobile'
  );
  assert.match(
    fn,
    /setAuthMode\('signup'\)/,
    'Expected openSignupPopover to reset the panel to signup framing so a ' +
      'stale "Welcome back" title cannot leak into the nudge / edit-hint flows.'
  );
});

test('successful auth and sign-out both reset the panel to signup framing', () => {
  const submitSuccess = sliceBetween(
    INDEX_HTML,
    /setSignedInState\(loadCurrentUser\(\)\);\s*\n\s*\/\/ The signup section is now hidden/,
    'catch (error)'
  );
  assert.match(
    submitSuccess,
    /setAuthMode\('signup'\)/,
    'Expected the successful-auth branch to reset the panel framing.'
  );
  const signOut = sliceBetween(
    INDEX_HTML,
    /signOutBtn\.addEventListener\('click', \(\) => \{/,
    '});'
  );
  assert.match(
    signOut,
    /setAuthMode\('signup'\)/,
    'Expected the popover sign-out handler to reset the panel framing, ' +
      'otherwise the next open still says "Welcome back".'
  );
});

test('submit handler pending + failure copy follow the active auth mode', () => {
  assert.match(
    INDEX_HTML,
    /const modeCopy = AUTH_MODE_COPY\[currentAuthMode\] \|\| AUTH_MODE_COPY\.signup;/,
    'Expected the submit handler to read the active mode copy.'
  );
  assert.match(
    INDEX_HTML,
    /submitBtn\.textContent = modeCopy\.pending/,
    'Expected the in-flight button label to follow the active mode ' +
      '("Signing in…" vs "Signing up…").'
  );
  assert.match(
    INDEX_HTML,
    /currentAuthMode === 'signin'\s*\n?\s*\? `Sign-in failed/,
    'Expected the fallback error message to follow the active mode.'
  );
});

// -----------------------------------------------------------------------
// Initials chip helper.
// -----------------------------------------------------------------------

test('deriveUserInitials is defined and falls back to the email', () => {
  const fn = sliceBetween(
    INDEX_HTML,
    /function deriveUserInitials\(user\) \{/,
    '\n    }'
  );
  assert.match(fn, /user\.name/, 'Expected deriveUserInitials to read user.name.');
  assert.match(
    fn,
    /user\.email/,
    'Expected deriveUserInitials to fall back to the email when no name is ' +
      'stored (pre-profile-fields rows can have a null name).'
  );
  assert.match(
    fn,
    /slice\(0, 2\)/,
    'Expected at most two initials so the 26px chip does not overflow.'
  );
});
