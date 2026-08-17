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
  // Expand moved from a lone bottom-right button ("Expand this constellation")
  // into the shortcut row, where a one-word label carries the sentence in its
  // popover instead of in the label itself.
  const expand = STAGE_ACTIONS().find(item => item.key === 'expand');
  assert.ok(expand, 'the shortcut row must include an expand action');
  assert.equal(expand.label, 'Expand');
  assert.match(expand.detail, /horizon|beyond/i);
});

/** Parses the STAGE_ACTIONS table out of the module source. */
function STAGE_ACTIONS() {
  const block = EXPLORER.slice(
    EXPLORER.indexOf('const STAGE_ACTIONS = ['),
    EXPLORER.indexOf('// Upper bound on datalist options'),
  );
  // Tolerates comment lines between the fields: the copy carries reasoning, and
  // an entry is allowed to explain itself without breaking this parser.
  return [...block.matchAll(/key: '([a-z]+)',([\s\S]*?)\n\s*(?:target|action):/g)].map(
    ([, key, body]) => ({
      key,
      label: (body.match(/label: '([^']+)'/) || [])[1] || '',
      detail: (body.match(/detail:\s*'([^']+)'/) || [])[1] || '',
    }),
  );
}

test('every shortcut pill has a one-word label and a sentence explaining it', () => {
  const actions = STAGE_ACTIONS();
  // The whole row, per the agreed design: nothing else competes with the hero.
  assert.deepEqual(
    actions.map(item => item.key),
    // No Sign-in pill: the page's account strip in the site header is kept as
    // the single entry point, top-right where a search homepage puts the avatar.
    ['expand', 'reset', 'add', 'share', 'feedback'],
  );
  actions.forEach(({ key, label, detail }) => {
    // A pill only fits a short label; two words at most ("Sign in").
    assert.ok(label.length <= 9, `${key}: label "${label}" is too long for a pill`);
    assert.ok(label.split(' ').length <= 2, `${key}: label "${label}" is more than two words`);
    // One word cannot explain itself -- "Reset" resets WHAT? -- so the sentence
    // is required, and it has to be a sentence.
    assert.ok(detail.length > 25, `${key}: detail is too terse to explain the button`);
    assert.match(detail, /\.$/, `${key}: detail should read as a sentence`);
  });
});

