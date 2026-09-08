// Phone chrome: one sentence of narration, and (as of redesign/
// mobile-hamburger-nav) a hamburger sheet instead of a squeezed control row.
//
// The stage IS the content. On a 390x664 viewport the hero and the footer were
// between them eating a third of it, and most of what they spent that space on
// was commentary describing a view the visitor could already see.
//
// What stays on a phone:
//   - the introduction ("Hey, I'm Aaron. I built this site...") — a stranger
//     landing on one specific musician's node has to be told why
//   - "Show next group" — an action, not a description
//
// What goes: the centred-on readout, the frontier count, and the sentence in
// front of the group jump.
//
// A separate pass first shrank the six action pills to 22px and the search
// row to 24px so both fit on screen without giving up any content. That made
// them smaller than the platform's 44px tap-target minimum, which a header
// redesign (mockup-driven, see the redesign/mobile-hamburger-nav branch)
// flagged as the thing keeping the phone layout from reading as finished. The
// pills now live behind a hamburger in a bottom sheet, which let the search
// row and the auth corner go back to a real 44px -- the tests below in
// section 2 and 3 assert the CURRENT (post-redesign) numbers; only the
// footer-narration behaviour in section 1 is unchanged by that redesign.
//
// Both the introduction and the generic "You are viewing one region..." copy
// live in the SAME element (.sigma-hint), so the element cannot simply be
// hidden — a class marks which of the two is currently in it.
//
// Structural assertions against the explorer's stage CSS, in the style of
// sigma-explorer-wiring.test.mjs: the module imports sigma/graphology and
// cannot be executed under node --test. Live behaviour is verified against the
// deploy preview per project convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPLORER = readFileSync(join(__dirname, '..', 'scripts', 'sigma-explorer.mjs'), 'utf8');
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// The phone block that owns the stage chrome.
//
// There is more than one `@media (max-width:720px)` in this stylesheet — an
// earlier one sizes the share popover — so the block is identified by what it
// contains rather than by being the first match. Closed at the first lone `}`
// at column 0, which is how every rule here is formatted.
function mobileBlock() {
  const marker = '@media (max-width:720px){';
  for (let from = 0; ; ) {
    const start = EXPLORER.indexOf(marker, from);
    assert.ok(start > 0, 'Expected a 720px media query containing the stage chrome.');
    const end = EXPLORER.indexOf('\n}', start);
    assert.ok(end > start, 'Expected the media query to close.');
    const block = EXPLORER.slice(start, end);
    if (block.includes('.sigma-actions{')) return block;
    from = end + 1;
  }
}

// Everything outside that block — i.e. what a desktop gets.
function desktopCss() {
  return EXPLORER.replace(mobileBlock(), '');
}

// `prop:value` for the first rule whose selector contains `selector` inside the
// given CSS text. Values are read as numbers so a unit switch is still checked.
function pxIn(css, selector, prop) {
  const idx = css.indexOf(selector);
  assert.ok(idx > 0, `Expected a rule for ${selector}`);
  const rule = css.slice(idx, css.indexOf('}', idx));
  const match = rule.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  assert.ok(match, `Expected a px ${prop} on ${selector}, got: ${rule.trim()}`);
  return Number(match[1]);
}

// -------------------------------------------------------------------------
// 1. The footer keeps the introduction and the group jump. Nothing else.
// -------------------------------------------------------------------------

test('the phone footer hides the commentary', () => {
  const block = mobileBlock();
  ['.sigma-context', '.sigma-frontier', '.sigma-other-groups__text'].forEach(sel => {
    const idx = block.indexOf(sel);
    assert.ok(idx > 0, `Expected ${sel} to be addressed in the phone block.`);
  });
  assert.match(
    block,
    /\.sigma-footer \.sigma-context,\s*#\$\{STAGE_ID\} \.sigma-footer \.sigma-frontier,\s*#\$\{STAGE_ID\} \.sigma-other-groups__text\{display:none\}/,
    'Expected the three commentary lines hidden together on a phone.'
  );
});

