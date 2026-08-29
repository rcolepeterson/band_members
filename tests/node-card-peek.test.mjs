// Structural tests for the mobile Peek sheet on the selected band/musician card.
//
// Same approach as edit-ui.test.mjs and mobile-toolbar-parity.test.mjs: index.html
// is read as a string and asserted against with targeted regex/substring checks,
// because the project's runner (node --test) has no DOM. Live behaviour is
// verified against the deploy preview per project convention.
//
// What this locks in, and why each one is worth a test:
//
//   1. The Peek height cap is mobile-only. If it ever escapes the
//      @media (max-width: 700px) block it truncates every desktop card to a
//      strip, which is a full-site regression from a one-line CSS mistake.
//   2. There is a visible, labelled control to expand. A height cap with no
//      affordance hides most of the card with no way back — the exact failure
//      mode this feature was reviewed for before shipping.
//   3. Peek does not move the card. It keeps the existing bottom: 72px offset,
//      which is what holds the sheet clear of the stage footer and its
//      "Show next group" action.
//   4. Opening a card sets the state and closing one clears it, so a new
//      selection can never inherit the previous card's Expanded state.
//   5. Expanded content still scrolls internally rather than growing off-screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// The mobile block that owns the bottom sheet, extracted once. Located by the
// breakpoint comment plus the sheet's signature offset so a second, unrelated
// 700px media query cannot be picked up by mistake.
function mobileSheetBlock() {
  const start = INDEX_HTML.indexOf('@media (max-width: 700px) {\n  .node-card {');
  assert.ok(start > 0, 'Expected the @media (max-width: 700px) block that restyles .node-card.');
  const end = INDEX_HTML.indexOf('\n}', INDEX_HTML.indexOf('.node-card__tail { display: none; }', start));
  assert.ok(end > start, 'Expected the mobile .node-card block to close.');
  return INDEX_HTML.slice(start, end);
}

// -----------------------------------------------------------------------
// 1. Peek is mobile-only.
// -----------------------------------------------------------------------