test('the shortcut popover works for hover, keyboard and touch', () => {
  // A title attribute is invisible on touch and to keyboard users, so the
  // popover is a real element driven by all three input paths.
  assert.match(EXPLORER, /addEventListener\('pointerenter'/);
  assert.match(EXPLORER, /addEventListener\('focus'/);
  assert.match(EXPLORER, /addEventListener\('blur'/);
  assert.match(EXPLORER, /aria-describedby="\$\{TIP_ID\}"/);
  assert.match(EXPLORER, /role="tooltip"/);
  // And it must be dismissable, or a tap-opened popover traps a phone user.
  assert.match(EXPLORER, /event\.key === 'Escape'/);
  assert.match(EXPLORER, /addEventListener\('pointerdown'/);
  // Clamped so the end pills of a centred row cannot push it off screen.
  assert.match(EXPLORER, /Math\.max\(margin, Math\.min\(left, stageBox\.width - width - margin\)\)/);
});

test('the page\'s own duplicate chrome stands down while Sigma renders', () => {
  // Both renderers share index.html. Without this the visitor saw two toolbars
  // for one graph.
  assert.match(EXPLORER, /const BODY_ACTIVE_CLASS = 'rbft-sigma-chrome';/);
  assert.match(EXPLORER, /doc\.body\.classList\.add\(BODY_ACTIVE_CLASS\)/);
  // And it must be given back, since the flag is switchable at runtime.
  assert.match(EXPLORER, /doc\.body\.classList\.remove\(BODY_ACTIVE_CLASS\)/);
  ['.hero', '.graph-overlay-top', '.graph-stats-badge'].forEach(selector => {
    assert.ok(
      EXPLORER.includes(`body.\${BODY_ACTIVE_CLASS} ${selector}`),
      `${selector} should stand down while Sigma renders`,
    );
  });
});

test('the wordmark stays on screen above the search field', () => {
  assert.match(EXPLORER, /class="sigma-wordmark">Rock Band Family Tree<\/h1>/);
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `')).replace(/\$\{STAGE_ID\}/g, 'stage');
  const hero = css.match(/\.sigma-hero\{[^}]*\}/s);
  assert.ok(hero, 'the hero needs a style rule');
  // Anchored to the top of the stage, like a search homepage.
  assert.match(hero[0], /top:clamp\(/);
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
  // The prompt and shortcut pills get repositioned under 720px, never
  // display:none -- the PR #42/#44/#45/#63 trap.
  //
  // Checks rules rather than a slice of text: the module now also contains
  // legitimate display:none rules for the PAGE's duplicate toolbar, and a
  // blunt "no display:none after this point" search flagged those.
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `')).replace(/\$\{STAGE_ID\}/g, 'stage');
  const mediaBlocks = [...css.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)].map(m => m[1]);
  assert.ok(mediaBlocks.length, 'expected at least one responsive block');
  assert.ok(css.includes('#stage .sigma-prompt'), 'the prompt must be tuned for mobile');
  mediaBlocks.forEach(block => {
    [...block.matchAll(/([^{}\n]*#stage[^{]*)\{([^}]*)\}/g)].forEach(([, selector, body]) => {
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `a responsive rule hides stage chrome: ${selector.trim()}`,
      );
    });
  });
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

test('Aaron\'s name moves aside when the focus ring is close', () => {
  // Aaron is often one hop from whatever a visitor searched for, so his name
  // would print across the focus ring. Only his star carries a label now -- the
  // focus ring's own label repeated the node label Sigma already draws -- so
  // this is about moving one label, not separating two.
  assert.match(EXPLORER, /Math\.hypot\(homePoint\.x - focusPoint\.x, homePoint\.y - focusPoint\.y\) < 120/);
  assert.match(EXPLORER, /placeLabel\(homeLabelEl, homePoint, homeStarEl, homeScale, crowded\)/);
  assert.doesNotMatch(EXPLORER, /sigma-focus-label/);
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

test('the star label carries a dark halo so threads read as behind it', () => {
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `')).replace(/\$\{STAGE_ID\}/g, 'stage');
  const rule = css.match(/\.sigma-star-label\{[^}]*\}/s);
  assert.ok(rule, 'the star label needs a rule');
  assert.match(rule[0], /text-shadow:0 0 7px rgba\(8,11,17/);
});

test('the star label is gold, larger than a node label, and not shouted', () => {
  const css = EXPLORER.slice(EXPLORER.indexOf('const STAGE_CSS = `')).replace(/\$\{STAGE_ID\}/g, 'stage');
  const rule = css.match(/\.sigma-home-label\{[^}]*\}/s);
  assert.ok(rule, 'the home label needs a rule');
  // Gold, so the one fixed point in the galaxy reads as a different kind of
  // thing from the band and musician names around it.
  assert.match(rule[0], /color:#ffc978/);
  const size = rule[0].match(/font-size:(\d+(?:\.\d+)?)px/);
  assert.ok(size && Number(size[1]) >= 13, `home label is ${size && size[1]}px; should be >= 13px`);
  assert.doesNotMatch(rule[0], /text-transform:\s*uppercase/);
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

test('the page panels the pills open are moved out of the retired toolbar', () => {
  // Add / Share / Feedback panels are nested INSIDE the toolbar that stands
  // down, so hiding the toolbar hid them too and the pills opened nothing.
  assert.match(EXPLORER, /const RELOCATED_PANELS = \['#add-band-popover', '#share-popover', '#feedback-popover'\]/);
  assert.match(EXPLORER, /stage\.appendChild\(panel\)/);
  // And they must be put back, or switching the flag off loses them entirely.
  assert.match(EXPLORER, /parent\.insertBefore\(panel, next\)/);
  const destroy = EXPLORER.slice(EXPLORER.indexOf('    destroy() {'));
  const restore = destroy.indexOf('parent.insertBefore(panel, next)');
  const removeStage = destroy.indexOf('stage.remove()');
  assert.ok(restore > -1 && removeStage > -1 && restore < removeStage,
    'panels must be rescued before the stage is removed, or they go with it');
});

test('a pill click does not reach the page-wide popover closer', () => {
  // The page closes its popovers on any click outside them. Without
  // stopPropagation the pill's own click bubbled to that handler and shut the
  // panel in the tick it opened -- the buttons looked broken.
  const handler = EXPLORER.slice(
    EXPLORER.indexOf("button.addEventListener('click', event => {"),
    EXPLORER.indexOf('runAction(item);') + 40,
  );
  assert.match(handler, /event\.stopPropagation\(\)/);
});

test('pills drive the page\'s real controls rather than reimplementing them', () => {
  // Two implementations of "add a band" would drift apart; these forward to the
  // existing buttons instead.
  assert.match(EXPLORER, /const target = doc\.querySelector\(item\.target\);\s*\n\s*if \(target\) target\.click\(\);/);
  ['#add-band-btn', '#share-graph-btn', '#send-feedback-btn'].forEach(selector => {
    assert.ok(EXPLORER.includes(selector), `${selector} should be driven by a pill`);
  });
});

test('Reset returns to the opening view, not just the opening camera', () => {
  const goHome = EXPLORER.slice(EXPLORER.indexOf('function goHome()'), EXPLORER.indexOf('function showTip'));
  // Budgets have to be reset too: after two expands, recentring the camera alone
  // would leave 220 nodes on screen.
  assert.match(goHome, /state\.maxHops = NEIGHBORHOOD_BUDGET\.MAX_HOPS/);
  assert.match(goHome, /maxNodes: NEIGHBORHOOD_BUDGET\.OPENING_MAX_NODES/);
  assert.match(goHome, /clearHighlight\(\)/);
});

test('the star label keeps one size and one gap at every zoom', () => {
  // The star scales with the camera so it keeps marking its node. Its label used
  // to live inside that transform, so in a zoomed-in view -- which is what a
  // phone gets -- the text grew with it AND drifted away from the star, since
  // its offset scaled too. The label is now a sibling, placed in screen space.
  assert.match(EXPLORER, /<span class="sigma-star-label sigma-home-label" hidden><\/span>/);
  const place = EXPLORER.slice(EXPLORER.indexOf('const placeLabel ='), EXPLORER.indexOf('const zoomScale ='));
  // Measured from the overlay's drawn edge, so the gap is constant on screen.
  assert.match(place, /const GAP = \d+;/);
  assert.match(place, /const radius = \(overlayEl\.offsetHeight \* scale\) \/ 2;/);
  assert.match(place, /point\.y \+ radius \+ GAP/);
  // And no scale on the label itself.
  assert.doesNotMatch(place, /scale\(/);
});


test('clicking a node travels to it, keeping it lit on arrival', () => {
  // The point of the whole explorer: Mike McCready is 6 degrees from Aaron and
  // Pearl Jam is 7, so reaching Pearl Jam by expanding would pull in hundreds of
  // nodes to show one band. Travelling to Mike puts it one hop away.
  assert.match(EXPLORER, /renderer\.on\('clickNode', \(\{ node \}\) => travelTo\(node\)\)/);
  const travel = EXPLORER.slice(EXPLORER.indexOf('function travelTo(node)'), EXPLORER.indexOf("renderer.on('clickNode'"));
  // Clicking the current centre must not re-render the same view.
  assert.match(travel, /if \(node === state\.anchorId\)/);
  // Budgets open up for a requested anchor, as with a search.
  assert.match(travel, /state\.anchorSource = 'requested'/);
  assert.match(travel, /maxNodes: NEIGHBORHOOD_BUDGET\.MAX_NODES/);
  // renderNeighborhood clears the highlight while drawing, so it is re-applied
  // afterwards -- otherwise you arrive somewhere with nothing lit.
  assert.match(travel, /if \(moved\) highlightFrom\(node\)/);
  assert.match(travel, /rbft:sigma-travel/);
});

test('pill copy does not name the default anchor', () => {
  // Every visitor reads this copy. Naming one person in it makes a shared tool
  // read as somebody's personal page, and it goes stale if the default changes.
  const actions = EXPLORER.slice(
    EXPLORER.indexOf('const STAGE_ACTIONS = ['),
    EXPLORER.indexOf('// Upper bound on datalist options'),
  );
  const details = [...actions.matchAll(/detail:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(details.length >= 5, `expected every pill to have copy, found ${details.length}`);
  details.forEach(detail => {
    assert.doesNotMatch(detail, /Aaron|McRae/i, `pill copy names the anchor: "${detail}"`);
  });
});
