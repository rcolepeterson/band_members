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
import { execFileSync } from 'node:child_process';
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

test('CDN versions are pinned in the import map, matching package.json', () => {
  // The explorer imports bare specifiers now; index.html's import map is the
  // single place the versions live, so that is what has to agree with
  // package.json (and what makes one shared Sigma instance possible).
  const graphology = PACKAGE.devDependencies.graphology;
  const sigma = PACKAGE.devDependencies.sigma;
  assert.ok(graphology, 'graphology must be a devDependency for the test suite');
  assert.ok(sigma, 'sigma must be a devDependency so the CDN pin is reviewable');
  const version = range => String(range).replace(/^[^0-9]*/, '');
  assert.match(INDEX_HTML, /<script type="importmap">/);
  assert.ok(
    INDEX_HTML.includes(`https://esm.sh/graphology@${version(graphology)}`),
    'the import map must pin the same graphology version as package.json'
  );
  assert.ok(
    INDEX_HTML.includes(`https://esm.sh/sigma@${version(sigma)}`),
    'the import map must pin the same sigma version as package.json'
  );
  // @sigma/edge-curve was removed when the constellation went to straight
  // lines: curved threads crossed each other and read as tangled tension. Its
  // absence is the invariant now -- if it comes back, so do the curves.
  assert.doesNotMatch(INDEX_HTML, /@sigma\/edge-curve/);
  assert.ok(
    !PACKAGE.devDependencies['@sigma/edge-curve'],
    'edge-curve must stay out of package.json: the constellation uses straight lines',
  );
  assert.match(EXPLORER, /^import Sigma from 'sigma';$/m);
  assert.match(EXPLORER, /^import Graph from 'graphology';$/m);
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

test('the home-star and focus labels avoid each other when they are close', () => {
  assert.match(EXPLORER, /\.sigma-home-star\.label-above \.home-label\{/);
  assert.match(EXPLORER, /classList\.toggle\('label-above', crowded\)/);
});

test('node sizes are scaled from the tested helpers, per view and on resize', () => {
  assert.match(EXPLORER, /nodeSizeScale\(\{/);
  assert.match(EXPLORER, /state\.sizeScale/);
  assert.match(EXPLORER, /renderer\.on\('resize', \(\) => applySizeScale\(\)\)/);
  assert.match(HELPERS, /export function densitySizeScale/);
  assert.match(HELPERS, /export function viewportSizeScale/);
  assert.match(HELPERS, /export function nodeSizeScale/);
});

test('label thresholds follow the drawn node size instead of a fixed 7', () => {
  assert.match(EXPLORER, /labelSettings\(\{/);
  assert.match(EXPLORER, /SMALLEST_NODE_SIZE \* state\.sizeScale/);
  assert.doesNotMatch(EXPLORER, /labelRenderedSizeThreshold: 7/);
  assert.match(HELPERS, /export function labelSettings/);
});

test('a highlight dims other nodes but keeps their names', () => {
  // Blanking labels on dim made names appear only on click.
  assert.match(EXPLORER, /labelColor: \{ attribute: 'labelColor', color: '#c8d3e0' \}/);
  assert.match(EXPLORER, /res\.labelColor = DIM_LABEL_COLOR;/);
  const code = EXPLORER.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /res\.label = '';\s*\n\s*\}\s*\n\s*\}/);
});

test('the layout is a proportional radial tree, not recursive wedge nesting', () => {
  // Recursive wedge subdivision was the expanded-view overlap bug: every
  // generation halved its slice until members landed on identical points.
  // Uniform per-layer slots replaced it and fixed overlap, but let a member
  // drift far from its own band, drawing membership edges across the middle.
  // The current design: a BFS tree where each child sits inside a window
  // centred on its parent, sized by what that subtree needs.
  assert.match(HELPERS, /BFS tree/);
  assert.match(HELPERS, /export const MAX_BRANCH_SPAN/);
  assert.match(HELPERS, /Subtree weights/);
  assert.match(HELPERS, /minSeparation/);
  assert.doesNotMatch(HELPERS, /wedges\.set\(/);
});

test('hidden overlays are really hidden', () => {
  // .sigma-home-star sets display:flex, which overrides the `hidden`
  // attribute's default display:none unless we say otherwise -- that bug
  // painted a phantom "you are here" star over unrelated views.
  assert.match(EXPLORER, /\.sigma-home-star\[hidden\],\s*\n#\$\{STAGE_ID\} \.sigma-focus-ring\[hidden\]\{display:none\}/);
});

test('the explorer module parses', () => {
  // node --test cannot import this file (it pulls sigma/graphology from the
  // CDN), so nothing else here would catch a plain syntax error. One did slip
  // in: a backtick inside a comment in the CSS template literal closed the
  // string early and the whole renderer failed to boot, silently, because the
  // flag is opt-in. `node --check` parses without executing imports.
  execFileSync(process.execPath, ['--check', join(ROOT, 'scripts', 'sigma-explorer.mjs')]);
  execFileSync(process.execPath, ['--check', join(ROOT, 'scripts', 'neighborhood-helpers.mjs')]);
});

test('the injected stylesheet contains no stray backticks', () => {
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `') + 19);
  const body = css.slice(0, css.indexOf('\n`;'));
  assert.ok(!body.includes('`'), 'a backtick inside STAGE_CSS would terminate the template literal');
});

test('dimmed nodes are opaque so edges cannot show through them', () => {
  // A translucent dim fill let gold highlight edges draw through the node and
  // read as two overlapping nodes.
  assert.match(EXPLORER, /const DIM_NODE_COLOR = '#[0-9a-f]{6}';/);
  assert.doesNotMatch(EXPLORER, /const DIM_NODE_COLOR = 'rgba/);
});

test('a framed view leaves room for labels', () => {
  // At camera ratio 1 Sigma frames the nodes exactly and clips the names of
  // everything near the edge.
  assert.match(EXPLORER, /const FRAMED_RATIO = 1\.\d+;/);
  // The framed ratio is compared with a tolerance rather than for equality,
  // because framingRatio() may return a smaller (zoomed-in) ratio on dense
  // views and the "already framed" branch must not fire on a float wobble.
  assert.match(EXPLORER, /ratio >= FRAMED_RATIO - 1e-6/);
});

test('the renderer frames views through the tested framing helper', () => {
  // The renderer must not compute its own camera ratio: framingRatio() in the
  // helpers is the unit-tested owner of "how far out should this view sit",
  // and the renderer reaches it through the local framedRatio() wrapper.
  assert.match(EXPLORER, /framingRatio\(\{/);
  assert.match(EXPLORER, /function framedRatio\(\)/);
  assert.match(EXPLORER, /const ratio = framedRatio\(\);/);
  assert.match(HELPERS, /export function framingRatio/);
});

test('hover is drawn in the theme, not with Sigma default white plate', () => {
  // Sigma's built-in hover renderer draws a white rounded plate behind the node
  // and label, which is jarring on a dark starfield and washes the label out.
  assert.match(EXPLORER, /defaultDrawNodeHover: drawHover/);
  assert.match(EXPLORER, /function drawHover\(context, data, settings\)/);
  assert.match(EXPLORER, /const HOVER_PLATE_FILL = 'rgba\(9,12,18,/);
  assert.doesNotMatch(EXPLORER, /HOVER_PLATE_FILL = '(#fff|white|rgba\(255)/);
});

test('overlay labels carry a dark halo so threads read as behind them', () => {
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `'));
  assert.match(css, /\.home-label\{[^}]*text-shadow:0 0 6px rgba\(8,11,17/s);
  assert.match(css, /\.focus-label\{[^}]*text-shadow:0 0 6px rgba\(8,11,17/s);
});

test('overlay labels are not shouted in uppercase', () => {
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `'));
  const labelRules = css.match(/\.(home|focus)-label\{[^}]*\}/gs) || [];
  // Not a fixed count: besides the two base rules there is a .label-above
  // variant that repositions the home label when it would collide with the
  // focus label. Every rule that touches these labels has to stay un-shouted.
  assert.ok(labelRules.length >= 2, `expected both overlay label rules, found ${labelRules.length}`);
  labelRules.forEach(rule => assert.doesNotMatch(rule, /text-transform:\s*uppercase/));
});

test('the search prompt is sized as the primary action, and never zooms iOS', () => {
  // STAGE_CSS is a template literal, so every selector carries a `#${STAGE_ID}`
  // interpolation whose braces would break naive rule matching. Flatten it.
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `')).replace(/\$\{STAGE_ID\}/g, 'stage');
  const inputRule = css.match(/\.sigma-prompt input\{[^}]*\}/s);
  assert.ok(inputRule, 'the prompt input needs a style rule');
  // iOS Safari zooms the page when a focused input's text is under 16px, which
  // throws the constellation off screen on the very first interaction.
  const fontSize = inputRule[0].match(/font-size:clamp\((\d+)px/);
  assert.ok(fontSize, 'the input font size should be a clamp() with a floor');
  assert.ok(Number(fontSize[1]) >= 16, `input font floor is ${fontSize[1]}px, must be >= 16px`);
  // A narrow phone plus generous padding is exactly where a button label wraps
  // mid-word. The button's styling is spread over more than one rule (it shares
  // its height with the input), so this checks their union rather than assuming
  // which rule carries which property.
  const buttonRules = (css.match(/[^{}]*\.sigma-prompt button[^{]*\{[^}]*\}/gs) || []).join('\n');
  assert.ok(buttonRules, 'the prompt button needs a style rule');
  assert.match(buttonRules, /white-space:nowrap/);
  assert.match(buttonRules, /flex:none/);
  // Both controls take their height from one declaration, so they cannot drift
  // apart the way padding-derived heights did (the button rendered 8px taller).
  assert.match(buttonRules, /height:clamp\(/);
  const inputRules = (css.match(/[^{}]*\.sigma-prompt input[^{]*\{[^}]*\}/gs) || []).join('\n');
  assert.match(inputRules, /height:clamp\(/);
});

test('search suggestions are alphabetical, and cover every band', () => {
  // Clicking the empty field shows the list as-is, so DOM order IS the order the
  // visitor reads. Relevance ordering (frontier first, then an arbitrary corpus
  // slice) looked random in that moment.
  assert.match(EXPLORER, /\.sort\(\(a, b\) => a\.localeCompare\(b, undefined, \{ sensitivity: 'base', numeric: true \}\)\)/);
  // Every band, not a slice of the node list.
  assert.match(EXPLORER, /const bandNames = master\.nodes\.filter\(node => node\.type === 'band'\)/);
  assert.doesNotMatch(EXPLORER, /master\.nodes\.slice\(0, 200\)/);
  assert.match(EXPLORER, /const MAX_SUGGESTIONS = \d+;/);
});

test('only bands are suggested, never the 2,700 musicians', () => {
  // A deliberate product decision, not an accident of the corpus slice this
  // replaced: musicians would outnumber bands roughly six to one and bury them.
  // Typing a musician's name still resolves through resolveAnchor -- they are
  // findable, just not offered.
  const block = EXPLORER.slice(
    EXPLORER.indexOf('// Search suggestions'),
    EXPLORER.indexOf('datalist.innerHTML') + 400,
  );
  assert.ok(block.includes('bandNames'), 'suggestions come from the band list');
  assert.ok(
    !/type === 'person'/.test(block) && !/master\.nodes\.map/.test(block),
    'suggestions must not be drawn from the full node list',
  );
  // The one non-band source is the frontier, which is what expanding would
  // reach next; it is bounded so it cannot flood the list either.
  assert.match(block, /view\.frontier\.slice\(0, \d+\)/);
});
