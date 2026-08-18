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
import { RENDERERS, DEFAULT_RENDERER } from '../scripts/neighborhood-helpers.mjs';

// Assertions about what the page LOADS must not be satisfiable by deleting the
// comments that explain why -- and the comments explaining which hosts are gone
// necessarily name those hosts.
//
// Strips HTML comments and JS line comments. The (?<!:) guard is the whole trick:
// without it, `//` in `https://d3js.org` would itself look like the start of a
// comment, so a REAL script tag would be stripped too and the assertion below could
// never fail. Verified by reinstating the tag.
const stripComments = html =>
  String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(?<!:)\/\/[^\n]*/g, '');
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
  assert.match(INDEX_HTML, /<svg id="graph-svg"/);
  // d3 used to be a render-blocking <script> from d3js.org here. It is now vendored
  // and fetched on demand, so what has to exist is the loader, not the tag.
  assert.match(INDEX_HTML, /function ensureD3\(\)/);
  assert.doesNotMatch(stripComments(INDEX_HTML), /<script src="https:\/\/d3js\.org/);
});

test('the module self-boots unless the SVG renderer was asked for', () => {
  assert.match(EXPLORER, /rendererFromSearch\(win\.location\.search\) !== 'sigma'\) return;/);
  assert.match(HELPERS, /export const DEFAULT_RENDERER = 'sigma';/);
});