test('"Show next group" survives without its sentence', () => {
  const block = mobileBlock();
  // The button is the one thing in that paragraph a phone can act on. Hiding
  // the paragraph instead of the text span would take it with it.
  assert.ok(
    !/\.sigma-other-groups__btn[^{]*\{[^}]*display:\s*none/.test(block),
    'The group-jump button must not be hidden on a phone.'
  );
  assert.ok(
    !/\.sigma-other-groups\{[^}]*display:\s*none/.test(block),
    'Hiding the whole paragraph would take the button with the text.'
  );
});

test('the introduction survives and the generic commentary does not', () => {
  const block = mobileBlock();
  assert.match(
    block,
    /\.sigma-hint:not\(\.sigma-hint--intro\)\{display:none\}/,
    'Expected only a NON-intro hint to be hidden: both strings share one element.'
  );
});

test('the intro marker is actually applied when the view is on the home star', () => {
  // A CSS hook nothing sets would hide the introduction too — the exact
  // opposite of the request.
  assert.match(
    EXPLORER,
    /hintEl\.classList\.toggle\('sigma-hint--intro', onHomeStar\)/,
    'Expected the intro class to track whether the introduction is what is in the element.'
  );
  const idx = EXPLORER.indexOf("hintEl.innerHTML = onHomeStar");
  assert.ok(idx > 0, 'Expected the hint to still choose between intro and explore copy.');
  assert.ok(
    EXPLORER.slice(idx, idx + 600).includes("classList.toggle('sigma-hint--intro'"),
    'The marker must be set where the copy is chosen, so the two cannot disagree.'
  );
});

test('a desktop keeps every line of narration', () => {
  const desktop = desktopCss();
  ['.sigma-context', '.sigma-frontier', '.sigma-other-groups__text'].forEach(sel => {
    const idx = desktop.indexOf(sel);
    const rule = desktop.slice(idx, desktop.indexOf('}', idx));
    assert.ok(
      !/display:\s*none/.test(rule),
      `${sel} must stay visible on a desktop; only the phone strips it.`
    );
  });
  assert.ok(
    !/\.sigma-hint:not\(\.sigma-hint--intro\)/.test(desktop),
    'The intro-only rule must not escape the phone block.'
  );
});

// -------------------------------------------------------------------------
// 2. The search row is full-size again, and the pills moved into a sheet.
// -------------------------------------------------------------------------

test('the action circles are a real tap target in the open menu', () => {
  // Superseded 22px pills (below the platform's 44px minimum) -- first with
  // full-width sheet rows, then (redesign/mobile-hamburger-nav, after a
  // mockup comparison found the sheet read as big boxy bars) with small
  // 44px circles anchored near the hamburger. Fixed height, not min-height:
  // there is no label inside to wrap any more (icon only -- see
  // .sigma-actions .sigma-action-label / -icon below), so the box has a
  // definite size instead of a floor.
  const mobileHeight = pxIn(mobileBlock(), '.sigma-actions .sigma-action{', 'height');
  assert.ok(mobileHeight >= 44, `Expected at least a 44px tap target, got ${mobileHeight}px.`);
  // The desktop pill is untouched by this redesign.
  const desktopRule = desktopCss();
  const idx = desktopRule.indexOf('.sigma-action{');
  const clamp = desktopRule.slice(idx, desktopRule.indexOf('}', idx)).match(/height:clamp\((\d+)px,[^,]+,(\d+)px\)/);
  assert.ok(clamp, 'Expected a clamped desktop pill height, unchanged by the mobile redesign.');
});

test('the search row is a real tap target again on a phone', () => {
  // Second pass (redesign/mobile-hamburger-nav): the field, the search icon
  // and the hamburger now share one bordered pill -- the FORM itself, not
  // the input -- so the row's height is set there and the field/buttons
  // fill it, rather than each control declaring its own 44px.
  const height = pxIn(mobileBlock(), '.sigma-prompt form{', 'height');
  // 44px, not the 24px this row briefly held: with the six pills moved out
  // of this row entirely, it no longer has to give up its own size for
  // their sake.
  assert.equal(height, 44, 'Expected a 44px pill.');
  // The desktop row is clamp(48px,5.4vw,58px) and is untouched by this redesign.
  assert.match(EXPLORER, /height:clamp\(48px,5\.4vw,58px\)/, 'Expected the desktop row height to be unchanged.');
});

test('the field fills the pill without the global min-height fighting it', () => {
  // The page's global form styling sets input{...min-height:48px} for
  // stacked fields with a label above. Nothing else in the phone rule
  // overrides it, so without an explicit min-height:0 the field renders at
  // 48px height:100% or not -- the floor wins regardless -- one px taller
  // than the 44px pill it lives inside.
  assert.match(INDEX_HTML, /input,select,textarea\{[^}]*min-height:48px/, 'Expected the global 48px floor to still exist.');
  assert.match(
    mobileBlock(),
    /\.sigma-prompt input\{\s*height:100%;min-height:0;/,
    'Expected the phone field rule to fill the pill and zero out the global min-height floor.'
  );
});

test('the field font stays at 16px so iOS does not zoom', () => {
  // The one measurement on this row that cannot be halved: iOS Safari zooms the
  // whole page when a focused input's text is under 16px, which yanks the
  // constellation off screen.
  const block = mobileBlock();
  const inputRules = block.match(/\.sigma-prompt input\{[^}]*\}/g) || [];
  inputRules.forEach(rule => {
    const font = rule.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    if (font) {
      assert.ok(Number(font[1]) >= 16, `The search field font must stay >= 16px, found ${font[1]}px.`);
    }
  });
  assert.match(EXPLORER, /font-size:clamp\(16px,1\.7vw,18px\)/, 'Expected the 16px floor on the field to survive.');
});

test('the open menu stacks its circles in a column, not a row', () => {
  // Superseded: the six pills used to fight a wrap to a second row via
  // nowrap + shrinking. They now stack vertically -- first as sheet rows,
  // now (redesign/mobile-hamburger-nav) as small circles -- by design, so
  // wrapping is not a failure mode any more.
  assert.match(
    mobileBlock(),
    /\.sigma-actions\{[^}]*flex-direction:column;gap:10px;\s*max-height:70vh;overflow-y:auto/,
    'Expected the open menu to stack its circles in a scrollable column.'
  );
});

// -------------------------------------------------------------------------
// 3. The auth corner matches its own signed-in state instead of being sized
//    against the rest of the chrome.
//
// It was raised to 40px when it became the only way in on a phone, shrunk to
// 24px to match a search row that had itself been squeezed to fit six pills
// on one line, then back to 44px once those pills moved into a hamburger
// sheet and the row got its size back. All of that was resizing a BUTTON.
// A later pass noticed the signed-IN state had never been a button at all --
// just plain text ("Sign out") -- and switched the signed-OUT state to
// match it, rather than keep tuning a button shape that only existed on one
// side of the same corner.
// -------------------------------------------------------------------------

// The phone block in index.html that restyles the constellation's header.
function phoneAuthBlock() {
  const anchor = 'body.rbft-sigma-boot .header-right { gap: 5px;';
  const start = INDEX_HTML.indexOf(anchor);
  assert.ok(start > 0, 'Expected the phone rule for the constellation header.');
  const end = INDEX_HTML.indexOf('\n}', INDEX_HTML.indexOf('.sigma-hero { top:', start));
  assert.ok(end > start, 'Expected the phone header block to close.');
  return INDEX_HTML.slice(start, end);
}

test('the phone auth control is text, matching the OTHER auth state', () => {
  // Signed in, this corner has always been plain text: an initials chip, a
  // name, and "Sign out" styled as .link-btn -- no border, no fill. Signed
  // out, it used to be a bordered/filled button instead, which meant the
  // one corner had two different visual languages depending on whether you
  // were logged in (and was consistently the boxiest thing in the phone
  // header). This matches "Sign out"'s own treatment instead of continuing
  // to resize a button shape.
  const block = phoneAuthBlock();
  assert.match(block, /min-height: auto !important;/);
  assert.doesNotMatch(
    block,
    /min-height:\s*\d+px !important/,
    'Expected no fixed pixel button height left over from the button era.'
  );
});

test('the phone auth control keeps its !important, or the density pass wins', () => {
  // .header-btn is pinned to min-height:26px !important and other sizing
  // elsewhere in the sheet. An override without the same weight silently loses.
  const block = phoneAuthBlock();
  assert.match(block, /min-height: auto !important;/);
  assert.match(block, /padding: 0 !important;/);
  assert.match(block, /border: 0 !important;/);
  assert.match(block, /background: none !important;/);
});

test('the hero clears the header row', () => {
  // There is no button height left to compute this from the way earlier
  // passes could -- a text link's line box isn't a number anywhere in this
  // stylesheet. The row's real bottom edge (~40px: 6px padding + the link's
  // own line height) was measured directly in the browser instead. 50px
  // leaves it the same ~10px breathing room the row has held at every size
  // it's been; the range below is deliberately a little generous around
  // that measurement rather than pinned to a single px, since it came from
  // the browser and not from arithmetic on other rules in this file.
  const top = Number((INDEX_HTML.match(/#sigma-stage \.sigma-hero \{ top: (\d+)px; \}/) || [])[1]);
  assert.ok(
    top >= 46 && top <= 56,
    `Expected the hero to clear the measured ~40px row with a reasonable margin, found top:${top}px.`
  );
});

test('a desktop keeps the larger auth target', () => {
  const desktopRule = INDEX_HTML.match(
    /body\.rbft-sigma-boot \.header-right \.header-btn \{\s*\n\s*min-height: (\d+)px !important;/
  );
  assert.ok(desktopRule, 'Expected the base auth-button rule.');
  assert.equal(Number(desktopRule[1]), 36, 'The desktop size is unchanged by the phone density pass.');
});
