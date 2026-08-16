// Structural tests for the Sigma renderer's page wiring (issue #80).
//
// The explorer itself (scripts/sigma-explorer.mjs) imports sigma and
// graphology from the CDN, so node --test cannot execute it -- same constraint
// the repo already lives with for d3. These are static assertions in the style
// of mobile-toolbar-parity.test.mjs and search-empty-state.test.mjs, and they
// exist to catch the regressions that would actually hurt:
//
//   1. The flag really is opt-in. index.html must not activate Sigma for
//      normal visitors, and the SVG renderer must stay in place.
//   2. The data bridge exists. index.html publishes its master graph and
//      announces it; the module listens for exactly that event name. A
//      renamed event on one side and not the other is a silent blank stage.
//   3. The interaction contract survives: electric blue on band click, gold
//      on member click, using the same hex values as the SVG renderer's CSS.
//   4. The 2.5D promise: no camera rotation, no orbit, no pilot mode.
//   5. The exploration affordances promised in the issue are present: the
//      "Who's your favorite band?" prompt, the expand action, the
//      larger-universe copy, and the silver ringed home star.
//   6. Mobile parity: the new stage chrome is not desktop-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX_HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const EXPLORER = readFileSync(join(ROOT, 'scripts', 'sigma-explorer.mjs'), 'utf8');
const HELPERS = readFileSync(join(ROOT, 'scripts', 'neighborhood-helpers.mjs'), 'utf8');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Opt-in only
// ---------------------------------------------------------------------------

test('index.html loads the explorer as a module and nothing else changes renderer', () => {
  assert.match(
    INDEX_HTML,
    /<script type="module" src="scripts\/sigma-explorer\.mjs"><\/script>/,
    'the explorer must be loaded as an ES module from index.html'
  );
  // The SVG renderer is still the one the page builds on load.
  assert.match(INDEX_HTML, /<svg id="graph-svg"/);
  assert.match(INDEX_HTML, /https:\/\/d3js\.org\/d3\.v7\.min\.js/);
});

test('the module self-boots only for ?renderer=sigma', () => {
  assert.match(EXPLORER, /rendererFromSearch\(win\.location\.search\) !== 'sigma'\) return;/);
  assert.match(HELPERS, /export const DEFAULT_RENDERER = 'svg';/);
});

// ---------------------------------------------------------------------------
// 2. Data bridge
// ---------------------------------------------------------------------------

test('index.html publishes the master graph exactly where graphState is set', () => {
  assert.match(INDEX_HTML, /function publishMasterGraph\(master\)/);
  assert.match(INDEX_HTML, /window\.RBFT_MASTER_GRAPH = master;/);
  const assignments = INDEX_HTML.match(/graphState = \{ master \};/g) || [];
  const publishes = INDEX_HTML.match(/publishMasterGraph\(master\);/g) || [];
  assert.ok(assignments.length > 0, 'expected graphState assignments to exist');
  assert.equal(
    publishes.length,
    assignments.length,
    'every graphState = { master } must be followed by publishMasterGraph(master)'
  );
});

test('both sides of the bridge agree on the event and global names', () => {
  assert.match(INDEX_HTML, /'rbft:graph-ready'/);
  assert.match(EXPLORER, /'rbft:graph-ready'/);
  assert.match(EXPLORER, /win\.RBFT_MASTER_GRAPH/);
});

// ---------------------------------------------------------------------------
// 3. Interaction contract (blue / gold)
// ---------------------------------------------------------------------------