test('the node card is bound to Sigma selection before the flip', () => {
  // Without this the constellation cannot be the default: the card is where a
  // band's city, years, line-up, albums and verification live, and it carries
  // the edit pencil, so a visitor could look but neither read nor contribute.
  assert.match(INDEX_HTML, /window\.addEventListener\('rbft:sigma-select'/);
  assert.match(INDEX_HTML, /selectBandNode\(detail\.id, \{ source: 'sigma' \}\)/);
  assert.match(INDEX_HTML, /selectMemberNode\(detail\.id, \{ source: 'sigma' \}\)/);
  // Travelling invalidates the open card: the view it described is gone.
  assert.match(INDEX_HTML, /window\.addEventListener\('rbft:sigma-travel', \(\) => closeNodeCard\(\)\)/);
  // Bound once, when the graph first becomes available.
  assert.match(INDEX_HTML, /if \(!sigmaSelectionBound\) \{/);
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
    ['expand', 'reset', 'filter', 'add', 'share', 'feedback'],
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
  assert.match(EXPLORER, /if \(event\.key !== 'Escape'\) return;/);
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
  // The footer line is deliberately terse now: the "No Rawk Found" panel carries
  // the offer to add the band, and two copies of that sentence on one screen
  // read as a fault. The invitation itself is asserted in the empty-state test.
  assert.match(EXPLORER, /No match for/);
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
  // The map now points at this origin, so the version it resolves to is recorded in
  // the vendored file's banner rather than in a URL. Same requirement -- the shipped
  // version must be reviewable and must agree with package.json -- different place.
  const sigmaBundle = readFileSync(new URL('../vendor/sigma.mjs', import.meta.url), 'utf8').slice(0, 400);
  const graphologyBundle = readFileSync(new URL('../vendor/graphology.mjs', import.meta.url), 'utf8').slice(0, 400);
  assert.ok(
    sigmaBundle.includes(`sigma@${version(sigma)}`),
    `vendor/sigma.mjs must record sigma@${version(sigma)} to match package.json`
  );
  assert.ok(
    graphologyBundle.includes(`graphology@${version(graphology)}`),
    `vendor/graphology.mjs must record graphology@${version(graphology)} to match package.json`
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
  // The resize handler also repositions the filter panel now, so it is a block
  // rather than a one-liner.
  assert.match(EXPLORER, /renderer\.on\('resize', \(\) => \{\s*\n\s*applySizeScale\(\);/);
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
  // Compared through fitRatio() now: the same value has to drive both the framing
  // call and the "did it fit?" test, or the branch mis-detects.
  assert.match(EXPLORER, /ratio >= fitRatio\(\) - 1e-6/);
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
  assert.match(EXPLORER, /bandNames = master\.nodes\.filter\(node => node\.type === 'band'\)/);
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

test('Reset returns to the view the visitor arrived on', () => {
  // Most people arrive on a link shared by another user, so "start over" means
  // the band in THAT link. Sending them to the project's default anchor would
  // drop them somewhere they have never been.
  assert.match(EXPLORER, /state\.openingAnchorId = resolved\.anchorId;/);
  const goHome = EXPLORER.slice(EXPLORER.indexOf('function goHome()'), EXPLORER.indexOf('function showTip'));
  assert.match(goHome, /state\.openingAnchorId \|\| homeStarId \|\| NEIGHBORHOOD_BUDGET\.DEFAULT_ANCHOR/);
});

test('the address bar follows the current view', () => {
  // Share reads the query string, so the URL has to describe what is on screen;
  // it also makes reload and copy-from-the-bar work.
  const sync = EXPLORER.slice(EXPLORER.indexOf('function syncAddressBar()'), EXPLORER.indexOf('// -- camera'));
  assert.match(sync, /url\.searchParams\.set\('anchor', state\.anchorId\)/);
  // replaceState, not pushState: travelling is not navigation, and a hundred
  // history entries would bury whatever page the visitor came from.
  assert.match(sync, /win\.history\.replaceState/);
  assert.doesNotMatch(sync, /pushState/);
  // The inbound spellings are cleared so a stale one cannot contradict the view.
  assert.match(sync, /\['band', 'member', 'node', 'person'\]\.forEach\(key => url\.searchParams\.delete\(key\)\)/);
  // Called from the same place the rest of the chrome is updated.
  assert.match(EXPLORER, /syncAddressBar\(\);/);
});

test('a shared link carries the view, not just the site', () => {
  // Sharing is the main way people arrive. This used to be
  // origin + pathname, which threw the query string away: whatever you were
  // centred on, the person you sent it to landed on the default anchor.
  assert.match(INDEX_HTML, /function shareableUrl\(\)/);
  assert.match(INDEX_HTML, /const SHAREABLE_PARAMS = \['anchor', 'band', 'member', 'node', 'person'\]/);
  // `renderer` is deliberately absent. ?renderer=svg still works on the way IN,
  // but copying it into a shared link would spread the slow escape-hatch renderer
  // to everyone who opened that link, without the sharer ever knowing.
  const params = INDEX_HTML.match(/const SHAREABLE_PARAMS = \[[^\]]*\]/)[0];
  assert.ok(!params.includes('renderer'), 'renderer must not be copied into shared links');
  // And the filename must not ride along. Both / and /index.html serve this page,
  // so whichever the sharer happened to be on used to end up in the link.
  assert.match(INDEX_HTML, /replace\(\/\(\^\|\\\/\)index\\\.html\$\/, '\$1'\)/);
  // Every share path must go through it.
  const shareSites = INDEX_HTML.match(/const siteUrl = [^;]+;/g) || [];
  assert.ok(shareSites.length >= 4, `expected several share call sites, found ${shareSites.length}`);
  shareSites.forEach(line => assert.match(line, /shareableUrl\(\)/));
  // And it must not carry arbitrary query parameters onward.
  const helper = INDEX_HTML.slice(INDEX_HTML.indexOf('function shareableUrl()'), INDEX_HTML.indexOf('function publishMasterGraph'));
  assert.match(helper, /SHAREABLE_PARAMS\.forEach/);
});

test('label placement is measured, collision-free and stable', () => {
  // Two label collisions reached production -- a band name printed across the
  // gold you-are-here label, and another across the footer -- because every
  // check measured node geometry and none measured text.
  const block = EXPLORER.slice(
    EXPLORER.indexOf('function updateLabelBlocking()'),
    EXPLORER.indexOf('function updateParallax()'),
  );
  // Boxes are reconstructed the way Sigma draws a label.
  assert.match(block, /point\.x \+ display\.size \+ 3/);
  assert.match(block, /labelMetrics\.measureText\(attrs\.label\)\.width/);
  // Chrome zones: the wordmark/field/pills block, the footer, and the gold label.
  assert.match(block, /addZone\(heroEl\)/);
  assert.match(block, /addZone\(footerEl\)/);
  assert.match(block, /addZone\(homeLabelEl\)/);
  // Bigger nodes win a collision, with a deterministic tie-break so a view does
  // not flicker between two equally good answers.
  assert.match(block, /candidates\.sort\(\(a, b\) => b\.size - a\.size \|\| \(a\.id < b\.id \? -1 : 1\)\)/);
  // A selected node always keeps its name: it is the thing being read.
  assert.match(block, /const selected = state\.selection && state\.selection\.id === candidate\.id/);
  // Measured over EVERY labelled node, not the ones Sigma currently displays --
  // suppressing a label removes it from that set, so reading it would make the
  // answer depend on the previous frame and oscillate.
  assert.match(block, /viewGraph\.forEachNode\(\(id, attrs\) => \{/);
  assert.doesNotMatch(block, /getNodeDisplayedLabels/);
  // Refresh only when the set changed, or every frame would re-render.
  assert.match(block, /if \(!changed\) return;/);
  assert.match(block, /renderer\.refresh\(\{ skipIndexation: true \}\)/);
  // And the reducer is what applies it.
  assert.match(EXPLORER, /if \(state\.labelBlocked\.has\(id\)\) res\.label = '';/);
});

test('the chrome band is measured, and used for centring only', () => {
  const area = EXPLORER.slice(EXPLORER.indexOf('function chromeInsets()'), EXPLORER.indexOf('function cameraOffsetY('));
  assert.match(area, /hero\.bottom - host\.top/);
  assert.match(area, /host\.bottom - footer\.top/);
  // A very short window must still leave a usable band rather than nothing.
  assert.match(area, /Math\.max\(host\.height \* 0\.45/);
  // Framing and sizing deliberately use the FULL canvas. Measured: handing them
  // the band instead reads as "fitting would not be legible", so the camera zooms
  // into a region -- the opening view went from 17 nodes on screen to 8. Nodes
  // visible beats names hidden.
  const framed = EXPLORER.slice(EXPLORER.indexOf('function framedRatio()'), EXPLORER.indexOf('function applySizeScale('));
  assert.match(framed, /const rect = canvasHost\.getBoundingClientRect\(\);/);
  assert.doesNotMatch(framed, /safeArea\(\)/);
});

test('the camera centres the drawing in that band, at the right zoom', () => {
  const offset = EXPLORER.slice(EXPLORER.indexOf('function cameraOffsetY('), EXPLORER.indexOf('function fitRatio()'));
  assert.match(offset, /viewportToFramedGraph/);
  // The shift is applied in the same setState as a new ratio, so it has to be
  // expressed at the TARGET zoom -- computing it at the current one overshot by
  // half again as much on a short window.
  assert.match(offset, /perPixel \*= targetRatio \/ current/);
  assert.match(EXPLORER, /y: 0\.5 \+ cameraOffsetY\(ratio\)/);
  assert.match(EXPLORER, /y: display\.y \+ cameraOffsetY\(nextRatio\)/);
});

test('the fit ratio is deliberately not loosened to clear the chrome', () => {
  // Measured, not assumed: loosening the fit so the whole drawing clears the
  // chrome pulls nodes closer together, and labels then collide with each other
  // instead. On 1440x900 that traded 2 hidden names for 5.
  const fit = EXPLORER.slice(EXPLORER.indexOf('function fitRatio()'), EXPLORER.indexOf('function framedRatio()'));
  assert.match(fit, /return FRAMED_RATIO;/);
});

test('chrome zones are measured in the renderer\'s coordinate space', () => {
  // This one shipped a false-clean gate. graphToViewport reports positions in the
  // RENDERER'S container, and the stage wrapper sits ~280px down the page inside
  // .graph-stage, so converting the chrome rects against the stage shifted every
  // zone by that much -- one zone ended up with a negative top. Labels printed
  // across the footer on screen while both the renderer and the audit called it
  // clean.
  const block = EXPLORER.slice(
    EXPLORER.indexOf('function updateLabelBlocking()'),
    EXPLORER.indexOf('function updateParallax()'),
  );
  assert.match(block, /const originBox = canvasHost\.getBoundingClientRect\(\);/);
  assert.doesNotMatch(block, /stage\.getBoundingClientRect\(\)/);
});

test('blocking is recomputed when the chrome moves, not only per frame', () => {
  // The footer grows a line when the context text wraps, which moves the zone
  // under labels that were already placed. Sigma does not draw a frame for a DOM
  // reflow, so waiting for afterRender left a label across the footer.
  assert.match(EXPLORER, /new ResizeObserver\(\(\) => updateLabelBlocking\(\)\)/);
  // The node card joined this list: it is chrome too while it is docked open.
  assert.match(EXPLORER, /\[heroEl, footerEl, homeLabelEl, nodeCardEl\]\.forEach\(el => \{ if \(el\) chromeObserver\.observe\(el\); \}\)/);
  assert.match(EXPLORER, /if \(chromeObserver\) chromeObserver\.disconnect\(\)/);
  // And once more right after the chrome's own text is written.
  const chrome = EXPLORER.slice(EXPLORER.indexOf('function updateChrome()'), EXPLORER.indexOf('// -- camera'));
  assert.match(chrome, /updateLabelBlocking\(\);/);
});

test('filters narrow the constellation through one implementation', () => {
  // Scene / Genre / Recently-added / search live in index.html and produce a
  // filtered {nodes, links}. The explorer explores THAT, so there is one
  // filtering implementation feeding two renderers.
  assert.match(INDEX_HTML, /window\.RBFT_SIGMA\.setGraph\(filtered\)/);
  const setGraph = EXPLORER.slice(EXPLORER.indexOf('function setGraph(next)'), EXPLORER.indexOf('// -- first paint'));
  // An empty result is a real outcome of a narrow filter, not a crash.
  assert.match(setGraph, /No bands match these filters\./);
  // buildAdjacency stores a Set per node: reading .length gave undefined, every
  // comparison was false, no anchor was ever chosen, and filtering silently did
  // nothing at all.
  assert.match(setGraph, /neighbours \? neighbours\.size : 0/);
  // A filter should narrow what you are looking at, not move you.
  assert.match(setGraph, /masterById\.has\(state\.anchorId\) \? state\.anchorId : null/);
  // And clearing it should put you back rather than leaving you somewhere you
  // never chose.
  assert.match(setGraph, /state\.displacedAnchorId/);
});

test('the filter panel reuses the page\'s own controls', () => {
  // The scene and genre <select> elements are MOVED into the panel, keeping their
  // existing change handlers; Recently-added and Clear press the page's chips.
  assert.match(EXPLORER, /const RELOCATED_FILTERS = \[/);
  assert.match(EXPLORER, /selector: '#scene-filter'/);
  assert.match(EXPLORER, /selector: '#genre-filter'/);
  assert.match(EXPLORER, /'\.tool-chip\[data-action="recent"\]'/);
  assert.match(EXPLORER, /'\.tool-chip\[data-action="clear"\]'/);
  // Filter state is read from the page, never mirrored: the same filters can be
  // changed by Reset view or a country chip.
  assert.match(EXPLORER, /function syncFilterState\(\)/);
  // Same click-propagation trap as the pills.
  const panel = EXPLORER.slice(EXPLORER.indexOf("filterPanel.addEventListener('click'"), EXPLORER.indexOf('function runAction'));
  assert.match(panel, /event\.stopPropagation\(\)/);
});

test('one click both travels and leaves the card open', () => {
  // The card needed a SECOND click to appear, and the cause was event ORDER.
  // The page closes any open card on rbft:sigma-travel, because the view that
  // card described is gone. highlightFrom() dispatches rbft:sigma-select, which
  // opens the card for the clicked node. Travel was announced AFTER the
  // highlight, so it closed the card that had just been opened -- and only a
  // second click, which is not travel and therefore only re-highlights, made it
  // stick. Stale card closes first, new card opens second.
  const travel = EXPLORER.slice(EXPLORER.indexOf('function travelTo(node)'), EXPLORER.indexOf("renderer.on('clickNode'"));
  const dispatchAt = travel.indexOf("'rbft:sigma-travel'");
  const highlightAt = travel.indexOf('if (moved) highlightFrom(node)');
  assert.ok(dispatchAt > 0 && highlightAt > 0, 'travelTo should both announce travel and re-highlight');
  assert.ok(dispatchAt < highlightAt, 'travel must be announced BEFORE the highlight reopens the card');
});

test('the docked node card counts as chrome while it is open', () => {
  // It sits over the constellation, so a label underneath it would look culled
  // for no reason -- the same fault as the hero and the footer, with a box that
  // comes and goes.
  const block = EXPLORER.slice(EXPLORER.indexOf('function updateLabelBlocking()'), EXPLORER.indexOf('function updateParallax()'));
  assert.match(block, /nodeCardEl && !nodeCardEl\.hidden && nodeCardEl\.classList\.contains\('is-open'\)/);
  assert.match(block, /addZone\(nodeCardEl\)/);
  // Closing it is a class change, not a resize, so the size observer can miss it.
  assert.match(EXPLORER, /cardStateObserver/);
  assert.match(EXPLORER, /attributeFilter: \['class', 'hidden', 'style'\]/);
  assert.match(EXPLORER, /if \(cardStateObserver\) cardStateObserver\.disconnect\(\)/);
});

test('the card docks to a corner on the constellation', () => {
  // Clicking a node now flies the camera AND opens the card, so a node-anchored
  // card would ride along with the flight and land under the hero or footer.
  assert.match(EXPLORER, /body\.\$\{BODY_ACTIVE_CLASS\} \.node-card\{position:fixed/);
  // The mobile bottom sheet still wins below 700px, where a corner card would
  // cover the graph it describes.
  assert.match(EXPLORER, /@media \(min-width:701px\)\{[\s\S]*?body\.\$\{BODY_ACTIVE_CLASS\} \.node-card\{/);
  // CSS owns the position, so the page's node-following geometry must stand down.
  assert.match(INDEX_HTML, /if \(document\.body && document\.body\.classList\.contains\('rbft-sigma-chrome'\)\) \{[\s\S]*?nodeCardEl\.style\.left = '';/);
});

test('relocated panels are restored to wherever they now live', () => {
  // hookPopoverForMobile captured its parent at startup and a MutationObserver
  // kept restoring it. The Sigma chrome MOVES these panels into its stage and
  // hides the toolbar they came from, so "restoring" posted Add and Feedback
  // back inside a display:none ancestor: both pills opened a panel that measured
  // 0x0 and never appeared. Share was never hooked here, which is exactly why
  // Share was the only one of the three that worked.
  assert.match(INDEX_HTML, /function currentHome\(\)/);
  assert.match(INDEX_HTML, /if \(stage && document\.body\.classList\.contains\('rbft-sigma-chrome'\)\) return stage;/);
  assert.match(INDEX_HTML, /const home = currentHome\(\);/);
});

test('cards and popovers are radiused rectangles, not chamfered ones', () => {
  // They were border-radius:0 plus a clip-path polygon cutting each corner at 45
  // degrees. The shape read as a cut-off rectangle, and the diagonal sliced
  // through the padding so text near a corner sat closer to the visible edge
  // than the box model claimed.
  const css = INDEX_HTML.slice(0, INDEX_HTML.indexOf('</style>'));
  assert.doesNotMatch(css, /clip-path:\s*polygon/, 'no chamfered corners should remain');
  assert.match(INDEX_HTML, /--radius-card: 12px;/);
  assert.match(INDEX_HTML, /--radius-control: 8px;/);
});

test('the shared glass popover style carries its own padding', () => {
  // .share-popover -- used by Share, Add your band and Feedback -- set colour,
  // border and shadow but no padding at all, so every line sat one pixel off the
  // border. Padding belongs on the shared style, not on each of the three
  // panels; that is how it went missing in the first place.
  const share = INDEX_HTML.slice(INDEX_HTML.indexOf('.share-popover {'));
  const firstRule = share.slice(0, share.indexOf('}'));
  assert.match(firstRule, /padding: 1\.1rem 1\.15rem 1\.15rem;/);
});

test('the focus ring marks a clicked node, not the centre of the view', () => {
  // Anchored to state.anchorId the ring appeared without anyone asking: on a
  // shared link (the way most visitors arrive), after a search, and after a
  // filter displaced the anchor. That put two ringed, glowing objects on screen
  // in the same visual language -- Aaron's Saturn star and the focus ring --
  // both saying "look here", neither of them clicked. On load Aaron should be
  // the only node wearing rings.
  const overlays = EXPLORER.slice(EXPLORER.indexOf('const zoomScale ='), EXPLORER.indexOf('function updateLabelBlocking'));
  assert.match(overlays, /const clickedId = state\.selection \? state\.selection\.id : null;/);
  assert.match(overlays, /clickedId && clickedId !== homeStarId \? clickedId : null/);
  // The old behaviour, explicitly gone.
  assert.doesNotMatch(overlays, /state\.anchorId === homeStarId \? null : state\.anchorId/);
});

test('every non-click path clears the selection the ring depends on', () => {
  // state.selection is the right signal only because it is set ONLY by a click
  // and cleared by clearHighlight -- which each of these already calls. If any
  // of them stopped, a ring would appear on a node nobody chose.
  assert.match(EXPLORER, /function clearHighlight\(\) \{\s*state\.selection = null;/);
  // First paint, search and filters all go through renderNeighborhood.
  const render = EXPLORER.slice(EXPLORER.indexOf('state.layoutExtent = layoutExtent(positions)'));
  assert.match(render.slice(0, 400), /clearHighlight\(\);/);
  // Reset.
  const home = EXPLORER.slice(EXPLORER.indexOf('function goHome()'), EXPLORER.indexOf('function goHome()') + 300);
  assert.match(home, /clearHighlight\(\);/);
  // A click on empty space.
  assert.match(EXPLORER, /renderer\.on\('clickStage', \(\) => clearHighlight\(\)\)/);
  // And a click on a node is what sets it.
  const highlight = EXPLORER.slice(EXPLORER.indexOf('function highlightFrom(id)'), EXPLORER.indexOf('function exploreFor'));
  assert.match(highlight, /state\.selection = \{ id, type: entityType \}/);
});

test('the old chrome is stood down before first paint, not on mount', () => {
  // The Sigma chrome used to be applied when its module mounted -- after the
  // band data was fetched AND the SVG graph drawn, about nine seconds. For those
  // nine seconds a visitor got the whole old interface: toolbar, stats badge,
  // version pill, sign-up nudge and a full 3,194-node SVG render, then all of it
  // replaced. A synchronous inline script now marks the document first.
  assert.match(INDEX_HTML, /document\.body\.classList\.add\('rbft-sigma-boot'\)/);
  // Inline and synchronous is the whole point: a module or a DOMContentLoaded
  // handler runs after the browser has already painted the old interface.
  const bodyStart = INDEX_HTML.indexOf('<body>');
  const bootScript = INDEX_HTML.indexOf("classList.add('rbft-sigma-boot')");
  const firstModule = INDEX_HTML.indexOf('<script type="module"', bodyStart);
  assert.ok(bootScript > bodyStart, 'the boot script belongs inside <body>');
  assert.ok(firstModule === -1 || bootScript < firstModule, 'it must run before any module');
  // The rules cannot live in the module's injected stylesheet, which does not
  // exist yet at that moment.
  const css = INDEX_HTML.slice(0, INDEX_HTML.indexOf('</style>'));
  assert.match(css, /body\.rbft-sigma-boot \.graph-overlay-top,/);
  assert.match(css, /body\.rbft-sigma-boot \.graph-stage > svg \{/);
});

test('the boot script mirrors rendererFromSearch', () => {
  // If these drift, ?renderer=svg would get the new chrome bolted over the old
  // interface, or every visitor would get a flash of the thing we just hid.
  const script = INDEX_HTML.slice(
    INDEX_HTML.indexOf("new URLSearchParams(window.location.search).get('renderer')"),
    INDEX_HTML.indexOf("classList.add('rbft-sigma-boot')")
  );
  assert.match(script, /requested === 'svg' \|\| requested === 'sigma'/);
  assert.match(script, /: 'sigma'/);          // unknown values fall back, as the module does
  assert.deepEqual(RENDERERS, ['svg', 'sigma'], 'a new renderer needs adding to the boot script too');
  assert.equal(DEFAULT_RENDERER, 'sigma');
});

test('a placeholder holds the new look until the real chrome mounts', () => {
  // Hiding the old chrome without this would leave an empty page for the whole
  // data load. Same wordmark, same field geometry, so the page a visitor lands
  // on IS the new look and the constellation fills in behind it.
  assert.match(INDEX_HTML, /class="rbft-boot-shell"/);
  assert.match(INDEX_HTML, /rbft-boot-shell__wordmark/);
  assert.match(INDEX_HTML, /Who&rsquo;s your favorite band\?/);
  // And it must get out of the way the moment the real chrome is up.
  assert.match(INDEX_HTML, /body\.rbft-sigma-chrome \.rbft-boot-shell \{ display: none !important; \}/);
});

test('the address bar names the view you arrived on, not the last node clicked', () => {
  // Travelling used to rewrite ?anchor= on every move, so a refresh reopened the
  // last node clicked and there was no way back to the start short of Reset --
  // and the opening view was no longer Aaron's.
  assert.match(EXPLORER, /\/\/ NOT syncAddressBar\(\)/);
  const chrome = EXPLORER.slice(EXPLORER.indexOf('function updateChrome()'), EXPLORER.indexOf('// -- camera'));
  assert.doesNotMatch(chrome, /^\s*syncAddressBar\(\);/m);
  // Written exactly once, after the opening view, to canonicalise the inbound
  // link (?band= / ?member= / ?node= / ?person= all collapse to ?anchor=).
  const firstPaint = EXPLORER.slice(EXPLORER.indexOf('// -- first paint'));
  assert.match(firstPaint, /syncAddressBar\(\);/);
  assert.equal((EXPLORER.match(/^\s*syncAddressBar\(\);/gm) || []).length, 1, 'exactly one call site');
});

test('Share reads the live view, since the URL no longer follows travel', () => {
  // Otherwise Share would send whatever view the visit STARTED from -- for most
  // visitors, Aaron rather than the band they are looking at.
  const share = INDEX_HTML.slice(INDEX_HTML.indexOf('function shareableUrl()'), INDEX_HTML.indexOf('let sigmaSelectionBound'));
  assert.match(share, /window\.RBFT_SIGMA\.state\.anchorId/);
  assert.match(share, /kept\.set\('anchor', live\)/);
  // A stale ?band= alongside a fresh ?anchor= would contradict it.
  assert.match(share, /\['band', 'member', 'node', 'person'\]\.forEach\(key => kept\.delete\(key\)\)/);
});

test('the filter panel is placed under its pill, not off the bottom of the stage', () => {
  // It was left:50%; top:calc(100% + 10px), which reads like "hang below my
  // trigger" -- but the panel is a child of the STAGE, not of the pill row. So
  // 100% meant the full height of a 100dvh stage and the panel opened just below
  // the bottom of the window: measured at top:910 in a 900px viewport. It was
  // doing everything else correctly, entirely off screen, which is why driving
  // the selects directly in a test found nothing wrong.
  assert.match(EXPLORER, /function positionFilters\(\)/);
  const css = EXPLORER.slice(EXPLORER.indexOf('.sigma-filters{'), EXPLORER.indexOf('.sigma-filters[hidden]'));
  assert.doesNotMatch(css, /top:calc\(100% \+ 10px\)/);
  assert.doesNotMatch(css, /left:50%/);
  // Placed from the pill's own rect, and clamped inside the stage.
  const fn = EXPLORER.slice(EXPLORER.indexOf('function positionFilters()'), EXPLORER.indexOf('function hideTip()'));
  assert.match(fn, /actionButtons\.get\('filter'\)/);
  assert.match(fn, /box\.bottom - stageBox\.top \+ 10/);
  assert.match(fn, /Math\.max\(margin, Math\.min\(left, stageBox\.width - width - margin\)\)/);
  // Opening it places it; a resize rewraps the pill row and moves the trigger.
  const toggle = EXPLORER.slice(EXPLORER.indexOf('function toggleFilters'), EXPLORER.indexOf('Reflects the page'));
  assert.match(toggle, /positionFilters\(\);/);
  assert.match(EXPLORER, /applySizeScale\(\);\s*\n\s*\/\/ The pill row rewraps[\s\S]*?positionFilters\(\);/);
});

test('an unmapped band still offers to add it', () => {
  // The "No Rawk Found" panel and its CTA already existed, driven by
  // syncSearchEmptyState() off the SVG renderer's search field. The
  // constellation's search box goes through exploreFor() instead, which reported
  // a miss only as a line of footer text -- so the offer looked deleted. Nothing
  // listened for the event the module was already firing.
  assert.match(INDEX_HTML, /window\.addEventListener\('rbft:sigma-search-miss', event => \{/);
  assert.match(INDEX_HTML, /graphEmptyState\.hidden = false;/);
  // The CTA pre-fills the Add-band form from currentSearch, which the
  // constellation's search box never sets.
  assert.match(INDEX_HTML, /currentSearch = query;/);
  // And a drawn view retires the message -- one event rather than a list that
  // has to keep up with every way the view can change.
  assert.match(EXPLORER, /'rbft:sigma-view'/);
  assert.match(INDEX_HTML, /window\.addEventListener\('rbft:sigma-view', \(\) => \{/);
  // The footer line stays terse so the screen does not say it twice.
  assert.match(EXPLORER, /No match for <strong>\$\{escapeHtml\(rawQuery\)\}<\/strong> in the tree yet\./);
});

test('the share image is captured from the constellation, not the hidden SVG', () => {
  // "Could not generate the image. Try again in a moment." The export serialised
  // #graph-svg, and hiding that SVG when the constellation became the default
  // left a display:none element measuring 0x0 -- so the export canvas came out
  // zero-sized and every share failed. Capturing Sigma is also the right picture
  // rather than merely a working one: it is what the visitor is looking at.
  assert.match(INDEX_HTML, /function captureSigmaCanvas\(\)/);
  const capture = INDEX_HTML.slice(
    INDEX_HTML.indexOf('function captureSigmaCanvas()'),
    INDEX_HTML.indexOf('async function renderGraphPngBlob()')
  );
  // WebGL discards its drawing buffer after compositing, so read it in the same
  // turn as a fresh paint.
  assert.match(capture, /renderer\.refresh\(\);/);
  assert.match(capture, /renderer\.getCanvases\(\)/);
  // Edges under nodes under labels; interaction layers excluded, because they
  // carry a hover plate for wherever the pointer happened to be resting.
  // Assert the DRAW LIST specifically -- the prose above it names the excluded
  // layers, so scanning the whole function would match its own comment.
  const drawList = capture.match(/\[(('|")[a-zA-Z]+\2,?\s*)+\]\.forEach/);
  assert.ok(drawList, 'the capture should draw an explicit list of layers');
  assert.equal(drawList[0], "['edges', 'edgeLabels', 'nodes', 'labels'].forEach");
  // The starfield is CSS, so the field colour has to be painted in or the graph
  // lands on transparency.
  assert.match(capture, /target\.fillStyle = '#070b12'/);
  // ?renderer=svg keeps the old path.
  assert.match(capture, /if \(!renderer \|\| typeof renderer\.getCanvases !== 'function'\) return null;/);
});

test('the export sizes itself from the stage that is on screen', () => {
  const png = INDEX_HTML.slice(INDEX_HTML.indexOf('async function renderGraphPngBlob()'));
  assert.match(png, /sigmaCanvas && sigmaStage\s*\n\s*\? sigmaStage\.getBoundingClientRect\(\)/);
  // A zero-sized rect is what produced the failure; refuse it outright.
  assert.match(png, /if \(!rect\.width \|\| !rect\.height\) return null;/);
  // Serialising the SVG clones three thousand nodes, so skip it entirely when
  // the constellation is the picture.
  assert.match(png, /const drawGraph = async \(\) => \{[\s\S]*?if \(sigmaCanvas\) \{/);
});

test('the shared picture includes the star, ring and gold label', () => {
  // They are DOM overlays layered over the canvas, so a canvas capture misses
  // them: the first working export had Aaron as an unmarked white dot. On a
  // picture whose job is to advertise a shared link, the ringed star and the
  // name are the subject.
  const overlays = INDEX_HTML.slice(INDEX_HTML.indexOf('const drawOverlays = () =>'), INDEX_HTML.indexOf('try {\n        await drawGraph();'));
  assert.match(overlays, /\.sigma-home-star/);
  assert.match(overlays, /\.sigma-focus-ring/);
  assert.match(overlays, /\.sigma-home-label/);
  assert.match(overlays, /#ffc978/);           // the same gold as on screen
  assert.match(overlays, /ctx\.ellipse\(/);    // the tilted ring
  // Geometry is read from the live elements so it cannot drift from where they
  // actually are.
  assert.match(overlays, /getBoundingClientRect\(\)/);
  assert.match(INDEX_HTML, /await drawGraph\(\);\s*\n\s*drawOverlays\(\);/);
});

test('the SVG is not drawn when the constellation is the renderer', () => {
  // It was drawing a force layout over every node and roughly 16,500 SVG
  // elements -- 89% of the elements on the page -- entirely behind display:none.
  // Measured on the full graph, about fifteen seconds AFTER the data had already
  // parsed, to produce a picture nobody sees.
  const render = INDEX_HTML.slice(INDEX_HTML.indexOf('function renderGraph()'));
  const stop = render.indexOf("if (document.body && document.body.classList.contains('rbft-sigma-boot'))");
  assert.ok(stop > 0, 'renderGraph should bail before drawing on the constellation');

  // Order matters: everything the constellation needs has to happen BEFORE the
  // bail. If setGraph moved below it, filters would stop reaching Sigma.
  const handOff = render.indexOf('window.RBFT_SIGMA.setGraph(filtered)');
  assert.ok(handOff > 0 && handOff < stop, 'the filtered graph must reach Sigma before the bail');
  const state = render.indexOf('graphState.rendered = { nodes, links }');
  assert.ok(state > 0 && state < stop, 'the view must be recorded before the bail');
  for (const marker of ['graphBadge.textContent', 'syncFilterBtn(', 'metricNodes.textContent']) {
    const at = render.indexOf(marker);
    assert.ok(at > 0 && at < stop, `${marker} must run before the bail`);
  }
  // And the drawing really is below it.
  const wipe = render.indexOf("graphGroup.selectAll('*').remove()");
  assert.ok(wipe > stop, 'the SVG wipe and draw must sit below the bail');
});

test('the view is read as data, not from the drawn SVG', () => {
  // The node card's member list, the highlight sets and the connection names all
  // read the data BOUND TO THE SVG, so they silently depended on the SVG having
  // been drawn. Not drawing it would have emptied every band card.
  assert.match(INDEX_HTML, /function renderedNodeData\(\) \{\s*\n\s*if \(graphState && graphState\.rendered\) return graphState\.rendered\.nodes;/);
  assert.match(INDEX_HTML, /function renderedLinkData\(\) \{\s*\n\s*if \(graphState && graphState\.rendered\) return graphState\.rendered\.links;/);
  // The DOM fallback stays, so the SVG path cannot regress.
  assert.match(INDEX_HTML, /return graphGroup \? graphGroup\.selectAll\('g\.node'\)\.data\(\) : \[\];/);
  assert.match(INDEX_HTML, /return graphGroup \? graphGroup\.selectAll\('line\.link'\)\.data\(\) : \[\];/);
});

test('?renderer=svg still draws, because it never gets the boot class', () => {
  // The bail is keyed on the class the inline boot script only adds for the
  // constellation, so the escape hatch is untouched: verified at 3,194 nodes and
  // 3,766 links drawn and visible.
  const script = INDEX_HTML.slice(
    INDEX_HTML.indexOf("new URLSearchParams(window.location.search).get('renderer')"),
    INDEX_HTML.indexOf("classList.add('rbft-sigma-boot')")
  );
  assert.match(script, /renderer === 'sigma'/);
});

test('the not-found card can be dismissed', () => {
  // Reported by a tester: it offered adding the band and nothing else, so anyone
  // who had simply mistyped was stuck looking at it.
  assert.match(INDEX_HTML, /id="graph-empty-state-close"/);
  assert.match(INDEX_HTML, /class="popover-close graph-empty-state__close"/);
  assert.match(INDEX_HTML, /aria-label="Close"/);
  const wiring = INDEX_HTML.slice(INDEX_HTML.indexOf("getElementById('graph-empty-state-close')"));
  assert.match(wiring.slice(0, 320), /graphEmptyState\.hidden = true;/);
  // Same stopPropagation trap as every other control inside the stage: without
  // it the document-level outside-click closer swallows the event.
  assert.match(wiring.slice(0, 320), /event\.stopPropagation\(\);/);
});

test('the home star introduces itself instead of just being a stranger', () => {
  // Landing a visitor on one specific musician only works if they are told why --
  // the Tom-from-Myspace trick works because Tom introduced himself. Without it
  // the opening view reads as "here is a person you have never heard of".
  assert.match(EXPLORER, /const introCopy = \(name\) => \{/);
  assert.match(EXPLORER, /I built this site &mdash; you&rsquo;re starting on my node\./);
  assert.match(EXPLORER, /Search for a band or artist above to find your place in the band universe\./);
  // And it names Travel. Search was the only way in that the copy mentioned, which
  // left clicking -- the primary way to move through the graph -- undiscoverable.
  assert.match(EXPLORER, /Click any band or musician to travel there\./);
  // The name is derived from the home star, so changing the default anchor cannot
  // leave the copy claiming to be someone else.
  // Plain substring checks: a regex for this line needs escaping that obscures
  // what is being asserted.
  assert.ok(EXPLORER.includes(".trim().split("), 'the first name should be split out of the id');
  assert.ok(EXPLORER.includes("[0] || 'I'"), 'and it should fall back rather than print undefined');
  assert.match(EXPLORER, /introCopy\(homeStarId\)/);
  // Gold, matching his star label, so the voice and the node are visibly one.
  assert.match(EXPLORER, /\.sigma-intro__hello\{color:#ffc978/);
});

test('the introduction gives way to the generic explainer once you travel', () => {
  // Keyed on the anchor rather than on "first visit", so it also returns with
  // Reset -- the other way to end up back on his node.
  const chrome = EXPLORER.slice(EXPLORER.indexOf('function updateChrome()'), EXPLORER.indexOf('// -- camera'));
  assert.match(chrome, /const onHomeStar = Boolean\(homeStarId\) && homeStarId === state\.anchorId;/);
  assert.match(chrome, /hintEl\.innerHTML = onHomeStar \? introCopy\(homeStarId\) : EXPLORE_COPY;/);
});

test('the introduction reads before the node count', () => {
  // A visitor dropped on a stranger's node needs to know why before being told
  // how many degrees out it is.
  const footer = EXPLORER.slice(EXPLORER.indexOf('<div class="sigma-footer">'), EXPLORER.indexOf('</div>\n  `;'));
  assert.ok(footer.indexOf('sigma-hint') < footer.indexOf('sigma-context'), 'the hint should come first');
});

test('the hamburger is retired on the constellation', () => {
  // It duplicated the pill row -- Add, Share, Feedback, the filters and search
  // all had a second home inside it. Two ways to do the same thing, and the pills
  // are the ones a visitor can see (feedback item xiv).
  const css = INDEX_HTML.slice(0, INDEX_HTML.indexOf('</style>'));
  assert.match(css, /body\.rbft-sigma-boot \.mobile-menu-btn,/);
  assert.match(css, /body\.rbft-sigma-boot #mobile-menu-sheet,/);
  assert.match(css, /body\.rbft-sigma-boot #mobile-sheet-backdrop,/);
  // Sign-up must stop reaching through the retired sheet for its trigger.
  assert.match(INDEX_HTML, /const onConstellation = document\.body && document\.body\.classList\.contains\('rbft-sigma-boot'\);/);
  assert.match(INDEX_HTML, /const isMobile = !onConstellation && window\.matchMedia\('\(max-width: 900px\)'\)\.matches;/);
});

test('the corner the hamburger vacated carries ONE way in', () => {
  // A pair shipped here a change ago, when both entry points still existed. With
  // the flows merged, two controls for one room was the confusion rather than the
  // cure, so there is a single control (feedback item x).
  const right = INDEX_HTML.slice(INDEX_HTML.indexOf('<div class="header-right">'), INDEX_HTML.indexOf('id="header-user"'));
  assert.doesNotMatch(right, /header-signup-btn/);
  assert.match(right, /id="sign-in-btn"/);
  assert.equal((right.match(/class="header-btn/g) || []).length, 1, 'exactly one auth control');
});

test('the auth corner is reachable on a phone, where it is the only way in', () => {
  const css = INDEX_HTML.slice(0, INDEX_HTML.indexOf('</style>'));
  // The base stylesheet hides .header-right below 720px; with the sheet gone that
  // would leave a phone with no way to sign in at all.
  assert.match(css, /body\.rbft-sigma-boot \.header-right \{\s*\n\s*display: flex !important;/);
  // A density pass pins .header-btn to min-height:26px !important, which is why
  // Sign in has always been a 26px target. Survivable as a desktop convenience,
  // not as the only entry on a phone.
  assert.match(css, /body\.rbft-sigma-boot \.header-right \.header-btn \{\s*\n\s*min-height: 36px !important;/);
  assert.match(css, /min-height: 40px !important;/);
  // And the hero drops below that row, or the wordmark prints through it.
  assert.match(css, /body\.rbft-sigma-boot #sigma-stage \.sigma-hero \{ top: 56px; \}/);
});

test('the phone pill row fits on one line with every word intact', () => {
  // The wrap was never a shortage of space: at the old padding the row measured
  // 353px inside 390px and still broke. Tightening brings it to 366px, so nothing
  // has to be renamed, hidden behind a menu, or pushed off a scrolling edge.
  const phone = EXPLORER.slice(EXPLORER.indexOf('@media (max-width:720px)'));
  assert.match(phone, /\.sigma-actions\{gap:5px;flex-wrap:nowrap\}/);
  assert.match(phone, /\.sigma-action\{padding:0 9px;font-size:12px;height:44px\}/);
});

test('the page title carries no version number', () => {
  // "v1" in the title told every visitor they had arrived at a draft, and it
  // disagreed with og:title -- so a shared link and the tab it opened were
  // labelled differently.
  const title = INDEX_HTML.match(/<title>([^<]*)<\/title>/);
  assert.ok(title, 'expected a title tag');
  assert.equal(title[1], 'Rock Band Family Tree');
  // Pinned as a shape too, so v2 cannot arrive the same way v1 did.
  assert.doesNotMatch(title[1], /\bv\d+\b/i, 'no version number in the title');
  // And it must agree with the card a shared link renders.
  const og = INDEX_HTML.match(/<meta property="og:title" content="([^"]*)"/);
  assert.ok(og, 'expected an og:title');
  assert.equal(og[1], title[1], 'the tab and the shared card should say the same thing');
});

// --- no third party on the critical path -------------------------------------
//
// The page used to need d3js.org and esm.sh in order to boot. Blocking d3js.org
// produced a blank page, not a slower one -- and that failure was invisible from a
// machine whose network reaches those hosts, which is every machine we test on.
// These assertions are the only thing standing between that and a quiet relapse.

test('the import map points at this origin, not a CDN', () => {
  const map = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<script type="importmap">'),
    INDEX_HTML.indexOf('</script>', INDEX_HTML.indexOf('<script type="importmap">')),
  );
  assert.ok(map.length > 0, 'expected an import map');
  assert.match(map, /"sigma":\s*"\/vendor\/sigma\.mjs"/);
  assert.match(map, /"graphology":\s*"\/vendor\/graphology\.mjs"/);
  assert.doesNotMatch(map, /esm\.sh/, 'no module may resolve through esm.sh');
  assert.doesNotMatch(map, /https?:\/\//, 'every mapping must be same-origin');
});

test('nothing loads a library from a third party', () => {
  // esm.sh resolved graphology-utils@^2.5.2 -- a caret range -- at request time,
  // so production JavaScript could change with no commit and no deploy.
  //
  // Comments are stripped first: the comments explaining WHY these hosts are gone
  // name the hosts, and an assertion that forbids saying the words would have to be
  // satisfied by deleting the explanation.
  const markup = stripComments(INDEX_HTML);
  assert.doesNotMatch(markup, /d3js\.org/, 'd3 must not come from d3js.org');
  assert.doesNotMatch(markup, /esm\.sh/, 'no library may come from esm.sh');
  assert.doesNotMatch(markup, /unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
});

test('d3 is fetched on demand, not on every load', () => {
  // d3's only jobs are the SVG force simulation and the CSV fallback. Neither runs
  // on the constellation, so blocking every visitor on 278KB was pure waste.
  assert.match(INDEX_HTML, /function ensureD3\(\)/);
  assert.match(INDEX_HTML, /tag\.src = '\/vendor\/d3\.js';/);
  // Cached, so several callers cannot start several downloads.
  assert.match(INDEX_HTML, /if \(window\.d3\) return Promise\.resolve\(window\.d3\);/);
  assert.match(INDEX_HTML, /if \(d3Loading\) return d3Loading;/);
  // A failure must not be cached forever, or one flaky load would disable the SVG
  // renderer for the rest of the session.
  const loader = INDEX_HTML.slice(
    INDEX_HTML.indexOf('function ensureD3()'),
    INDEX_HTML.indexOf('function setupSvgRenderer'),
  );
  assert.ok(loader.length > 0, 'expected to find the loader');
  assert.match(loader, /d3Loading = null;/);
});

test('the SVG renderer is built only when it is the renderer', () => {
  // This block used to run inline at boot, which is precisely why blocking d3
  // blanked a page that draws no SVG at all.
  assert.match(INDEX_HTML, /function setupSvgRenderer\(\)/);
  assert.match(INDEX_HTML, /function onSigmaPath\(\)/);
  assert.match(INDEX_HTML, /const rendererReady = onSigmaPath\(\)\s*\n\s*\? Promise\.resolve\(\)\s*\n\s*: ensureD3\(\)\.then\(setupSvgRenderer\);/);
  // And the data load waits on it, so nothing draws before the renderer exists.
  assert.match(INDEX_HTML, /rendererReady\.then\(loadGraphData\)\.then\(async rows => \{/);
  // The CSV fallback is the constellation's only route to d3, and must await it.
  const fallback = INDEX_HTML.slice(
    INDEX_HTML.indexOf('Falling back to CSV load'),
    INDEX_HTML.indexOf('d3.csv('),
  );
  assert.ok(fallback.length > 0, 'expected to find the CSV fallback');
  assert.match(fallback, /await ensureD3\(\);/);
});

test('the vendored bundles are self-contained and reproducible', () => {
  const sigma = readFileSync(new URL('../vendor/sigma.mjs', import.meta.url), 'utf8');
  const graphology = readFileSync(new URL('../vendor/graphology.mjs', import.meta.url), 'utf8');
  // A surviving bare specifier would resolve through the import map at runtime and
  // could quietly reach a network again.
  for (const [name, src] of [['sigma', sigma], ['graphology', graphology]]) {
    assert.doesNotMatch(src, /esm\.sh|d3js\.org|unpkg/, `${name} must not reference a CDN`);
    assert.match(src, /Rebuild with: npm run vendor/, `${name} should record how it was built`);
  }
  // package-lock.json is gitignored here, so the lockfile cannot be the record of
  // what ships -- the committed vendor/ files are, and they change only in a
  // reviewable diff. The build script and the pinned devDependencies are what make
  // regenerating them repeatable.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.vendor, 'node scripts/vendor-libs.mjs');
  for (const dep of ['sigma', 'graphology', 'd3']) {
    assert.ok(pkg.devDependencies[dep], `${dep} must stay a pinned devDependency`);
  }
});

test('no comment impersonates a live CDN script tag', () => {
  // A comment used to contain the literal string `<script src="https://d3js.org/...">`
  // to explain what had been removed. Harmless to the browser, but it made the
  // served HTML read as though the CDN tag were still there -- it fooled a grep of
  // the live page twice, including mine. Describing the tag beats quoting it.
  assert.ok(
    !INDEX_HTML.includes('<script src="https://d3js.org'),
    'nothing in the file, comment or not, should look like a live d3js.org script tag'
  );
});

// --- fonts come from this origin too ----------------------------------------

test('no font is fetched from a third party', () => {
  const markup = stripComments(INDEX_HTML);
  assert.doesNotMatch(markup, /fontshare\.com/, 'fonts must not come from fontshare.com');
  assert.doesNotMatch(markup, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(markup, /<link rel="stylesheet" href="\/vendor\/fonts\.css">/);
  // The preconnect went with it -- a preconnect to a host we no longer use is a
  // DNS and TLS handshake spent on nothing.
  assert.doesNotMatch(markup, /rel="preconnect"[^>]*fontshare/);
});

test('the vendored sheet declares both families, at the weights the page asks for', () => {
  const css = readFileSync(new URL('../vendor/fonts.css', import.meta.url), 'utf8');
  // Boska is the point of this one. `--font-display: 'Boska', Georgia, serif` had
  // been rendering as GEORGIA, because the Fontshare API returns Satoshi plus four
  // faces of Outfit and no Boska when Satoshi is listed first in the request.
  for (const family of ['Boska', 'Satoshi']) {
    for (const weight of [400, 500, 700]) {
      const face = css.split('@font-face').find(
        b => b.includes(`'${family}'`) && new RegExp(`font-weight: ${weight}\\b`).test(b)
      );
      assert.ok(face, `expected a @font-face for ${family} ${weight}`);
      assert.match(face, /url\('\/vendor\/fonts\/[a-z]+-\d+\.woff2'\)/, `${family} ${weight} must load locally`);
      assert.match(face, /font-display: swap/, `${family} ${weight} should not block first paint`);
    }
  }
  // Outfit was four faces nothing referenced, arriving only because of that quirk.
  assert.doesNotMatch(css, /Outfit/);
});

test('every declared font file is actually present', () => {
  // A @font-face pointing at a missing file fails silently -- the browser just uses
  // the fallback, which is exactly how Boska went unnoticed in the first place.
  const css = readFileSync(new URL('../vendor/fonts.css', import.meta.url), 'utf8');
  const referenced = [...css.matchAll(/url\('(\/vendor\/fonts\/[^']+)'\)/g)].map(m => m[1]);
  assert.equal(referenced.length, 6, 'expected six faces');
  for (const href of referenced) {
    const path = new URL('..' + href, import.meta.url);
    const bytes = readFileSync(path);
    assert.ok(bytes.length > 1000, `${href} looks too small to be a real font (${bytes.length}B)`);
    // woff2 files start with the signature 'wOF2'. Guards against a saved error page.
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${href} is not a woff2`);
  }
});

test('the font build records its licence position', () => {
  // The ITF Free Font License permits self-hosting but prohibits subsetting and
  // format conversion, which is why the build stores the CDN's own .woff2 rather
  // than converting the OTF download. Worth keeping written down next to the code.
  const script = readFileSync(new URL('../scripts/vendor-fonts.mjs', import.meta.url), 'utf8');
  assert.match(script, /itf-ffl/, 'link the licence that permits this');
  assert.match(script, /prohibits subsetting and format conversion|PROHIBITS subsetting/i);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['vendor:fonts'], 'node scripts/vendor-fonts.mjs');
});
