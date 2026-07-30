// Desktop header auth strip: mutual exclusivity, readability, and clearance
// from the stats HUD.
//
// Tester feedback after #68-#75 (project owner): the top-right of the header
// showed the signed-OUT "Sign in" button AND the signed-IN "Signed in as
// Aaron McRae / Sign out" strip at the same time, with the
// "NODES · LINKS · SCENES" stats badge crowding directly beneath them.
//
// Root cause of the double-render was NOT the JS. setSignedInState() (PR F /
// #73) sets `.hidden` on exactly one of the two affordances and is called on
// load from initSignup(). The problem is that `hidden` is only a
// UA-stylesheet `display: none`, so any author rule setting `display` on the
// same element silently defeats it -- and all three auth affordances have
// one (.header-btn and .header-user are inline-flex, .mobile-sheet-add-band
// is flex). The attribute had no rendering effect at all, so neither
// setSignedInState() nor the markup's initial `hidden` could hide anything.
//
// That makes this a two-part regression surface, and both parts are pinned
// below: the JS must keep setting `.hidden` exclusively, and the CSS must
// keep letting `hidden` actually hide.
//
// Assertions follow the house style: index.html read as a string, plus the
// REAL inline setSignedInState() extracted and run against a stub DOM. The
// runner is `node --test` with no browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  const start = INDEX_HTML.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found in index.html`);

  let parens = 0;
  let i = INDEX_HTML.indexOf('(', start);
  for (; i < INDEX_HTML.length; i++) {
    if (INDEX_HTML[i] === '(') parens++;
    else if (INDEX_HTML[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }

  let depth = 0;
  let j = INDEX_HTML.indexOf('{', i);
  for (; j < INDEX_HTML.length; j++) {
    if (INDEX_HTML[j] === '{') depth++;
    else if (INDEX_HTML[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return INDEX_HTML.slice(start, j);
}

function sliceBetween(source, startRegex, endMarker) {
  const startMatch = source.match(startRegex);
  assert.ok(startMatch, `Expected to find ${startRegex} in index.html`);
  const startIdx = startMatch.index;
  const endIdx = source.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `Expected "${endMarker}" after ${startRegex}`);
  return source.slice(startIdx, endIdx);
}

const siteHeader = () => sliceBetween(INDEX_HTML, /<header class="site-header"/, '</header>');
const headerUserStrip = () => sliceBetween(INDEX_HTML, /<div class="header-user" id="header-user"/, '</div>');

// ---------------------------------------------------------------------
// Stub DOM for the real setSignedInState().
// ---------------------------------------------------------------------

function el(extra = {}) {
  return {
    hidden: false,
    textContent: '',
    childNodes: [],
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.childNodes.push(child); },
    ...extra,
  };
}

function loadAuthState() {
  const elements = {
    'add-band-btn': el(),
    'mobile-add-band-btn': el({ childNodes: [{ nodeType: 3, textContent: ' Sign up' }] }),
    'sign-in-btn': el(),
    'mobile-sign-in-row': el(),
    'header-user': el(),
    'header-user-initials': el(),
  };
  const popoverSections = {
    '[data-signup-only]': el(),
    '[data-signed-in-only]': el(),
  };
  elements['add-band-popover'] = el({
    querySelector: selector => popoverSections[selector] || null,
  });
  const userNameEls = [el(), el()];

  const sandbox = {
    window: {},
    document: {
      getElementById: id => elements[id] || null,
      querySelectorAll: selector => (
        selector === '[data-current-user-name]' ? userNameEls : []
      ),
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(`${extract('deriveUserInitials')}\n${extract('setSignedInState')}\nthis.setSignedInState = setSignedInState;`, sandbox);

  return { setSignedInState: sandbox.setSignedInState, elements, popoverSections, userNameEls };
}

const AARON = { id: 'u1', name: 'Aaron McRae', email: 'aaron@example.com', token: 't' };

// ---------------------------------------------------------------------
// 1. Mutual exclusivity — the reported bug.
// ---------------------------------------------------------------------

test('setSignedInState(true) hides #sign-in-btn and shows #header-user', () => {
  const env = loadAuthState();
  env.setSignedInState(AARON);

  assert.equal(env.elements['sign-in-btn'].hidden, true, 'Signed in: the Sign In button must be hidden.');
  assert.equal(env.elements['header-user'].hidden, false, 'Signed in: the identity strip must be visible.');
});

test('setSignedInState(false) hides #header-user and shows #sign-in-btn', () => {
  const env = loadAuthState();
  env.setSignedInState(null);

  assert.equal(env.elements['header-user'].hidden, true, 'Signed out: the identity strip must be hidden.');
  assert.equal(env.elements['sign-in-btn'].hidden, false, 'Signed out: the Sign In button must be visible.');
});

test('#sign-in-btn and #header-user are never both visible, in either state', () => {
  [AARON, null].forEach(user => {
    const env = loadAuthState();
    env.setSignedInState(user);

    const signInVisible = env.elements['sign-in-btn'].hidden === false;
    const headerUserVisible = env.elements['header-user'].hidden === false;

    assert.ok(
      signInVisible !== headerUserVisible,
      `Exactly one auth affordance must be visible (user=${user ? user.name : 'none'}), `
      + `got signIn=${signInVisible} headerUser=${headerUserVisible}.`
    );
  });
});

test('re-running setSignedInState never leaves both visible', () => {
  // It is called on load, after signup, after sign-in and after sign-out, so
  // it has to be idempotent and order-independent.
  const env = loadAuthState();
  [AARON, null, AARON, AARON, null].forEach(user => {
    env.setSignedInState(user);
    assert.ok(
      (env.elements['sign-in-btn'].hidden === false) !== (env.elements['header-user'].hidden === false),
      'A repeated state flip must still leave exactly one affordance visible.'
    );
  });
});

test('the mobile Sign In row follows the same signed-out-only rule', () => {
  const signedIn = loadAuthState();
  signedIn.setSignedInState(AARON);
  assert.equal(signedIn.elements['mobile-sign-in-row'].hidden, true);

  const signedOut = loadAuthState();
  signedOut.setSignedInState(null);
  assert.equal(signedOut.elements['mobile-sign-in-row'].hidden, false);
});

test('setSignedInState is still called on load', () => {
  // If this wiring is dropped, both affordances keep their markup `hidden`
  // and the header silently loses its auth entry point instead of throwing.
  assert.match(
    INDEX_HTML,
    /\(function initSignup\(\) \{\s*setSignedInState\(loadCurrentUser\(\)\);/,
    'Expected initSignup() to seed the auth state from localStorage on load.'
  );
});

test('both affordances still ship hidden so the signed-out state is never flashed', () => {
  assert.match(siteHeader(), /id="sign-in-btn"[^>]*\shidden/, '#sign-in-btn must ship hidden.');
  assert.match(siteHeader(), /id="header-user"[^>]*\shidden/, '#header-user must ship hidden.');
});

// ---------------------------------------------------------------------
// 2. The CSS half of the bug: `hidden` must actually hide.
// ---------------------------------------------------------------------

// Every auth affordance that ships the `hidden` attribute, paired with the
// class carrying the `display` declaration that used to defeat it.
const HIDDEN_AFFORDANCES = [
  { id: 'sign-in-btn', cls: 'header-btn' },
  { id: 'header-user', cls: 'header-user' },
  { id: 'mobile-sign-in-row', cls: 'mobile-sheet-add-band' },
];

function guardRule() {
  return sliceBetween(INDEX_HTML, /\.header-btn\[hidden\]/, '}');
}

test('each hidden-toggled affordance has a class that sets display', () => {
  // This is the precondition that makes the guard below necessary. If a
  // future refactor drops the `display` declaration the guard is harmless,
  // but this test documents why it exists.
  HIDDEN_AFFORDANCES.forEach(({ cls }) => {
    assert.match(
      INDEX_HTML,
      new RegExp(`\\.${cls}\\s*\\{[^}]*display\\s*:`),
      `.${cls} sets display, which is what silently defeated the hidden attribute.`
    );
  });
});

test('a [hidden] guard restores display:none for every one of them', () => {
  const rule = guardRule();
  HIDDEN_AFFORDANCES.forEach(({ cls }) => {
    assert.ok(
      rule.includes(`.${cls}[hidden]`),
      `.${cls}[hidden] must be covered by the guard rule, or hidden has no effect on it.`
    );
  });
  assert.match(rule, /display:\s*none/, 'The guard rule must set display: none.');
});

test('the guard is scoped rather than a blanket [hidden] override', () => {
  // A global `[hidden] { display: none !important }` would retroactively
  // hide anything else on the page relying on the same pattern.
  assert.ok(
    !/^\s*\[hidden\]\s*\{/m.test(INDEX_HTML),
    'Expected the fix to be scoped to the auth affordances, not a blanket [hidden] rule.'
  );
});

// ---------------------------------------------------------------------
// 3. Readability of the signed-in strip.
// ---------------------------------------------------------------------

test('the signed-in strip no longer says "Signed in as"', () => {
  assert.ok(
    !headerUserStrip().includes('Signed in as'),
    'The run-on "Signed in as {name}" prefix should be gone — the chip plus the name already says it.'
  );
});

test('the strip still identifies the account and offers Sign out', () => {
  const strip = headerUserStrip();
  assert.match(strip, /id="header-user-initials"/, 'Expected the initials chip to remain.');
  assert.match(strip, /<strong data-current-user-name>/, 'Expected the user name to remain.');
  assert.match(strip, /id="header-sign-out-btn"/, 'Expected the Sign out control to remain.');
});

test('dropping the prefix does not cost the strip its accessible name', () => {
  // "Signed in as" was the only thing conveying what the chip + name meant.
  const strip = headerUserStrip();
  assert.match(strip, /aria-label="Signed-in account"/, 'Expected an accessible name on the strip.');
});

test('name and Sign out are visually separated', () => {
  assert.match(headerUserStrip(), /class="header-user-sep"/, 'Expected a separator between the name and Sign out.');
  assert.match(INDEX_HTML, /\.header-user-sep\s*\{/, 'Expected the separator to be styled.');
});

test('the separator collapses with the name below 1100px', () => {
  // PR F hides the name text under ~1100px so it stops crowding the graph
  // toolbar. A middot left floating beside the chip would just be noise.
  const narrow = sliceBetween(INDEX_HTML, /@media \(max-width: 1100px\) \{/, '}');
  assert.ok(narrow.includes('.header-user-name'), 'Expected the name to still collapse at 1100px.');
  assert.ok(narrow.includes('.header-user-sep'), 'Expected the separator to collapse with it.');
});

test('the add-band popover keeps its own "Signed in as" copy', () => {
  // Only the cramped header strip was in the tester screenshot; the popover
  // strip has room for the full phrase and is out of scope here.
  assert.ok(
    INDEX_HTML.includes('<span>Signed in as <strong data-current-user-name>'),
    'The popover identity copy should be left alone.'
  );
});

test("PR F's setAuthMode copy-swap flow is untouched", () => {
  assert.ok(INDEX_HTML.includes('function setAuthMode(mode)'), 'setAuthMode must survive.');
  assert.match(siteHeader(), /id="sign-in-btn"/, 'The desktop Sign In trigger must stay in the header.');
});

// ---------------------------------------------------------------------
// 4. Stats badge clearance.
// ---------------------------------------------------------------------

test('the stats badge clears the auth strip on desktop', () => {
  // .graph-stage is position:fixed/inset:0, so the badge and the fixed header
  // share the same physical corners. The auth strip occupies roughly 0-50px
  // (var(--space-3) padding + a 26px control + padding), so var(--space-5)
  // alone (20px) ran straight into it.
  //
  // The badge has since moved to the top-LEFT, out of the auth strip's column
  // entirely (see tests/stats-badge-placement.test.mjs), but the vertical
  // clearance is still asserted here: it is the floor this rule exists to
  // guarantee, and a future move back to the right must not silently lose it.
  const rule = sliceBetween(INDEX_HTML, /@media \(min-width: 721px\) \{/, '}');
  assert.ok(rule.includes('.graph-stats-badge'), 'Expected a desktop-only stats-badge offset.');

  const offset = rule.match(/top:\s*calc\(var\(--space-5\)\s*\+\s*(\d+)px\)/);
  assert.ok(offset, 'Expected the badge top to be var(--space-5) plus a clearance.');
  assert.ok(
    Number(offset[1]) >= 40,
    `Expected at least 40px of extra clearance below the auth strip, got ${offset[1]}px.`
  );
});

test('the desktop offset is scoped so it cannot undo the mobile placement', () => {
  // The 720px breakpoint re-homes the badge to the top-LEFT, where nothing
  // overlaps it (.header-right is display:none on mobile). That rule is
  // earlier in source order, so an unscoped override would defeat it.
  assert.ok(
    INDEX_HTML.includes('@media (max-width:720px){.graph-stats-badge{right:auto;top:var(--space-3);left:var(--space-3)'),
    'The mobile top-left placement must stay intact.'
  );
  const desktopIdx = INDEX_HTML.indexOf('@media (min-width: 721px) {');
  const mobileIdx = INDEX_HTML.indexOf('@media (max-width:720px){.graph-stats-badge');
  assert.ok(desktopIdx > mobileIdx, 'Sanity: the desktop override is the later rule.');
});

test('the desktop media block stays a vertical-only adjustment', () => {
  // Horizontal placement is owned by the base .graph-stats-badge rule in the
  // critical CSS (now top-left) and by the <=720px rule on mobile. This block
  // must not re-introduce a `right:` — that would drag the badge back under
  // the toolbar's right cluster, which is exactly the overlap the badge was
  // moved to escape.
  const rule = sliceBetween(INDEX_HTML, /@media \(min-width: 721px\) \{/, '}');
  assert.ok(!/\b(right|left)\s*:/.test(rule), 'Expected a vertical-only adjustment.');
});
