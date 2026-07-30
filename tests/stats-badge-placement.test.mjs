// Stats HUD placement + removal of the duplicate node-count chip.
//
// Tester feedback after #76 (screenshot, desktop widths): the
// .graph-stats-badge ("3241 NODES · 3814 LINKS · 119 SCENES · FULL GRAPH")
// sat in the stage's top-RIGHT corner and the right end of the toolbar
// painted over it, so only its leading characters were readable
// ("...ES · 3814 LINKS · 119 SCENES · FULL GRAPH" in the report).
//
// #76 had already added vertical clearance between the badge and the auth
// strip, which was not enough: .graph-overlay-top is inset:0 0 auto 0, i.e.
// full-width, so there is no clear column on the right at any width. The fix
// moves the badge to the top-LEFT and drops it below the toolbar's
// worst-case (two-row) bottom edge. Mobile is deliberately untouched.
//
// Once the badge is on the left, the toolbar's leading "<n> nodes in tree"
// pill is a second copy of the badge's first number a few pixels away, so it
// is removed here too.
//
// Structural tests (index.html as a string) plus a small geometry model built
// from the REAL declared values, so raising the toolbar padding or the chip
// min-height without re-checking the badge fails this file rather than
// shipping a fresh overlap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

const REM = 16;

// The one-line critical-CSS rule that owns the badge's default box.
function baseBadgeRule() {
  const match = INDEX_HTML.match(/\n\s*\.graph-stats-badge\{([^}]*)\}/);
  assert.ok(match, 'Expected the base .graph-stats-badge rule in the critical CSS.');
  return match[1];
}

// The desktop-only override block.
function desktopBadgeBlock() {
  const match = INDEX_HTML.match(
    /@media \(min-width: 721px\) \{\s*\.graph-stats-badge \{([^}]*)\}/
  );
  assert.ok(match, 'Expected an @media (min-width: 721px) .graph-stats-badge block.');
  return match[1];
}

// ---------------------------------------------------------------------
// 1. Horizontal placement: the badge leaves the crowded right corner.
// ---------------------------------------------------------------------

test('the badge is anchored from the left, not the right', () => {
  const rule = baseBadgeRule();
  assert.match(rule, /left:\s*var\(--space-5\)/, 'Expected the badge to be pinned from the left.');
  assert.ok(
    !/(^|;)\s*right:/.test(rule),
    'The badge must not declare `right:` — that is what put it under the toolbar\'s ' +
      'Share / Add-your-band / Send-feedback / version cluster.'
  );
});

test('the desktop override does not re-pin the badge to the right edge', () => {
  // The horizontal move lives in the base rule so it applies at every width;
  // this block is vertical-only. A stray `right:` here would silently undo it.
  assert.ok(
    !/right:/.test(desktopBadgeBlock()),
    'The min-width:721px block must stay vertical-only.'
  );
});

test('the badge contents are left-aligned to match its new corner', () => {
  const rule = baseBadgeRule();
  assert.match(rule, /align-items:\s*flex-start/, 'Expected flex-start alignment.');
  assert.match(rule, /text-align:\s*left/, 'Expected left-aligned text.');
});

// ---------------------------------------------------------------------
// 2. Vertical clearance: the badge sits below the toolbar at every
//    desktop width.
// ---------------------------------------------------------------------

