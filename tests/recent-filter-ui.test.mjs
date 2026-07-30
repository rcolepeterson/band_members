// Regression tests for the Recently-added filter chip and the "Reset view"
// chip that replaced "All nodes".
//
// Same static-assertion approach as tests/mobile-toolbar-parity.test.mjs and
// tests/toolbar-ui-cleanup.test.mjs: index.html is one large classic script,
// so there is no module boundary to import across and no browser in this
// environment. We assert on the markup and on the shape of the handlers.
//
// The pure filter logic lives in scripts/recent-filter-helpers.mjs and is
// exercised for real in tests/recent-filter-helpers.test.mjs. The tests here
// additionally pin that index.html's hand-synced inline copy has not drifted
// from that module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RECENT_WINDOW_DAYS,
  RECENT_FALLBACK_WINDOW_DAYS,
  RECENT_FALLBACK_COUNT,
} from '../scripts/recent-filter-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const INDEX_HTML = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
const HELPERS_SRC = readFileSync(join(REPO_ROOT, 'scripts', 'recent-filter-helpers.mjs'), 'utf8');

function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

// The mobile hamburger sheet, which is the only toolbar mobile users see.
function extractMobileSheet() {
  const start = INDEX_HTML.indexOf('<aside class="mobile-sheet" id="mobile-menu-sheet"');
  assert.ok(start !== -1, 'Expected #mobile-menu-sheet in index.html');
  const end = INDEX_HTML.indexOf('</aside>', start);
  assert.ok(end > start, 'Expected a closing </aside> for #mobile-menu-sheet');
  return INDEX_HTML.slice(start, end);
}

// The desktop toolbar block (.graph-overlay-top), which is display:none on mobile.
function extractDesktopToolbar() {
  const start = INDEX_HTML.indexOf('<div class="graph-overlay graph-overlay-top">');
  assert.ok(start !== -1, 'Expected .graph-overlay-top in index.html');
  const end = INDEX_HTML.indexOf('</main>', start);
  assert.ok(end > start, 'Expected </main> after .graph-overlay-top');
  return INDEX_HTML.slice(start, end);
}

// Body of the global tool-chip click handler, comments stripped.
function extractToolChipHandler() {
  const match = INDEX_HTML.match(
    /toolChips\.forEach\(chip => \{\s*chip\.addEventListener\('click', \(\) => \{([\s\S]*?)\}\);\s*\}\);/
  );
  assert.ok(match, 'Expected the global toolChips click handler in index.html.');
  return stripJsComments(match[1]);
}

// ---- Item 1: Recently-added chip -------------------------------------------

test('Recently-added chip exists in BOTH the desktop toolbar and the mobile sheet', () => {
  // Mobile parity is the whole point: .graph-overlay-top is display:none at
  // <=900px, so a desktop-only chip strands the feature (the bug class that
  // PRs #42/#44/#45/#63 kept re-fixing).
  const desktop = stripHtmlComments(extractDesktopToolbar());
  const mobile = stripHtmlComments(extractMobileSheet());
  assert.match(desktop, /data-action="recent"/, 'Expected a data-action="recent" chip in the desktop toolbar.');
  assert.match(mobile, /data-action="recent"/, 'Expected a data-action="recent" chip in the mobile hamburger sheet.');
});

test('Recently-added chip is labelled and exposes toggle state to assistive tech', () => {
  const chipTags = [...INDEX_HTML.matchAll(/<button[^>]*data-action="recent"[^>]*>([^<]*)</g)];
  assert.equal(chipTags.length, 2, 'Expected exactly two Recently-added chips (desktop + mobile).');
  for (const match of chipTags) {
    assert.match(match[0], /aria-pressed="false"/, 'Recently-added chip must start with aria-pressed="false".');
    assert.match(match[1].trim(), /^Recently added$/, 'Recently-added chip label should read "Recently added".');
  }
});

