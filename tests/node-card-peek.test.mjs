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

// -----------------------------------------------------------------------
// 6. The expanded sheet is the ONLY scroll container on a phone.
//
// The bug this section locks out: .node-card__chips carries a 130px cap with
// its own overflow, which is right for the desktop card (a wheel over the strip
// scrolls the strip) and wrong for the sheet. On a phone a 121-member roster is
// ~1750px of chips inside a 130px window in the middle of the card, while the
// card itself never overflowed — so a drag anywhere but those 130px scrolled
// nothing at all and the roster read as truncated with no way to see the rest.
// -----------------------------------------------------------------------

test('the expanded mobile sheet un-caps the member chips so the card owns the scroll', () => {
  const block = mobileSheetBlock();
  const match = block.match(
    /\.node-card\.is-open:not\(\.node-card--peek\) \.node-card__chips\s*{([^}]*)}/
  );
  assert.ok(
    match,
    'Expected an expanded-only rule releasing the chip strip so the sheet scrolls as one.'
  );
  assert.match(match[1], /max-height:\s*none/, 'Expected the 130px chip cap released when expanded.');
  assert.match(match[1], /overflow:\s*visible/, 'Expected no nested scroller inside the expanded sheet.');
});

test('Peek still clips the chips, so releasing them is expanded-only', () => {
  const block = mobileSheetBlock();
  const peek = block.match(
    /\.node-card\.is-open\.node-card--peek \.node-card__chips\s*{([^}]*)}/
  );
  assert.ok(peek, 'Expected the Peek chip clip to survive.');
  assert.match(peek[1], /max-height:\s*\d+px/, 'Peek must stay two clipped rows, not a released list.');
  assert.match(peek[1], /overflow:\s*hidden/, 'Peek must clip rather than scroll: it competes with the graph pan.');
});

test('the desktop card keeps its own scrollable chip strip', () => {
  const block = mobileSheetBlock();
  const outside = INDEX_HTML.replace(block, '');
  const base = outside.match(/\.node-card__chips\s*{([^}]*)}/);
  assert.ok(base, 'Expected the base .node-card__chips rule.');
  assert.match(
    base[1],
    /max-height:\s*130px/,
    'The desktop card still wants a capped chip strip; only the phone sheet releases it.'
  );
  assert.match(base[1], /overflow-y:\s*auto/, 'Expected the desktop strip to stay scrollable.');
});

test('the mobile sheet claims the vertical drag', () => {
  const block = mobileSheetBlock();
  const card = block.match(/\.node-card\s*{([\s\S]*?)}/);
  assert.ok(card, 'Expected the mobile .node-card rule.');
  assert.match(
    card[1],
    /touch-action:\s*pan-y/,
    'Expected touch-action: pan-y so a drag on the sheet scrolls it instead of panning the graph.'
  );
  assert.match(
    card[1],
    /overscroll-behavior:\s*contain/,
    'Expected overscroll containment so hitting the end of the list does not scroll the page behind it.'
  );
});

// -----------------------------------------------------------------------
// 7. Peek has to be legible as a collapsed sheet.
//
// Field report, Android: "The Accused card is still not scrolling. Only shows
// first 4 members and the rest of the card is static." Both halves were true
// and neither was the scroll bug — the card was in Peek, which is static by
// design, and nothing on screen said 17 more members existed or that a 4px
// grip was the way to them.
// -----------------------------------------------------------------------

test('the connections heading carries the real count', () => {
  assert.match(
    INDEX_HTML,
    /function connectionsLabel\(singular, plural, count\)/,
    'Expected a single helper building the connections heading.'
  );
  assert.match(
    INDEX_HTML,
    /nodeCardConnLabel\.textContent = connectionsLabel\('Member', 'Members', memberRows\.length\)/,
    'Expected the band card heading to count its members.'
  );
  assert.match(
    INDEX_HTML,
    /nodeCardConnLabel\.textContent = connectionsLabel\('Band', 'Bands', bandRows\.length\)/,
    'Expected the musician card heading to count their bands.'
  );
  // A clipped list under a bare "MEMBERS" is indistinguishable from a short
  // list. The count is what makes Peek readable as a collapsed state.
  assert.ok(
    !/textContent = \w+Rows\.length === 1 \? '(Member|Band)' : '(Members|Bands)'/.test(INDEX_HTML),
    'The uncounted heading must not come back.'
  );
});

test('a tap anywhere on a collapsed sheet expands it', () => {
  const idx = INDEX_HTML.indexOf("nodeCardEl.addEventListener('click'");
  assert.ok(idx > 0, 'Expected a click handler on the card itself.');
  const body = INDEX_HTML.slice(idx, idx + 700);
  assert.ok(
    body.includes("classList.contains('node-card--peek')"),
    'Expected the handler to act only while collapsed, so it cannot re-open a card mid-scroll.'
  );
  assert.ok(
    body.includes("setNodeCardSheetState('expanded')"),
    'Expected the body tap to expand rather than toggle: a tap on an expanded card must do nothing.'
  );
});

test('the expand-on-tap handler yields to every interactive child', () => {
  const idx = INDEX_HTML.indexOf("nodeCardEl.addEventListener('click'");
  const body = INDEX_HTML.slice(idx, idx + 700);
  const guard = body.match(/event\.target\.closest\(([^)]*)\)/);
  assert.ok(guard, 'Expected a closest() guard before expanding.');
  for (const sel of ['button', 'a', 'input', 'select']) {
    assert.ok(
      guard[1].includes(sel),
      `Expected <${sel}> excluded: a member chip must still travel, the X must still close.`
    );
  }
});

test('Peek fades its clipped edge instead of cutting it flat', () => {
  const block = mobileSheetBlock();
  const peek = block.match(/\.node-card\.is-open\.node-card--peek \.node-card__chips\s*{([^}]*)}/);
  assert.ok(peek, 'Expected the Peek chip rule.');
  assert.match(peek[1], /mask-image:\s*linear-gradient/, 'Expected a fade so the cut row reads as "more below".');
  assert.match(
    peek[1],
    /-webkit-mask-image:\s*linear-gradient/,
    'Expected the -webkit- prefix: Safari on iOS still needs it.'
  );
});
