// Regression tests for mobile toolbar parity.
//
// The desktop toolbar (.graph-overlay-top) is display:none on mobile
// (<=900px) — mobile users route through the hamburger sheet
// (#mobile-menu-sheet). Every user-facing action in the desktop
// toolbar must therefore have a matching entry point inside the
// mobile sheet, otherwise the feature is stranded on desktop.
//
// This suite exists because "Add your band" was silently stranded on
// mobile for ~24 PRs after PR #18 unified the toolbar, and nobody
// noticed until PR #41. The whole-toolbar parity check below catches
// that class of regression generally; the explicit Add-your-band
// assertion documents the specific historical bug.
//
// If you intentionally retire a desktop toolbar action (as PR #18 did
// with Focus Seattle and Theme toggle), add it to KNOWN_MOBILE_EXEMPT
// with a short rationale so future readers know it's not stranded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// Extract the substring between a start marker (matched by regex) and
// the first occurrence of a plain end marker after it.
function sliceBetween(source, startRegex, endMarker) {
  const startMatch = source.match(startRegex);
  assert.ok(startMatch, `Expected to find start marker ${startRegex} in index.html`);
  const startIdx = startMatch.index;
  const endIdx = source.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `Expected to find end marker "${endMarker}" after start marker`);
  return source.slice(startIdx, endIdx);
}

// Grab the mobile hamburger sheet block. The sheet appears before
// the desktop toolbar in document order.
function extractMobileSheet() {
  return sliceBetween(
    INDEX_HTML,
    /<aside class="mobile-sheet" id="mobile-menu-sheet"/,
    '</aside>'
  );
}

// User-facing action controls in the desktop toolbar that MUST have a
// mobile equivalent. Each entry: { desktopId, mobileMatch, label }.
// mobileMatch is a substring or regex that must appear inside the
// mobile sheet markup for the parity check to pass.
const REQUIRED_PARITY = [
  { desktopId: 'node-search',      mobileMatch: 'mobile-node-search',      label: 'Search input' },
  { desktopId: 'scene-filter',     mobileMatch: 'mobile-scene-filter',     label: 'Scene filter select' },
  { desktopId: 'country-chip-row', mobileMatch: 'mobile-country-chip-row', label: 'Country quick-filter chips' },
  { desktopId: 'genre-filter',     mobileMatch: 'mobile-genre-filter',     label: 'Genre filter select' },
  { desktopId: 'share-graph-btn',  mobileMatch: 'mobile-share-btn',        label: 'Share this graph' },
  { desktopId: 'add-band-btn',     mobileMatch: 'mobile-add-band-btn',     label: 'Add your band' },
];

// data-filter / data-action chips share the same attribute values
// between desktop and mobile, so the mobile sheet just has to contain
// the same value.
const REQUIRED_CHIP_PARITY = [
  { attr: 'data-filter', value: 'all' },
  { attr: 'data-filter', value: 'band' },
  { attr: 'data-filter', value: 'person' },
  { attr: 'data-action', value: 'fit' },
  { attr: 'data-action', value: 'clear' },
];

// Controls that used to live in the desktop toolbar but were
// intentionally retired for both platforms. Keep this list in sync
// with the in-code retirement comments so this test doesn't
// mistakenly demand a mobile equivalent for something that no longer
// exists on desktop either.
const KNOWN_MOBILE_EXEMPT = new Set([
  'focus-seattle',   // Retired in PR #18 — behavior available via Scene → Seattle.
  'theme-toggle',    // Retired in PR #18 (desktop) and PR #34 (mobile) — both platforms now follow prefers-color-scheme.
]);

test('desktop toolbar exists and is hidden on mobile via CSS', () => {
  assert.ok(
    INDEX_HTML.includes('<div class="graph-overlay graph-overlay-top">'),
    'expected .graph-overlay-top block in index.html'
  );
  // Sanity check the CSS that strands controls on mobile actually exists.
  // If someone removes this rule, mobile users get the full desktop toolbar
  // and this whole parity concern goes away — but that's a big enough
  // change that the test failure here should force a conversation.
  assert.match(
    INDEX_HTML,
    /@media \(max-width: 900px\)[\s\S]*?\.graph-overlay-top\s*{\s*display:\s*none/,
    'expected .graph-overlay-top to be display:none on mobile (<=900px)'
  );
});

test('every required desktop toolbar action has a mobile-sheet equivalent', () => {
  const mobileSheet = extractMobileSheet();
  const stranded = [];

  for (const { desktopId, mobileMatch, label } of REQUIRED_PARITY) {
    // The desktop control must actually exist — otherwise we're checking
    // parity against a ghost. If the control was retired, add it to
    // KNOWN_MOBILE_EXEMPT instead of leaving it in REQUIRED_PARITY.
    if (KNOWN_MOBILE_EXEMPT.has(desktopId)) continue;
    assert.ok(
      INDEX_HTML.includes(`id="${desktopId}"`),
      `Expected desktop control #${desktopId} (${label}) to exist. ` +
        `If this control was retired, remove it from REQUIRED_PARITY and add it to KNOWN_MOBILE_EXEMPT.`
    );
    if (!mobileSheet.includes(mobileMatch)) {
      stranded.push(`#${desktopId} (${label}) — expected mobile equivalent matching "${mobileMatch}"`);
    }
  }

  assert.deepEqual(
    stranded,
    [],
    `Desktop toolbar controls stranded on mobile:\n  - ${stranded.join('\n  - ')}\n\n` +
      `Every action in .graph-overlay-top must have a matching entry point ` +
      `inside #mobile-menu-sheet (the desktop toolbar is display:none on mobile).`
  );
});

test('filter and action chips have matching data-attr values in the mobile sheet', () => {
  const mobileSheet = extractMobileSheet();
  const missing = [];
  for (const { attr, value } of REQUIRED_CHIP_PARITY) {
    if (!mobileSheet.includes(`${attr}="${value}"`)) {
      missing.push(`${attr}="${value}"`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Mobile sheet is missing chips: ${missing.join(', ')}`
  );
});

// Explicit regression test for the specific bug fixed in PR #42.
// Keep this even though the parity loop above would also catch it —
// a named test surfaces the historical context on failure.
test('regression: mobile Add-your-band entry point exists (PR #42)', () => {
  const mobileSheet = extractMobileSheet();
  assert.ok(
    mobileSheet.includes('id="mobile-add-band-btn"'),
    'Expected #mobile-add-band-btn inside #mobile-menu-sheet. ' +
      'The desktop #add-band-btn is inside .graph-overlay-top (display:none on mobile), ' +
      'so mobile users need their own trigger. See PR #42 for context.'
  );
  // The trigger must also be wired up — otherwise the button is a no-op.
  assert.match(
    INDEX_HTML,
    /getElementById\(['"]mobile-add-band-btn['"]\)[\s\S]{0,400}addEventListener/,
    'Expected a click handler bound to #mobile-add-band-btn.'
  );
  // And the handler must actually reach the desktop button that opens
  // the popover (which hookPopoverForMobile converts to a bottom sheet).
  assert.match(
    INDEX_HTML,
    /getElementById\(['"]mobile-add-band-btn['"]\)[\s\S]{0,800}getElementById\(['"]add-band-btn['"]\)/,
    'Expected the #mobile-add-band-btn handler to trigger the desktop #add-band-btn.'
  );
});