test('Recently-added is NOT the default view: recentOnly initialises to false', () => {
  // Paul & Cole explicitly asked for the filter to be opt-in while the tester
  // pool is small, so a "recent" default would look sparse on a first visit.
  assert.match(
    stripJsComments(INDEX_HTML),
    /let\s+recentOnly\s*=\s*false\s*;/,
    'Expected `let recentOnly = false;` — the filter must be off on load.'
  );
  // And no chip may ship with the .active class pre-applied.
  const activeRecentChip = /<button[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-action="recent"/;
  assert.doesNotMatch(INDEX_HTML, activeRecentChip, 'Recently-added chip must not start active.');
});

test('Recently-added chip click toggles recentOnly and re-renders', () => {
  const handler = extractToolChipHandler();
  const branch = handler.match(/if \(chip\.dataset\.action === 'recent'\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(branch, "Expected an `if (chip.dataset.action === 'recent')` branch in the tool-chip handler.");
  const body = branch[1];
  assert.match(body, /recentOnly\s*=\s*!recentOnly/, 'The chip must toggle recentOnly (click again clears the filter).');
  assert.match(body, /syncFilterButtons\(\)/, 'The chip must re-sync chip active state after toggling.');
  assert.match(body, /renderGraph\(\)/, 'The chip must re-render the graph after toggling.');
});

test('recentOnly drives a filter stage in getFilteredGraph', () => {
  const match = INDEX_HTML.match(/function getFilteredGraph\(master\) \{([\s\S]*?)\n\s{6}return \{ nodes, links \};/);
  assert.ok(match, 'Expected getFilteredGraph in index.html.');
  const body = stripJsComments(match[1]);
  assert.match(
    body,
    /if \(recentOnly\) \{[\s\S]*?selectRecentBandIds\(master\.nodes\)[\s\S]*?restrictToBandsAndMembers\(nodes, links, selection\.ids\)/,
    'Expected getFilteredGraph to narrow nodes/links via selectRecentBandIds when recentOnly is on.'
  );
});

test('Recently-added composes with (rather than replaces) scene / genre / search', () => {
  // AND-composition: the recent stage must narrow the already-narrowed
  // nodes/links, and must not reset any of the other filter variables.
  const match = INDEX_HTML.match(/function getFilteredGraph\(master\) \{([\s\S]*?)\n\s{6}return \{ nodes, links \};/);
  const body = stripJsComments(match[1]);
  const recentIdx = body.indexOf('if (recentOnly)');
  assert.ok(recentIdx !== -1, 'Expected a recentOnly stage in getFilteredGraph.');
  for (const other of ['currentScene', 'currentGenre', 'currentSearch']) {
    assert.ok(body.includes(other), `Expected getFilteredGraph to still handle ${other}.`);
  }
  const recentStage = body.slice(recentIdx, body.indexOf('if (currentSearch)', recentIdx));
  assert.doesNotMatch(
    recentStage,
    /current(Scene|Genre|Search|Filter)\s*=/,
    'The recentOnly stage must not clear the other filters — the filters AND-compose.'
  );
});

test('an active Recently-added filter is visible in the graph stats HUD', () => {
  const match = INDEX_HTML.match(/const badgeParts = \[\];([\s\S]*?)graphBadge\.textContent/);
  assert.ok(match, 'Expected the badgeParts block in renderGraph.');
  assert.match(
    stripJsComments(match[1]),
    /if \(recentOnly\) badgeParts\.push\(describeRecentSelection\(/,
    'Expected renderGraph to add a Recently-added segment to the #graph-badge status line ' +
      'so the user can see a filter is applied.'
  );
});

test('the chip itself reflects active state on both platforms', () => {
  const match = INDEX_HTML.match(/function syncFilterButtons\(\) \{([\s\S]*?)\n\s{4}\}/);
  assert.ok(match, 'Expected syncFilterButtons in index.html.');
  const body = stripJsComments(match[1]);
  // querySelectorAll (not the toolChips snapshot) so the desktop and mobile
  // copies of the chip are both updated from one place.
  assert.match(
    body,
    /querySelectorAll\('\.tool-chip\[data-action="recent"\]'\)[\s\S]*?classList\.toggle\('active', recentOnly\)/,
    'Expected syncFilterButtons to toggle .active on every [data-action="recent"] chip from recentOnly.'
  );
  assert.match(
    body,
    /setAttribute\('aria-pressed', String\(recentOnly\)\)/,
    'Expected syncFilterButtons to keep aria-pressed in sync with recentOnly.'
  );
});

test('Recently-added is disabled when the loaded graph has no band timestamps', () => {
  // CSV-fallback mode carries no created_at, so the filter would otherwise
  // blank the graph. syncRecentFilterAvailability() disables the chip instead.
  const match = INDEX_HTML.match(/function syncRecentFilterAvailability\(\) \{([\s\S]*?)\n\s{4}\}/);
  assert.ok(match, 'Expected syncRecentFilterAvailability in index.html.');
  const body = stripJsComments(match[1]);
  assert.match(body, /countDatedBands\(graphState\.master\.nodes\)\s*>\s*0/, 'Availability must be derived from countDatedBands.');
  assert.match(body, /btn\.disabled\s*=\s*!available/, 'Expected the chip to be disabled when unavailable.');
  // And it must actually run once the graph is loaded.
  assert.match(
    stripJsComments(INDEX_HTML),
    /syncRecentFilterAvailability\(\);\s*syncFilterButtons\(\);/,
    'Expected syncRecentFilterAvailability() to run on load, alongside syncFilterButtons().'
  );
});

// ---- Item 2: Reset view ----------------------------------------------------

test('"All nodes" is gone, replaced by a "Reset view" chip on both platforms', () => {
  assert.doesNotMatch(INDEX_HTML, /<button[^>]*>All nodes<\/button>/, 'The "All nodes" chip should be gone.');
  assert.doesNotMatch(
    stripHtmlComments(INDEX_HTML),
    /data-filter="all"/,
    'data-filter="all" should be gone — the chip is now data-action="reset".'
  );
  const desktop = stripHtmlComments(extractDesktopToolbar());
  const mobile = stripHtmlComments(extractMobileSheet());
  for (const [name, block] of [['desktop toolbar', desktop], ['mobile sheet', mobile]]) {
    assert.match(block, /data-action="reset"/, `Expected a data-action="reset" chip in the ${name}.`);
    assert.match(block, /<button[^>]*data-action="reset"[^>]*>Reset view</, `Expected the ${name} chip to read "Reset view".`);
  }
});

test('Reset view clears every filter, including Recently-added', () => {
  const match = INDEX_HTML.match(/function resetView\(\) \{([\s\S]*?)\n\s{4}\}/);
  assert.ok(match, 'Expected a resetView() function in index.html.');
  const body = stripJsComments(match[1]);
  // No currentFilter here on purpose: the band/person view filter it backed was
  // retired in PR #68, so resetView has nothing of that kind left to clear.
  // tests/toolbar-ui-cleanup.test.mjs pins that it stays gone.
  for (const assignment of [
    /currentScene\s*=\s*'all'/,
    /currentGenre\s*=\s*'all'/,
    /currentSearch\s*=\s*''/,
    /recentOnly\s*=\s*false/,
  ]) {
    assert.match(body, assignment, `resetView must reset ${assignment}`);
  }
});

test('Reset view resets the desktop AND mobile filter inputs', () => {
  const body = stripJsComments(INDEX_HTML.match(/function resetView\(\) \{([\s\S]*?)\n\s{4}\}/)[1]);
  for (const id of ['scene-filter', 'mobile-scene-filter', 'genre-filter', 'mobile-genre-filter', 'node-search', 'mobile-node-search']) {
    assert.ok(
      body.includes(`getElementById('${id}')`),
      `resetView must clear #${id} — otherwise the control still shows a stale value after a reset.`
    );
  }
});

test('Reset view dismisses open popovers and the anchored node card', () => {
  const body = stripJsComments(INDEX_HTML.match(/function resetView\(\) \{([\s\S]*?)\n\s{4}\}/)[1]);
  assert.match(body, /closeBottomPopovers\(null\)/, 'resetView must close the toolbar popovers.');
  assert.match(body, /toggleSharePopover\(false\)/, 'resetView must close the share popover.');
  assert.match(body, /closeNodeCard\(\)/, 'resetView must dismiss the anchored node card.');
});

test('Reset view refits the camera and re-renders, keeping Fit graph as the narrower action', () => {
  const body = stripJsComments(INDEX_HTML.match(/function resetView\(\) \{([\s\S]*?)\n\s{4}\}/)[1]);
  assert.match(body, /renderGraph\(\)/, 'resetView must re-render the graph.');
  assert.match(body, /fitGraph\(/, 'resetView must refit the camera.');
  // Fit graph stays a separate, camera-only chip.
  const handler = extractToolChipHandler();
  const fitBranch = handler.match(/if \(chip\.dataset\.action === 'fit'\) \{([\s\S]*?)\}/);
  assert.ok(fitBranch, "Expected the 'fit' branch to survive.");
  assert.doesNotMatch(
    fitBranch[1],
    /current(Scene|Genre|Search|Filter)\s*=|recentOnly\s*=/,
    'Fit graph must stay camera-only — clearing filters is Reset view\'s job.'
  );
});

test('the Reset view chip is wired to resetView()', () => {
  const handler = extractToolChipHandler();
  assert.match(
    handler,
    /if \(chip\.dataset\.action === 'reset'\) \{\s*resetView\(\);\s*return;\s*\}/,
    "Expected the tool-chip handler to call resetView() for data-action=\"reset\"."
  );
});

test('"Clear filters" also drops the Recently-added filter', () => {
  // Clear filters is the narrower sibling of Reset view (no camera/popover
  // work). It must still clear every filter variable, or a user who clears
  // filters is left looking at a silently-still-filtered graph.
  const handler = extractToolChipHandler();
  const branch = handler.match(/if \(chip\.dataset\.action === 'clear'\) \{([\s\S]*?)\n\s{10}return;/);
  assert.ok(branch, "Expected the 'clear' branch in the tool-chip handler.");
  assert.match(branch[1], /recentOnly\s*=\s*false/, 'Clear filters must also reset recentOnly.');
});

// ---- Double-dispatch guard --------------------------------------------------

test('mobile-sheet chips are excluded from the global tool-chip handler', () => {
  // initMobileLayout() proxies every #mobile-sheet-tools tap onto the desktop
  // twin. Without this guard the global handler ALSO fires on the mobile chip,
  // applying the action twice — which silently cancels the Recently-added
  // toggle (and was a latent double-render for every other chip).
  const handler = extractToolChipHandler();
  assert.match(
    handler,
    /if \(chip\.closest\('#mobile-sheet-tools'\)\) return;/,
    'Expected the global tool-chip handler to bail on chips inside #mobile-sheet-tools.'
  );
  const guardIdx = handler.indexOf("chip.closest('#mobile-sheet-tools')");
  const firstAction = handler.search(/chip\.dataset\.action ===/);
  assert.ok(guardIdx < firstAction, 'The mobile-sheet guard must run before any action branch.');
});

// ---- Data plumbing ---------------------------------------------------------

test('/api/bands selects created_at so the client can date bands', () => {
  const src = readFileSync(join(REPO_ROOT, 'netlify', 'functions', 'bands_neon.mjs'), 'utf8');
  assert.match(
    src,
    /select id, name, city, state, country, genre, years_active, label, albums, csv_origin, created_at\s*\n\s*from bands/,
    'Expected the bands select in bands_neon.mjs to include created_at.'
  );
});

test('created_at is threaded from /api/bands onto band nodes', () => {
  assert.match(
    INDEX_HTML,
    /bandCreatedAt:\s*band\.created_at\s*\|\|\s*''/,
    'Expected normalizeNeonToRows to carry created_at through as bandCreatedAt.'
  );
  assert.match(
    INDEX_HTML,
    /createdAt:\s*bandCreatedAt/,
    'Expected buildMasterGraph to put createdAt on the band node.'
  );
});

test('bands added in-session inherit their submission timestamp', () => {
  // Otherwise a band you just added does not show up under Recently added
  // until the next reload, which reads as a bug.
  const match = INDEX_HTML.match(/function applyDraftToMaster\(master, draft\) \{([\s\S]*?)\n\s{4}\}/);
  assert.ok(match, 'Expected applyDraftToMaster in index.html.');
  assert.match(
    match[1],
    /createdAt:\s*String\(draft\.savedAt \|\| ''\)\.trim\(\)/,
    'Expected a new band node to take createdAt from the draft savedAt timestamp.'
  );
});

// ---- Inline-copy drift guard -----------------------------------------------

test('index.html inline copy agrees with scripts/recent-filter-helpers.mjs', () => {
  // The page is a classic script and cannot import the module, so the logic is
  // duplicated by hand. Pin the parts that would silently diverge.
  for (const [name, value] of [
    ['RECENT_WINDOW_DAYS', RECENT_WINDOW_DAYS],
    ['RECENT_FALLBACK_WINDOW_DAYS', RECENT_FALLBACK_WINDOW_DAYS],
    ['RECENT_FALLBACK_COUNT', RECENT_FALLBACK_COUNT],
  ]) {
    assert.match(
      INDEX_HTML,
      new RegExp(`const ${name} = ${value};`),
      `index.html's inline ${name} must match scripts/recent-filter-helpers.mjs (${value}).`
    );
  }
  for (const fn of ['parseCreatedAt', 'datedBandsNewestFirst', 'countDatedBands', 'selectRecentBandIds', 'describeRecentSelection']) {
    assert.match(INDEX_HTML, new RegExp(`function ${fn}\\(`), `index.html must carry an inline ${fn}().`);
    assert.match(HELPERS_SRC, new RegExp(`function ${fn}\\(`), `scripts/recent-filter-helpers.mjs must export/declare ${fn}().`);
  }
  // The cascade order is the behavioral contract most likely to drift.
  for (const src of [INDEX_HTML, HELPERS_SRC]) {
    assert.match(
      src,
      /for \(const days of \[windowDays, fallbackWindowDays\]\)/,
      'Both copies must try the primary window before the fallback window.'
    );
    assert.match(src, /mode: 'fallback-count'/, "Both copies must have the newest-N 'fallback-count' stage.");
  }
});

test('the docs comment in index.html points at the canonical helper module', () => {
  assert.match(
    INDEX_HTML,
    /scripts\/recent-filter-helpers\.mjs/,
    'Expected index.html to reference scripts/recent-filter-helpers.mjs so the hand-sync obligation is discoverable.'
  );
});