test('the Peek height cap lives inside the mobile media query', () => {
  const block = mobileSheetBlock();
  assert.ok(
    block.includes('.node-card.is-open.node-card--peek'),
    'Expected the .node-card--peek rule inside the mobile bottom-sheet media query.'
  );
  assert.match(
    block,
    /\.node-card\.is-open\.node-card--peek\s*{[^}]*max-height:\s*var\(--peek-height/,
    'Expected Peek to cap the card height via --peek-height.'
  );
});

test('no Peek rule is declared outside the mobile media query', () => {
  const block = mobileSheetBlock();
  const outside = INDEX_HTML.replace(block, '');
  // The only permitted mention outside the media query is the base rule that
  // hides the handle on desktop.
  const peekRules = outside.match(/^\s*\.node-card[^\n{]*--peek[^\n{]*{/gm) || [];
  assert.deepEqual(
    peekRules,
    [],
    `Peek styling escaped the mobile media query: ${peekRules.join(' ')}`
  );
});

test('the Peek handle is hidden on desktop by the base stylesheet', () => {
  assert.match(
    INDEX_HTML,
    /\.node-card__peek-toggle\s*{\s*display:\s*none;\s*}/,
    'Expected .node-card__peek-toggle { display: none } as the desktop default.'
  );
});

// -----------------------------------------------------------------------
// 2. There is a real, labelled control.
// -----------------------------------------------------------------------

test('the card markup contains an accessible Peek toggle button', () => {
  const idx = INDEX_HTML.indexOf('id="node-card-peek-toggle"');
  assert.ok(idx > 0, 'Expected #node-card-peek-toggle in the node-card markup.');
  const tag = INDEX_HTML.slice(INDEX_HTML.lastIndexOf('<button', idx), INDEX_HTML.indexOf('>', idx) + 1);
  assert.ok(tag.includes('type="button"'), 'Expected the Peek toggle to be type="button".');
  assert.ok(tag.includes('node-card__peek-toggle'), 'Expected the node-card__peek-toggle class.');
  assert.ok(tag.includes('aria-expanded'), 'Expected aria-expanded on the Peek toggle.');
  assert.ok(tag.includes('aria-label'), 'Expected an aria-label: the handle is only a 4px bar.');
});

test('the Peek toggle is wired to a click handler', () => {
  assert.match(
    INDEX_HTML,
    /nodeCardPeekToggle\.addEventListener\('click',\s*toggleNodeCardSheet\)/,
    'Expected the Peek toggle to call toggleNodeCardSheet on click.'
  );
});

test('the existing close button survives as the dismissal control', () => {
  assert.ok(
    INDEX_HTML.includes('id="node-card-close"'),
    'Expected the node card close button to remain.'
  );
  assert.match(
    INDEX_HTML,
    /nodeCardCloseBtn\.addEventListener\('click',\s*closeNodeCard\)/,
    'Expected the close button to still call closeNodeCard.'
  );
});

// -----------------------------------------------------------------------
// 3. Peek shows the connections, and the footer steps aside.
// -----------------------------------------------------------------------

test('Peek keeps the connections list and hides only secondary blocks', () => {
  const block = mobileSheetBlock();
  const hidden = block.slice(block.indexOf('.node-card.is-open.node-card--peek .node-card__rows'));
  const hiddenRule = hidden.slice(0, hidden.indexOf('}'));
  for (const part of ['node-card__rows', 'node-card__verify-toggle', 'node-card__signin-hint']) {
    assert.ok(hiddenRule.includes(part), `Expected Peek to hide .${part}.`);
  }
  // The regression this guards: an earlier version capped the card's height and
  // nothing else, which hid the band/member chips — the most useful thing on
  // the card. Peek must never hide the connections block.
  assert.ok(
    !hiddenRule.includes('node-card__connections'),
    'Peek must keep the connections block: the bands are the point of the card.'
  );
  assert.match(
    block,
    /\.node-card\.is-open\.node-card--peek \.node-card__chips\s*{[^}]*max-height/,
    'Expected the chips to be clipped to a couple of rows in Peek, not hidden.'
  );
});

test('the sheet docks at the bottom edge rather than floating above the footer', () => {
  const block = mobileSheetBlock();
  const bottom = block.match(/\.node-card\s*{[\s\S]*?bottom:\s*(\d+)px\s*!important/);
  assert.ok(bottom, 'Expected an explicit bottom offset on the mobile sheet.');
  const px = Number(bottom[1]);
  assert.ok(px <= 24, `Expected the sheet docked near the bottom edge, found ${px}px.`);
  assert.ok(px > 0, 'Expected a small gap so the last chip row clears the gesture bar.');
});

test('the stage footer steps aside for an open sheet instead of being overlapped', () => {
  const block = mobileSheetBlock();
  assert.match(
    block,
    /body\.node-card-sheet-open \.sigma-footer\s*{[^}]*bottom:\s*calc\(var\(--sheet-height,\s*var\(--peek-height\)\)/,
    'Expected the footer lifted by the measured sheet height, falling back to --peek-height.'
  );
  // The group jump must survive an expanded card: it is read and used while a
  // card is open. Hiding it there was the first attempt and was wrong.
  assert.ok(
    !/node-card-sheet-expanded[^{]*\.sigma-footer\s*{[^}]*display:\s*none/.test(block),
    'The group control must stay visible above an Expanded sheet, not be hidden.'
  );
  assert.match(
    block,
    /max-height:\s*min\(62dvh/,
    'Expected the expanded sheet capped below the viewport so the lifted footer has room.'
  );
  assert.match(
    INDEX_HTML,
    /:root\s*{\s*--peek-height:\s*\d+px;\s*}/,
    'Expected --peek-height on :root so the footer can read the same number as the sheet.'
  );
});

test('the sheet publishes its measured height and clears it again', () => {
  // A wrapped two-line band name changes the sheet's real height, so the footer
  // offset is measured rather than assumed. If the property is never cleared,
  // a stale height follows the footer around after the card is dismissed.
  assert.match(
    INDEX_HTML,
    /setProperty\('--sheet-height',\s*nodeCardEl\.offsetHeight/,
    'Expected the live sheet height to be published for the footer, in both states.'
  );
  const idx = INDEX_HTML.indexOf('function closeNodeCard');
  assert.ok(
    INDEX_HTML.slice(idx, idx + 1500).includes("removeProperty('--sheet-height')"),
    'Expected --sheet-height cleared on close.'
  );
});

test('the sheet-open body class is set on open and cleared on close', () => {
  assert.match(
    INDEX_HTML,
    /classList\.toggle\('node-card-sheet-open',\s*sheet\)/,
    'Expected the sheet-open body class to track the mobile sheet.'
  );

  const idx = INDEX_HTML.indexOf('function closeNodeCard');
  const body = INDEX_HTML.slice(idx, idx + 1400);
  assert.ok(
    body.includes("classList.remove('node-card-sheet-open')"),
    'Expected the body class cleared on close, or the footer never comes back.'
  );
});

// -----------------------------------------------------------------------
// 4. Open sets the state, close clears it.
// -----------------------------------------------------------------------

test('opening a card derives its sheet state from the breakpoint', () => {
  assert.match(
    INDEX_HTML,
    /setNodeCardSheetState\(isMobileSheet\(\) \? 'peek' : 'expanded'\)/,
    'Expected openNodeCard to open compact on mobile and expanded on desktop.'
  );
});

test('setNodeCardSheetState keeps class, data attribute and aria in step', () => {
  const idx = INDEX_HTML.indexOf('function setNodeCardSheetState');
  assert.ok(idx > 0, 'Expected a setNodeCardSheetState function.');
  const body = INDEX_HTML.slice(idx, idx + 1200);
  assert.ok(body.includes("classList.toggle('node-card--peek'"), 'Expected the Peek class toggle.');
  assert.ok(body.includes("setAttribute('data-sheet-state'"), 'Expected data-sheet-state to be written.');
  assert.ok(body.includes("setAttribute('aria-expanded'"), 'Expected aria-expanded to follow the state.');
});

test('closing a card clears the Peek class, state attribute and aria-expanded', () => {
  const idx = INDEX_HTML.indexOf('function closeNodeCard');
  assert.ok(idx > 0, 'Expected closeNodeCard to exist.');
  const body = INDEX_HTML.slice(idx, idx + 1200);
  assert.ok(body.includes("classList.remove('node-card--peek')"), 'Expected the Peek class to be removed on close.');
  assert.ok(body.includes("removeAttribute('data-sheet-state')"), 'Expected data-sheet-state to be cleared on close.');
  assert.ok(body.includes("setAttribute('aria-expanded', 'false')"), 'Expected aria-expanded reset on close.');
});

test('crossing the breakpoint with a card open re-derives its state', () => {
  assert.match(
    INDEX_HTML,
    /matchMedia\('\(max-width: 700px\)'\)[\s\S]{0,400}addEventListener\('change'/,
    'Expected a breakpoint change listener so a resized/rotated card is not left in the wrong state.'
  );
});

// -----------------------------------------------------------------------
// 5. Expanded content scrolls internally.
// -----------------------------------------------------------------------

test('the expanded mobile sheet still scrolls inside itself', () => {
  const block = mobileSheetBlock();
  assert.ok(block.includes('overflow-y: auto;'), 'Expected the mobile sheet to scroll internally.');
  assert.ok(
    /max-height:\s*calc\(62vh\)/.test(block) && /max-height:\s*min\(62dvh/.test(block),
    'Expected the expanded sheet capped, with a vh fallback ahead of the dvh value.'
  );
  const peekRule = block.slice(block.indexOf('.node-card.is-open.node-card--peek'));
  assert.ok(
    /overflow:\s*hidden/.test(peekRule.slice(0, peekRule.indexOf('}'))),
    'Expected Peek itself to hide overflow so the strip cannot be scrolled while collapsed.'
  );
});