test('highlight hues match the SVG renderer CSS exactly', () => {
  assert.match(EXPLORER, /BAND_HIGHLIGHT_COLOR = '#27b8ff'/);
  assert.match(EXPLORER, /MEMBER_HIGHLIGHT_COLOR = '#ffb454'/);
  // The values the SVG renderer already ships.
  assert.match(INDEX_HTML, /\.node\.band-highlight \.node-core,[\s\S]{0,120}stroke: #27b8ff;/);
  assert.match(INDEX_HTML, /\.node\.member-highlight \.node-core,[\s\S]{0,120}stroke: #ffb454;/);
});

test('band click highlights members, member click highlights bands', () => {
  assert.match(
    EXPLORER,
    /entityType === 'band' \? BAND_HIGHLIGHT_COLOR : MEMBER_HIGHLIGHT_COLOR/,
    'selection colour must be chosen by the clicked entity type'
  );
  assert.match(EXPLORER, /renderer\.on\('clickNode'/);
  assert.match(EXPLORER, /renderer\.on\('clickStage', \(\) => clearHighlight\(\)\)/);
});

// ---------------------------------------------------------------------------
// 4. 2.5D only
// ---------------------------------------------------------------------------

test('camera rotation, orbit and pilot mode are absent', () => {
  assert.match(EXPLORER, /enableCameraRotation: false/);
  assert.doesNotMatch(EXPLORER, /enableCameraRotation:\s*true/);
  // Comments stripped first: the file's header comment names the very
  // features these assertions check are not implemented.
  const code = EXPLORER.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /pilot/i, 'no pilot mode');
  assert.doesNotMatch(code, /orbit/i, 'no orbit controls');
  // No middle-click orbit handlers.
  assert.doesNotMatch(code, /auxclick|button === 1/);
});

// ---------------------------------------------------------------------------
// 5. Exploration affordances + home star
// ---------------------------------------------------------------------------

test('the discovery prompt and larger-universe copy are present', () => {
  assert.match(EXPLORER, /Who&rsquo;s your favorite band\?/);
  assert.match(EXPLORER, /larger music universe/);
  assert.match(EXPLORER, /Expand this constellation/);
  assert.match(EXPLORER, /data-action="expand"/);
});

test('a search miss invites the visitor to add the band', () => {
  assert.match(EXPLORER, /have not mapped/);
  assert.match(EXPLORER, /rbft:sigma-search-miss/);
});

test('the anchor renders as a silver ringed star with a you-are-here label', () => {
  assert.match(HELPERS, /nodeType: 'ringed-star'/);
  assert.match(HELPERS, /label: 'You are here'/);
  assert.match(EXPLORER, /sigma-home-star/);
  assert.match(EXPLORER, /you are here/);
  // The ring and the silver core are both drawn.
  assert.match(EXPLORER, /\.sigma-home-star \.ring\{/);
  assert.match(EXPLORER, /\.sigma-home-star \.core\{/);
});

test('the opening view is capped and the frontier is surfaced', () => {
  assert.match(EXPLORER, /NEIGHBORHOOD_BUDGET\.OPENING_MAX_NODES/);
  assert.match(EXPLORER, /just beyond this view/);
  assert.match(HELPERS, /OPENING_MAX_NODES: 60/);
  assert.match(HELPERS, /MAX_NODES: 100/);
});

// ---------------------------------------------------------------------------
// 6. Mobile parity + dependency pinning
// ---------------------------------------------------------------------------

test('stage chrome is not hidden on small screens', () => {
  // The prompt and expand controls get repositioned under 720px, never
  // display:none -- the PR #42/#44/#45/#63 trap.
  const mobileBlock = EXPLORER.slice(EXPLORER.indexOf('@media (max-width:720px)'));
  assert.ok(mobileBlock.includes('.sigma-prompt'), 'the prompt must be tuned for mobile');
  assert.doesNotMatch(mobileBlock, /display:\s*none/);
});

test('CDN versions are pinned to the same majors as package.json', () => {
  const graphology = PACKAGE.devDependencies.graphology;
  const sigma = PACKAGE.devDependencies.sigma;
  assert.ok(graphology, 'graphology must be a devDependency for the test suite');
  assert.ok(sigma, 'sigma must be a devDependency so the CDN pin is reviewable');
  const major = range => String(range).replace(/^[^0-9]*/, '').split('.')[0];
  const minor = range => String(range).replace(/^[^0-9]*/, '').split('.')[1];
  assert.match(EXPLORER, new RegExp(`graphology@${major(graphology)}\\.${minor(graphology)}`));
  assert.match(EXPLORER, new RegExp(`sigma@${major(sigma)}\\.`));
});

test('the explorer keeps its logic in the tested helper module', () => {
  // Anything worth asserting about traversal, budgets, anchors, layout or
  // classification belongs in neighborhood-helpers.mjs, which has real unit
  // tests. The renderer should import it, not reimplement it.
  ['getNeighborhood', 'resolveAnchor', 'radialLayout', 'classifyNode', 'buildAdjacency'].forEach(
    name => assert.match(EXPLORER, new RegExp(`\\b${name}\\b`), `${name} must come from the helpers`)
  );
  assert.doesNotMatch(EXPLORER, /forceSimulation/, 'no force layout on the Sigma path');
});
