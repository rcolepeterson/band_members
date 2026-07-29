// Regression tests for the toolbar UI cleanups driven by beta-tester
// feedback (Matt Ashman):
//
//  1. The "Bands only" / "Musicians only" view toggles were removed.
//     The graph is not interesting without the band↔musician links, and
//     both toggles filter exactly those links away.
//  2. The top toolbar overlapped Chrome's Ctrl+F "find in page" bar,
//     which floats over the top-right of the content area.
//
// Both are asserted against index.html source text — this is a single
// static HTML file with no build step, so text assertions are how the
// rest of the suite (see mobile-toolbar-parity.test.mjs) checks UI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('the Bands-only and Musicians-only view chips are gone from both platforms', () => {
  // Covers the desktop toolbar (.graph-overlay-top) and the mobile
  // hamburger sheet (#mobile-sheet-tools) in one pass: neither chip
  // value may appear anywhere in the document.
  const leftovers = [];
  for (const value of ['band', 'person']) {
    if (INDEX_HTML.includes(`data-filter="${value}"`)) {
      leftovers.push(`data-filter="${value}"`);
    }
  }
  for (const label of ['Bands only', 'Musicians only', 'Musicians Only']) {
    // The retirement comment in syncFilterButtons() names both labels,
    // so only count occurrences inside a button element.
    const inButton = new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`);
    if (inButton.test(INDEX_HTML)) leftovers.push(label);
  }

  assert.deepEqual(
    leftovers,
    [],
    `Expected the type-filter toggles to stay retired, but found: ${leftovers.join(', ')}. ` +
      'They were removed because the graph loses its point once band↔musician ' +
      'links are filtered out (beta feedback, Matt Ashman).'
  );
});

test('the All-nodes chip and the Fit/Clear actions survive the removal', () => {
  // Guards against an over-eager cleanup taking the rest of the
  // left-hand chip cluster with it.
  for (const attr of ['data-filter="all"', 'data-action="fit"', 'data-action="clear"']) {
    assert.ok(
      INDEX_HTML.includes(attr),
      `Expected ${attr} to still exist — only the band/person toggles were retired.`
    );
  }
});

test('no JS still reads a removed per-type filter state', () => {
  assert.ok(
    !/\bcurrentFilter\b/.test(INDEX_HTML),
    'currentFilter was removed along with the toggles that set it. If a new ' +
      'per-type filter is reintroduced, give it a fresh name and its own tests.'
  );
});

test('the top toolbar reserves clearance for Chrome’s find-in-page bar', () => {
  // Chrome/Edge draw the Ctrl+F bar as a ~40px-tall overlay pinned to
  // the top-right of the content area, right on top of the toolbar's
  // Share / Add-your-band / Send-feedback cluster. The rule must set a
  // floor of at least 4rem (64px) so the first toolbar row clears it.
  const ruleMatch = INDEX_HTML.match(
    /\.graph-overlay-top\s*{[^}]*padding-top:\s*clamp\(\s*([\d.]+)rem\s*,/
  );
  assert.ok(
    ruleMatch,
    'Expected a .graph-overlay-top rule with a `padding-top: clamp(<min>rem, ...)` ' +
      'floor that keeps the toolbar below Chrome’s find-in-page bar.'
  );
  assert.ok(
    Number(ruleMatch[1]) >= 4,
    `The .graph-overlay-top padding-top floor is ${ruleMatch[1]}rem; it must be at ` +
      'least 4rem (64px) to clear Chrome’s ~40px find-in-page bar with margin. ' +
      'Reported by beta tester Matt Ashman.'
  );
});

test('the find-bar clearance does not leak into the bottom HUD', () => {
  // .graph-overlay-bottom is pinned to the bottom of the stage; extra
  // top padding there is dead space, and on mobile it is the only
  // overlay still visible. The clearance must be scoped to the top
  // overlay's own selector.
  const sharedRule = INDEX_HTML.match(
    /\/\* The top filter toolbar floats clear of the header \+ title band\. \*\/\s*\.graph-overlay\s*{([^}]*)}/
  );
  assert.ok(sharedRule, 'Expected the shared .graph-overlay padding-top rule to still exist.');
  assert.match(
    sharedRule[1],
    /padding-top:\s*clamp\(3\.2rem,/,
    'The shared .graph-overlay rule must keep its original 3.2rem floor so the ' +
      'bottom HUD spacing is unchanged; the raised floor belongs on .graph-overlay-top.'
  );
});
