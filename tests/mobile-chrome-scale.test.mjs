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

test('the action pills are a real tap target inside the sheet', () => {
  // Superseded 22px pills (below the platform's 44px minimum) with rows in
  // the hamburger sheet -- see .sigma-actions.is-open in the mobile block.
  // min-height, not height: the label can wrap to two lines on a narrow
  // phone without shrinking the tap target below the floor.
  const mobileHeight = pxIn(mobileBlock(), '.sigma-actions .sigma-action{', 'min-height');
  assert.ok(mobileHeight >= 44, `Expected at least a 44px tap target, got ${mobileHeight}px.`);
  // The desktop pill is untouched by this redesign.
  const desktopRule = desktopCss();
  const idx = desktopRule.indexOf('.sigma-action{');
  const clamp = desktopRule.slice(idx, desktopRule.indexOf('}', idx)).match(/height:clamp\((\d+)px,[^,]+,(\d+)px\)/);
  assert.ok(clamp, 'Expected a clamped desktop pill height, unchanged by the mobile redesign.');
});

test('the search row is a real tap target again on a phone', () => {
  // The selector spans two lines (field and Explore share the rule), so the
  // height is read from the declaration block rather than by scanning forward
  // from the selector's first line.
  const block = mobileBlock();
  const rule = block.match(/\.sigma-prompt input,\s*#\$\{STAGE_ID\} \.sigma-prompt button\{([^}]*)\}/);
  assert.ok(rule, 'Expected one rule sizing both the field and the Explore button.');
  const height = Number((rule[1].match(/height:\s*(\d+)px/) || [])[1]);
  // 44px, not the 24px this row briefly held: with the six pills moved into
  // a sheet, the row no longer has to give up its own size for their sake.
  assert.equal(height, 44, 'Expected a 44px field and Explore button.');
  // The desktop row is clamp(48px,5.4vw,58px) and is untouched by this redesign.
  assert.match(EXPLORER, /height:clamp\(48px,5\.4vw,58px\)/, 'Expected the desktop row height to be unchanged.');
});

test('the field also carries its min-height, or the page overrides it', () => {
  // The page's global form styling sets input{...min-height:48px} for stacked
  // fields with a label above -- irrelevant now that the phone rule matches
  // it (44 < 48 would still be silently beaten by the floor), but pinned as
  // min-height alongside height for the same reason it was pinned before:
  // this rule has to be read as authoritative, not as a value the global
  // floor happens to agree with today.
  assert.match(INDEX_HTML, /input,select,textarea\{[^}]*min-height:48px/, 'Expected the global 48px floor to still exist.');
  assert.match(
    mobileBlock(),
    /\.sigma-prompt input,\s*#\$\{STAGE_ID\} \.sigma-prompt button\{height:44px;min-height:44px\}/,
    'Expected the phone rule to set both height and min-height explicitly.'
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

test('the sheet stacks its rows instead of fighting to fit them on one line', () => {
  // Superseded: the six pills used to fight a wrap to a second row via
  // nowrap + shrinking. They now stack vertically in the open sheet by
  // design, so wrapping is not a failure mode any more -- what matters is
  // that the sheet is a column, not a row.
  assert.match(
    mobileBlock(),
    /\.sigma-actions\{[^}]*flex-direction:column;max-height:70vh;overflow-y:auto/,
    'Expected the open sheet to stack its rows in a scrollable column.'
  );
});

// -------------------------------------------------------------------------
// 3. The auth corner is sized with the rest of the chrome.
//
// It was raised to 40px when it became the only way in on a phone, shrunk to
// 24px to match a search row that had itself been squeezed to fit six pills
// on one line, then back to 44px (redesign/mobile-hamburger-nav) once those
// pills moved into a hamburger sheet and the row got its size back.
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

test('the phone auth button matches the search row, not the old squeeze', () => {
  const block = phoneAuthBlock();
  const height = Number((block.match(/min-height:\s*(\d+)px !important/) || [])[1]);
  assert.equal(height, 44, 'Expected a 44px auth button, the same height as the search row.');
  assert.ok(
    !/min-height:\s*24px !important/.test(block),
    'The intermediate 24px phone size must not come back without an argument.'
  );
});

test('the auth button keeps its !important, or the density pass wins', () => {
  // .header-btn is pinned to min-height:26px !important elsewhere in the sheet.
  // An override without the same weight silently loses.
  const block = phoneAuthBlock();
  assert.match(block, /min-height:\s*44px !important/);
  assert.match(block, /font-size:\s*14px !important/);
  assert.match(block, /padding:\s*0 14px !important/);
});

test('the hero clears the header row exactly', () => {
  // padding + button height + 10px breathing room = the row's bottom edge.
  // Holding a larger top would bank the shrink as empty space instead of
  // stage; holding a smaller one risks the wordmark printing through the row.
  const block = phoneAuthBlock();
  const padding = block.match(/\.header-right \{ gap: 5px; padding: (\d+)px/);
  assert.ok(padding, 'Expected the header padding to be declared.');
  const top = Number((INDEX_HTML.match(/#sigma-stage \.sigma-hero \{ top: (\d+)px; \}/) || [])[1]);
  const height = Number((block.match(/min-height:\s*(\d+)px !important/) || [])[1]);
  const rowBottom = Number(padding[1]) + height;
  assert.ok(
    top >= rowBottom,
    `The hero must start at or below the header row's bottom (${rowBottom}px), found ${top}px.`
  );
  assert.ok(
    top - rowBottom <= 12,
    `The hero must not leave more than 12px of dead space; found ${top - rowBottom}px.`
  );
});

test('a desktop keeps the larger auth target', () => {
  const desktopRule = INDEX_HTML.match(
    /body\.rbft-sigma-boot \.header-right \.header-btn \{\s*\n\s*min-height: (\d+)px !important;/
  );
  assert.ok(desktopRule, 'Expected the base auth-button rule.');
  assert.equal(Number(desktopRule[1]), 36, 'The desktop size is unchanged by the phone density pass.');
});