// Worst-case bottom edge of .graph-overlay-top, in px, built from the
// declared values rather than hardcoded numbers.
function toolbarGeometry() {
  const padding = INDEX_HTML.match(
    /\.graph-overlay-top \{\s*padding-top:\s*clamp\(([\d.]+)rem,\s*[\d.]+vh,\s*([\d.]+)rem\)/
  );
  assert.ok(padding, 'Expected .graph-overlay-top to set padding-top via clamp(<min>rem, <vh>, <max>rem).');

  const chip = INDEX_HTML.match(
    /\.tool-chip,[\s\S]{0,160}?\{\s*min-height:\s*(\d+)px\s*!important/
  );
  assert.ok(chip, 'Expected the compact .tool-chip min-height declaration.');

  const gap = INDEX_HTML.match(
    /\.graph-overlay-top \.graph-toolbar \{[\s\S]*?gap:\s*([\d.]+)rem/
  );
  assert.ok(gap, 'Expected a row-gap on the .graph-overlay-top toolbar.');

  return {
    paddingTopMax: Number(padding[2]) * REM,
    chipHeight: Number(chip[1]),
    rowGap: Number(gap[1]) * REM,
  };
}

function badgeDesktopTop() {
  const spaceMatch = INDEX_HTML.match(/--space-5:\s*([\d.]+)rem/);
  assert.ok(spaceMatch, 'Expected --space-5 to be declared in rem.');

  const topMatch = desktopBadgeBlock().match(/top:\s*calc\(var\(--space-5\)\s*\+\s*(\d+)px\)/);
  assert.ok(topMatch, 'Expected the desktop badge top to be var(--space-5) plus a px clearance.');

  return Number(spaceMatch[1]) * REM + Number(topMatch[1]);
}

test('the badge clears a two-row toolbar, which is the desktop worst case', () => {
  // The toolbar is one wrapping flex row: a single line on wide desktops,
  // two lines below ~1300px once the right cluster drops. Anything the
  // toolbar can occupy has to be above the badge's top edge.
  const { paddingTopMax, chipHeight, rowGap } = toolbarGeometry();
  const twoRowBottom = paddingTopMax + chipHeight * 2 + rowGap;

  assert.ok(
    badgeDesktopTop() >= twoRowBottom,
    `The badge starts at ${badgeDesktopTop()}px but a two-row toolbar reaches ` +
      `${twoRowBottom}px (${paddingTopMax} padding + 2x${chipHeight} rows + ${rowGap} gap). ` +
      'They would overlap the way the tester reported.'
  );
});

test('a third toolbar row cannot appear at a width where the badge is visible', () => {
  // This is the premise the two-row budget above rests on: the toolbar is
  // display:none below 901px, and it only needs a third row in a content box
  // far narrower than that. If the toolbar ever becomes visible on phones,
  // the badge's clearance has to be recomputed.
  assert.match(
    INDEX_HTML,
    /@media \(max-width: 900px\)[\s\S]*?\.graph-overlay-top \{ display: none; \}/,
    'Expected .graph-overlay-top to stay display:none at <=900px.'
  );
});

test('the badge still clears the auth strip that #76 moved it below', () => {
  // #76's clearance requirement does not go away just because the badge is
  // now in the other corner; the strip is ~50px tall.
  assert.ok(
    badgeDesktopTop() >= 50,
    `Expected the badge to start below the ~50px auth strip, got ${badgeDesktopTop()}px.`
  );
});

test('the badge stays a corner HUD instead of drifting into the graph', () => {
  // The overlay is inset:0 0 auto 0, so the badge and the toolbar necessarily
  // share horizontal columns at every width — vertical separation is the only
  // thing keeping them apart, which makes "push it further down" the tempting
  // fix for any future overlap. Cap it: past this the badge stops reading as an
  // upper-left HUD and starts sitting on the graph body.
  const badgeTop = badgeDesktopTop();
  assert.ok(
    badgeTop <= 200,
    `The badge starts at ${badgeTop}px. Beyond ~200px it is no longer in the ` +
      'stage corner; shrink the toolbar rather than pushing the badge down.'
  );
});

// ---------------------------------------------------------------------
// 3. Mobile placement is untouched.
// ---------------------------------------------------------------------

test('the mobile badge keeps its tight top-left corner', () => {
  // Phones hide both .header-right and .graph-overlay-top, so the badge needs
  // no toolbar clearance there and stays snug to the corner.
  assert.ok(
    INDEX_HTML.includes(
      '@media (max-width:720px){.graph-stats-badge{right:auto;top:var(--space-3);left:var(--space-3)'
    ),
    'The mobile placement must stay byte-identical.'
  );
});

test('the recent-window status readout still renders inside the badge', () => {
  // PR B writes "Recently added: last 30 days" into the badge's second line;
  // the badge CSS uppercases it. Moving the badge must not drop the line.
  assert.match(
    INDEX_HTML,
    /<div class="graph-stats-badge__status" id="graph-badge">/,
    'Expected the status line to stay nested in the badge.'
  );
  assert.ok(
    INDEX_HTML.includes('`Recently added: last ${selection.windowDays} days`'),
    'Expected the recent-window HUD text to survive.'
  );
});

// ---------------------------------------------------------------------
// 4. The duplicate "<n> nodes in tree" chip is gone.
// ---------------------------------------------------------------------

test('no node-count chip is left in the toolbar', () => {
  assert.ok(
    !INDEX_HTML.includes('graph-total-chip'),
    'The #graph-total-chip pill (and every reference to it) should be gone.'
  );
  assert.ok(
    !INDEX_HTML.includes('nodes in tree'),
    'The "<n> nodes in tree" label should be gone.'
  );
});

test('the chip-only .graph-status-chip style is removed with it', () => {
  assert.ok(
    !INDEX_HTML.includes('graph-status-chip'),
    'The pill was the only user of .graph-status-chip; the rule is now dead CSS.'
  );
});

test('the toolbar left cluster now opens with Reset view', () => {
  const cluster = INDEX_HTML.match(/<div class="graph-toolbar-left">([\s\S]*?)<\/div>/);
  assert.ok(cluster, 'Expected the .graph-toolbar-left cluster.');
  const firstElement = cluster[1].match(/<(span|button)[\s>]/);
  assert.ok(firstElement, 'Expected at least one control in the left cluster.');
  assert.match(
    cluster[1],
    /<button class="tool-chip" type="button" data-action="reset">Reset view<\/button>/,
    'Reset view should still be there.'
  );
  assert.equal(firstElement[1], 'button', 'The cluster should now lead with a real action, not a status pill.');
});

test('the mobile sheet does not carry a node-count chip either', () => {
  // Parity per #42/#44/#45/#63: a chip removed from the desktop toolbar must
  // not survive in the hamburger sheet.
  const sheet = INDEX_HTML.match(/<div class="mobile-sheet-tools"[\s\S]*?<\/div>/);
  assert.ok(sheet, 'Expected the #mobile-sheet-tools block.');
  assert.ok(!/nodes in tree|node-count|graph-total/.test(sheet[0]), 'No count pill in the sheet.');
});

test('the underlying node count is still computed for the badge', () => {
  // Only the duplicate readout was removed; the badge itself still needs the
  // number, so #metric-nodes and its assignment must stay.
  assert.match(
    INDEX_HTML,
    /<span class="graph-stats-badge__value" id="metric-nodes">/,
    'Expected the badge to keep its node-count slot.'
  );
  assert.ok(
    INDEX_HTML.includes('metricNodes.textContent = filtered.nodes.length;'),
    'Expected the node-count computation to survive.'
  );
});
