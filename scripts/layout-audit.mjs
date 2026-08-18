// ---------------------------------------------------------------------------
// Rendered-view audit for the Sigma neighborhood explorer.
//
// The companion to tests/layout-invariants.test.mjs. That one checks layout
// geometry in the abstract and runs in CI; this one checks what is actually on
// screen -- real node radii, real label culling, real camera framing -- across
// the matrix that kept producing bug reports:
//
//   datasets  x  viewport sizes  x  view states  x  checks
//
// DATASETS matter, and this is a lesson learned the hard way. A local static
// server has no /api routes, so the page falls back to the bundled CSV -- 3,194
// nodes. Production reads Neon and serves 3,240. Different node counts mean a
// different layout, so an audit run only against the CSV can report every check
// clean while the live site hides labels users can see are missing. That is the
// same shape of blind spot as measuring in the wrong coordinate space: a gate
// that passes because it is not looking at what ships. So the production
// payload is captured as a fixture and REPLAYED into the local page, giving
// production's graph without depending on the network, the password gate, or
// whatever the database happens to hold this minute.
//
// Viewports include a tall/narrow desktop window and a phone, because node
// radii are screen pixels: a view that is comfortable at 1440x900 can collide
// at 1056x1089. View states include the gold/blue highlight, because
// highlighting changes node sizes and label visibility. Checks include:
//
//   - node/node collisions in drawn pixels
//   - node/edge clearance against the straight thread that is drawn
//   - unnamed nodes (labels silently culled by size threshold)
//   - label collisions: text against text, against the overlay labels, and
//     against the chrome
//   - nodes rendered outside the viewport (camera framing too tight)
//   - phantom overlays (an anchor star drawn for a node not in the view)
//   - console errors and failed module loads
//   - click-through: press each pill and measure what opens -- on screen, big
//     enough to use, nothing covering it, its own text not overflowing
//   - the stage chrome: prompt controls same height and row, shortcut pills
//     big enough to tap with labels that neither wrap nor clip, and none of the
//     page's own duplicate toolbar showing through
//
// Usage (needs a local Chromium and playwright-core):
//   node scripts/layout-audit.mjs                       # both datasets
//   node scripts/layout-audit.mjs --data fixture        # bundled CSV only
//   node scripts/layout-audit.mjs --data production     # replayed Neon payload
//   node scripts/layout-audit.mjs --refresh-data        # re-capture that payload
//   node scripts/layout-audit.mjs --url https://...      # against a deploy preview
//   node scripts/layout-audit.mjs --shots ./audit-shots  # also save screenshots
//
// Exits non-zero if anything fails, so it can gate a release manually or from a
// workflow that has a browser available. Not part of `npm test`: CI has no
// browser, and the geometry gate already runs there.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';

const args = process.argv.slice(2);
const readFlag = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE_URL = readFlag('--url', 'http://127.0.0.1:8123/index.html');
const SHOTS = readFlag('--shots', null);
const CHROME = readFlag(
  '--chrome',
  process.env.CHROME_PATH || '/home/user/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'
);

// Which datasets to render. Both by default: the whole point is that a pass on
// one of them is not evidence about the other.
const DATA_CHOICE = readFlag('--data', 'both');
const REFRESH_DATA = args.includes('--refresh-data');
const PRODUCTION_URL = readFlag('--production-url', 'https://bandmembers.netlify.app');
const SNAPSHOT_PATH = new URL('./fixtures/production-bands.json', import.meta.url);

// Refreshing is explicit rather than automatic: the snapshot is a fixture, and a
// gate whose expectations silently change underneath it is not a gate.
if (REFRESH_DATA) {
  const endpoint = `${PRODUCTION_URL}/api/bands`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    console.error(`Could not refresh the production snapshot: ${endpoint} returned ${response.status}`);
    process.exit(1);
  }
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.bands) || !payload.bands.length) {
    console.error(`Refused to overwrite the snapshot: ${endpoint} returned no bands.`);
    process.exit(1);
  }
  // Sorted by id so a refresh yields a reviewable diff, not whole-file churn.
  const byId = (a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0);
  const snapshot = {
    ok: payload.ok,
    bands: [...payload.bands].sort(byId),
    members: [...payload.members].sort(byId),
    memberships: [...payload.memberships].sort(byId),
  };
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 0)}\n`);
  console.log(
    `Snapshot refreshed from ${endpoint}: `
    + `${snapshot.bands.length} bands, ${snapshot.members.length} members, `
    + `${snapshot.memberships.length} memberships.`
  );
}

const PRODUCTION_PAYLOAD = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

const DATASETS = [
  // The page's own fallback: no /api route, so it loads the bundled CSV.
  { key: 'fixture', label: 'csv ', replay: null },
  // Production's payload, served to the page from the fixture.
  { key: 'production', label: 'neon', replay: PRODUCTION_PAYLOAD },
].filter(set => DATA_CHOICE === 'both' || DATA_CHOICE === set.key);

if (!DATASETS.length) {
  console.error(`--data must be one of: fixture, production, both (got "${DATA_CHOICE}")`);
  process.exit(1);
}

const VIEWPORTS = [
  { label: 'desktop  1440x900', width: 1440, height: 900 },
  { label: 'tall     1056x1089', width: 1056, height: 1089 },
  { label: 'short    1280x620', width: 1280, height: 620 },
  { label: 'phone     390x844', width: 390, height: 844 },
];

// Each state is a name plus the calls to make on the controller.
const STATES = [
  { label: 'opening', steps: [] },
  { label: 'highlight-anchor', steps: [['highlightAnchor']] },
  { label: 'search', steps: [['clearHighlight'], ['explore', 'Mudhoney']] },
  { label: 'expanded', steps: [['clearHighlight'], ['explore', 'Mudhoney'], ['expand']] },
  { label: 'expanded-twice', steps: [['clearHighlight'], ['explore', 'Mudhoney'], ['expand'], ['expand']] },
];

// Thresholds, in drawn pixels.
const LIMITS = {
  // Two node circles must not intersect.
  nodeGap: 0,
  // A node must clear an edge it is not part of. Below hard, the edge is
  // visibly through the node and invents a membership; between hard and soft it
  // is a tight near-miss, which a non-planar graph cannot always avoid.
  edgeGapHard: -1,
  edgeGapSoft: 2,
  // Near-misses tolerated per view before the picture counts as degraded.
  softBudget: 6,
  // The camera ratio a fully framed view sits at (FRAMED_RATIO in the
  // renderer). Anything below it means the view zoomed in on purpose.
  fittedRatio: 1.5,
};

const { chromium } = await import('playwright-core');

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// Runs inside the page: measures everything about the current rendered view.
/* c8 ignore start -- runs in the browser, not under node coverage */
const MEASURE = limits => {
  const controller = window.RBFT_SIGMA;
  if (!controller) return { error: 'the Sigma explorer did not boot' };
  const renderer = controller.renderer;
  const graph = renderer.getGraph();

  const points = [];
  graph.forEachNode(id => {
    const display = renderer.getNodeDisplayData(id);
    const viewport = renderer.graphToViewport({
      x: graph.getNodeAttribute(id, 'x'),
      y: graph.getNodeAttribute(id, 'y'),
    });
    points.push({ id, x: viewport.x, y: viewport.y, r: display.size, label: display.label });
  });

  const straight = (p, a, b) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  };

  const byId = new Map(points.map(point => [point.id, point]));
  const problems = [];
  const nearMisses = [];

  // Node/node collisions.
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const gap = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
        - (points[i].r + points[j].r);
      if (gap <= limits.nodeGap) {
        problems.push(`nodes overlap (${gap.toFixed(1)}px): ${points[i].id} / ${points[j].id}`);
      }
    }
  }

  // Node/edge clearance.
  points.forEach(point => {
    graph.forEachEdge((edge, attrs, source, target) => {
      if (source === point.id || target === point.id) return;
      const a = byId.get(source);
      const b = byId.get(target);
      if (!a || !b) return;
      // Straight lines only: the constellation dropped curved edges, so the
      // clearance from a node to a thread is a point-to-segment distance.
      const gap = straight(point, a, b) - point.r;
      const message = `${point.id} sits ${gap.toFixed(1)}px from ${source} -- ${target}`;
      if (gap <= limits.edgeGapHard) problems.push(message);
      else if (gap <= limits.edgeGapSoft) nearMisses.push(message);
    });
  });

  // Silently unnamed nodes. Two exemptions, both deliberate:
  //   - the anchor, whose name is carried by the ringed-star overlay, and
  //   - labels dropped by updateLabelBlocking() because they would have printed
  //     across the chrome or across a bigger node's name. Those are a decision,
  //     not a fault, and are reported as a count instead. The distinction
  //     matters: silently losing a name to a size threshold is the bug this
  //     check was written for, and it would be masked by a blanket exemption.
  const suppressed = controller.state.labelBlocked || new Set();
  const unnamed = points.filter(
    point => !point.label && point.id !== controller.state.anchorId && !suppressed.has(point.id),
  );
  unnamed.forEach(point => problems.push(`no name rendered: ${point.id}`));

  // Framing. A view that CLAIMS to fit everything must not clip a node; a view
  // that has deliberately zoomed in to stay legible is showing a region on
  // purpose, and only needs to have its anchor on screen.
  const width = window.innerWidth;
  const height = window.innerHeight;
  // A node's LABEL is what a reader needs, and it extends to the right of the
  // node. Estimated from the character count at the rendered label size, since
  // measuring text in a WebGL canvas is not possible from here.
  const labelWidth = point => (point.label ? point.label.length * 7 + 12 : 0);
  const onScreen = point =>
    point.x >= -point.r &&
    point.y >= -point.r &&
    point.x + labelWidth(point) <= width &&
    point.y <= height + point.r;
  const ratio = renderer.getCamera().getState().ratio;
  const fitted = ratio >= limits.fittedRatio - 1e-6;
  if (fitted) {
    points.filter(point => !onScreen(point)).forEach(point => problems.push(`clipped: ${point.id}`));
  } else {
    const anchor = byId.get(controller.state.anchorId);
    if (anchor && !onScreen(anchor)) problems.push('the anchor is off screen');
  }

  // Phantom overlays: an overlay visible for a node that is not in the view.
  const home = document.querySelector('#sigma-stage .sigma-home-star');
  const focus = document.querySelector('#sigma-stage .sigma-focus-ring');
  const homeVisible = home && !home.hidden && getComputedStyle(home).display !== 'none';
  const focusVisible = focus && !focus.hidden && getComputedStyle(focus).display !== 'none';
  if (homeVisible && !graph.hasNode(controller.state.homeStarId || 'Aaron McRae')) {
    problems.push('home star drawn for a node that is not in this view');
  }
  if (focusVisible && !graph.hasNode(controller.state.anchorId)) {
    problems.push('focus ring drawn for a node that is not in this view');
  }

  if (nearMisses.length > limits.softBudget) {
    problems.push(`${nearMisses.length} tight near-misses (budget ${limits.softBudget}): ${nearMisses[0]}`);
  }

  return {
    suppressedLabels: suppressed.size,
    nodes: points.length,
    edges: graph.size,
    anchor: controller.state.anchorId,
    sizeScale: Number(controller.state.sizeScale.toFixed(2)),
    smallestNode: Number(Math.min(...points.map(p => p.r)).toFixed(1)),
    nearMisses: nearMisses.length,
    problems,
  };
};
/* c8 ignore stop */

/**
 * Checks the stage chrome rather than the graph: the controls a visitor actually
 * aims at. Runs in the page.
 *
 * Added after the search field and the Explore button turned out to be the same
 * size but 8px out of vertical alignment -- the page's global form styling
 * (input{margin-top:...}, written for stacked labelled fields) leaked into the
 * prompt. Nothing in the node-collision measurement could see that, and eyeballing
 * a screenshot had already missed it once.
 */
/* c8 ignore start */
// ---------------------------------------------------------------------------
// Click-through pass.
//
// Two bugs shipped in one day that every other check called clean: the Filter
// pill opened its panel just past the bottom of the window (top:910 in a 900px
// viewport), and the "No Rawk Found" prompt never appeared because nothing
// listened for the event that raises it. Both were invisible to the suite for
// the same reason -- the tests drove the machinery directly (selectOption on a
// <select>, functions called by name) instead of pressing the thing a visitor
// presses and then looking at what came up.
//
// So this pass PRESSES each pill and asserts that whatever opens is actually
// usable: on screen, big enough to read, and not buried under other chrome. It
// deliberately measures the result rather than trusting an aria attribute -- the
// Filter pill was setting aria-expanded="true" the whole time it was broken.
// ---------------------------------------------------------------------------

// Each pill, and the surface it should raise.
const CLICK_THROUGH = [
  { key: 'filter', opens: '.sigma-filters', label: 'Filter panel' },
  { key: 'share', opens: '#share-popover', label: 'Share panel' },
  { key: 'add', opens: '#add-band-popover', label: 'Add-band panel' },
  { key: 'feedback', opens: '#feedback-popover', label: 'Feedback panel' },
  // Not a pill: type a band that is not in the tree and press Explore. This is
  // the other bug -- the "No Rawk Found" prompt with its offer to add the band
  // existed and worked, but nothing listened for the miss, so it never appeared.
  { search: 'Zzzz Not A Real Band', opens: '#graph-empty-state', label: 'No Rawk Found' },
  // The corner the hamburger vacated. On a phone this is the only way in, so it
  // has to raise a usable panel at every width. One control now, not two: the two
  // flows are merged.
  { selector: '#sign-in-btn', opens: '#add-band-popover', label: 'Sign in panel' },
  // Step two of the same door. An unknown email reveals five more fields, which
  // makes the panel taller than the screen -- so the check is not "did it open"
  // but "can the visitor still press the button", with a real click at the
  // button's own coordinates. Without this the profile step could grow until its
  // own submit sat off-screen and every other check would stay green.
  {
    selector: '#sign-in-btn',
    opens: '#add-band-popover',
    label: 'Create-account step',
    signupEmail: 'audit-unknown-address@example.com',
    thenPress: '#signup-submit-btn',
  },
];

const MEASURE_OPENED = (selector) => {
  const el = document.querySelector(selector);
  if (!el) return { problems: [`${selector} is not in the document`] };
  if (el.hidden) return { problems: [`${selector} is still hidden after the click`] };
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return { problems: [`${selector} is display:none after the click`] };
  if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) {
    return { problems: [`${selector} is invisible after the click`] };
  }

  const problems = [];
  const r = el.getBoundingClientRect();
  const box = `${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`;

  // The bug that started this: a panel that opens outside the window.
  const margin = -1;
  if (r.width < 40 || r.height < 40) problems.push(`opened at ${box}, too small to be usable`);
  if (r.top < margin) problems.push(`opened ${Math.round(-r.top)}px above the top of the window (${box})`);
  if (r.left < margin) problems.push(`opened ${Math.round(-r.left)}px left of the window (${box})`);
  if (r.bottom > window.innerHeight - margin) {
    problems.push(`opened ${Math.round(r.bottom - window.innerHeight)}px below the bottom of the window (${box})`);
  }
  if (r.right > window.innerWidth - margin) {
    problems.push(`opened ${Math.round(r.right - window.innerWidth)}px right of the window (${box})`);
  }

  // Reachable by a pointer: something else on top of the middle of the panel
  // means a visitor clicks that instead. Skips panels taller than the window,
  // which scroll internally and legitimately start under the hero.
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + Math.min(r.height / 2, 40));
  if (r.height <= window.innerHeight && cx > 0 && cy > 0) {
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !el.contains(hit) && hit !== el) {
      problems.push(`${hit.tagName.toLowerCase()}.${(hit.className || '').toString().split(' ')[0]} covers it`);
    }
  }

  // Its own text has to fit: a heading clipped by the panel edge is the same
  // class of fault as a label printing over the footer.
  el.querySelectorAll('h1, h2, h3, h4, p, label, button, .share-popover-title').forEach(child => {
    if (!child.textContent.trim() || child.children.length) return;
    const cr = child.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    if (cr.right > r.right + 1 || cr.left < r.left - 1) {
      problems.push(`"${child.textContent.trim().slice(0, 24)}" overflows the panel horizontally`);
    }
  });

  return { problems, metrics: { box } };
};

const MEASURE_CHROME = () => {
  const stage = document.getElementById('sigma-stage');
  if (!stage) return { problems: ['no sigma stage on the page'] };
  const form = stage.querySelector('.sigma-prompt form');
  const input = form && form.querySelector('input');
  const button = form && form.querySelector('button');
  if (!input || !button) return { problems: ['the search prompt is missing its input or button'] };

  const problems = [];
  const ri = input.getBoundingClientRect();
  const rb = button.getBoundingClientRect();
  const centre = r => (r.top + r.bottom) / 2;

  // Same row: a pill that sits even a few pixels high reads as a mistake.
  const offset = Math.abs(centre(ri) - centre(rb));
  if (offset > 1) problems.push(`prompt controls are ${offset.toFixed(1)}px out of vertical alignment`);

  // Same height.
  const heightGap = Math.abs(ri.height - rb.height);
  if (heightGap > 1) {
    problems.push(`prompt controls differ in height by ${heightGap.toFixed(1)}px `
      + `(field ${ri.height.toFixed(0)}px, button ${rb.height.toFixed(0)}px)`);
  }

  // iOS Safari zooms the page when a focused input's text is under 16px.
  const fontSize = parseFloat(getComputedStyle(input).fontSize);
  if (fontSize < 16) problems.push(`input font is ${fontSize}px; under 16px makes iOS zoom on focus`);

  // Nothing clipped or wrapped, and the label on one line.
  if (button.scrollWidth > button.clientWidth + 1) problems.push('the Explore label is clipped');
  // Count the label's own line boxes. Deriving lines from the button's height
  // does not work now that it has an explicit height taller than its text.
  const range = document.createRange();
  range.selectNodeContents(button);
  const textLines = range.getClientRects().length;
  if (textLines > 1) problems.push(`the Explore label wrapped onto ${textLines} lines`);
  if (ri.left < 0 || rb.right > window.innerWidth) problems.push('the prompt overflows the viewport');

  // The shortcut row: one-word pills whose labels must not wrap or clip, and
  // which have to stay big enough to hit with a thumb.
  const pills = [...stage.querySelectorAll('.sigma-action')].filter(
    el => !!el.offsetParent || el.getClientRects().length > 0,
  );
  if (!pills.length) problems.push('the shortcut row has no visible pills');
  pills.forEach(pill => {
    const r = pill.getBoundingClientRect();
    const name = pill.dataset.key || pill.textContent.trim();
    // 40px is the floor for a comfortable touch target on a phone.
    if (r.height < 40) problems.push(`the ${name} pill is only ${r.height.toFixed(0)}px tall`);
    if (pill.scrollWidth > pill.clientWidth + 1) problems.push(`the ${name} pill's label is clipped`);
    const range = document.createRange();
    range.selectNodeContents(pill);
    if (range.getClientRects().length > 1) problems.push(`the ${name} pill's label wrapped`);
    if (r.left < 0 || r.right > window.innerWidth) problems.push(`the ${name} pill is off screen`);
  });

  // The wordmark stays put, above the field, the way a search home page does it.
  const wordmark = stage.querySelector('.sigma-wordmark');
  if (!wordmark) problems.push('the wordmark is missing');
  else if (wordmark.getBoundingClientRect().bottom > ri.top) {
    problems.push('the wordmark overlaps the search field');
  }

  // The page's own toolbar must not be showing at the same time as this chrome.
  ['.hero', '.graph-overlay-top', '.graph-stats-badge'].forEach(selector => {
    const el = document.querySelector(selector);
    if (el && (el.offsetParent || el.getClientRects().length)) {
      problems.push(`the page's ${selector} is still visible behind the Sigma chrome`);
    }
  });

  return {
    problems,
    metrics: {
      offset: +offset.toFixed(1),
      height: +ri.height.toFixed(0),
      font: fontSize,
      pills: pills.length,
    },
  };
};
/* c8 ignore stop */

/**
 * Measures the TEXT, which nothing else here does.
 *
 * The node/node and node/thread checks passed while two real collisions shipped
 * to production: a band name printed across the gold you-are-here label, and
 * another printed across the footer. Both are text against text, which no
 * geometry check could see -- so this measures drawn label boxes against each
 * other, against the overlay labels, and against the chrome.
 *
 * Label boxes are reconstructed the way Sigma draws them (x + size + 3, baseline
 * at y + labelSize/3) and only for labels Sigma actually displayed, which
 * getNodeDisplayedLabels() reports after its own grid culling -- guessing at
 * that culling would produce false collisions for labels that were never drawn.
 */
/* c8 ignore start */
const MEASURE_LABELS = () => {
  const controller = window.RBFT_SIGMA;
  const stage = document.getElementById('sigma-stage');
  if (!controller || !stage) return { problems: ['no sigma renderer on the page'] };
  const renderer = controller.renderer;
  const displayed = renderer.getNodeDisplayedLabels();
  if (!displayed) return { problems: ['sigma did not report which labels it drew'] };

  const size = renderer.getSetting('labelSize');
  const font = renderer.getSetting('labelFont');
  const weight = renderer.getSetting('labelWeight');
  const context = document.createElement('canvas').getContext('2d');
  context.font = `${weight} ${size}px ${font}`;

  const graph = renderer.getGraph();
  const boxes = [];
  displayed.forEach(key => {
    const data = renderer.getNodeDisplayData(key);
    if (!data || !data.label) return;
    // Display-data x/y are framed graph coordinates, not pixels -- reading them
    // directly put every label in the same place and reported every pair as a
    // collision. graphToViewport is the same conversion the node checks use.
    const point = renderer.graphToViewport({
      x: graph.getNodeAttribute(key, 'x'),
      y: graph.getNodeAttribute(key, 'y'),
    });
    const width = context.measureText(data.label).width;
    const left = point.x + data.size + 3;
    const baseline = point.y + size / 3;
    boxes.push({
      key,
      label: data.label,
      left,
      right: left + width,
      // Ascent/descent around the baseline, close enough for a collision test.
      top: baseline - size * 0.78,
      bottom: baseline + size * 0.24,
    });
  });

  const overlap = (a, b) => {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 1 && y > 1 ? { x, y } : null;
  };
  const problems = [];

  // 1. Node label against node label.
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const hit = overlap(boxes[i], boxes[j]);
      if (hit) {
        problems.push(
          `labels overlap (${hit.x.toFixed(0)}x${hit.y.toFixed(0)}px): `
          + `"${boxes[i].label}" / "${boxes[j].label}"`,
        );
      }
    }
  }

  // 2. Node label against the gold you-are-here label, which is DOM.
  // Chrome rects have to be expressed in the same space as the label boxes, which
  // graphToViewport reports relative to the RENDERER'S CONTAINER. Measuring them
  // against the stage wrapper (~280px further down the page, inside .graph-stage)
  // is what let this check pass while a label printed across the footer on screen.
  const originBox = (renderer.getContainer
    ? renderer.getContainer()
    : stage.querySelector('.sigma-canvas-host')).getBoundingClientRect();
  const toStage = rect => ({
    left: rect.left - originBox.left,
    right: rect.right - originBox.left,
    top: rect.top - originBox.top,
    bottom: rect.bottom - originBox.top,
  });
  const overlayEl = stage.querySelector('.sigma-home-label');
  if (overlayEl && !overlayEl.hidden) {
    const overlayBox = toStage(overlayEl.getBoundingClientRect());
    boxes.forEach(box => {
      if (overlap(box, overlayBox)) {
        problems.push(`"${box.label}" prints across the you-are-here label`);
      }
    });
  }

  // 3. Node label against the chrome it would print over.
  [['hero', '.sigma-hero'], ['footer', '.sigma-footer']].forEach(([name, selector]) => {
    const el = stage.querySelector(selector);
    if (!el) return;
    const chromeBox = toStage(el.getBoundingClientRect());
    boxes.forEach(box => {
      if (overlap(box, chromeBox)) problems.push(`"${box.label}" prints across the ${name}`);
    });
  });

  return { problems, metrics: { labels: boxes.length } };
};
/* c8 ignore stop */

let failures = 0;
const rows = [];
const chromeRows = [];
const clickRows = [];
const labelRows = [];

for (const dataset of DATASETS) {
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    // The share-image check below downloads a PNG.
    acceptDownloads: true,
  });
  // Replay production's payload into the local page. The page asks /api/bands
  // first and falls back to CSV, so fulfilling that one route is the entire
  // difference between auditing 3,194 nodes and auditing what users see.
  if (dataset.replay) {
    await context.route('**/api/bands', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(dataset.replay),
    }));
  }
  // The site is behind a shared password gate; unlock it the way a returning
  // visitor's session would be.
  await context.addInitScript(() => {
    try {
      sessionStorage.setItem('rbft-unlocked', 'yes');
    } catch (error) {
      /* private mode: the gate will show, and the audit will report it */
    }
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => {
    // The local static server has no /api routes; the page falls back to CSV,
    // which is expected and not a rendering fault.
    if (!request.url().includes('/api/')) consoleErrors.push(`failed request: ${request.url()}`);
  });

  const url = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}renderer=sigma`;
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(10000);

  const chrome = await page.evaluate(MEASURE_CHROME);
  chromeRows.push({ label: `${dataset.label}  ${viewport.label}`, ...chrome });
  if (chrome.problems.length) failures += 1;

  // Does Share actually produce a picture? This shipped broken: the export
  // serialised #graph-svg, and once the constellation became the default that SVG
  // was hidden -- a display:none element measures 0x0, so the canvas came out
  // zero-sized and every share failed with "Could not generate the image". A
  // check that presses the button and weighs the file is the only kind that
  // would have caught it.
  {
    const label = `${dataset.label}  ${viewport.label} / Share image`;
    const problems = [];
    let metrics = null;
    try {
      await page.click('.sigma-action[data-key="share"]', { timeout: 5000 });
      await page.waitForTimeout(600);
      const pending = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
      await page.click('button:has-text("Download PNG")', { timeout: 5000 });
      const download = await pending;
      if (!download) {
        const message = await page.evaluate(() =>
          document.querySelector('#share-feedback, .share-feedback')?.textContent?.trim() || '');
        problems.push(`no image was produced${message ? ` -- the page said "${message}"` : ''}`);
      } else {
        const path = await download.path();
        const { size } = path ? await stat(path) : { size: 0 };
        metrics = { box: `${Math.round(size / 1024)}kB` };
        // A blank or zero-sized canvas still encodes to a valid PNG, just a tiny
        // one, so the weight is the assertion that matters.
        if (size < 20000) problems.push(`the image is only ${size} bytes -- almost certainly blank`);
      }
    } catch (error) {
      problems.push(`sharing failed: ${error.message.split('\n')[0]}`);
    }
    clickRows.push({ label, problems, metrics });
    if (problems.length) failures += 1;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const el = document.querySelector('#share-popover');
      if (el && !el.hidden) el.hidden = true;
    });
  }

  // Press every pill and look at what comes up. See CLICK_THROUGH.
  for (const item of CLICK_THROUGH) {
    const trigger = item.selector || `.sigma-action[data-key="${item.key}"]`;
    const label = `${dataset.label}  ${viewport.label} / ${item.label}`;
    let result;
    try {
      if (item.search) {
        // Search the way a visitor does, through the field and the button.
        await page.fill('.sigma-prompt input', item.search);
        await page.click('.sigma-prompt form button[type="submit"]');
        await page.waitForTimeout(900);
        result = await page.evaluate(MEASURE_OPENED, item.opens);
      } else {
      const present = await page.$(trigger);
      if (!present) {
        result = { problems: [`no ${item.key || item.selector} control to press`] };
      } else {
        // A real press, at the pill's own coordinates, so anything covering the
        // pill fails here rather than being bypassed by a synthetic event.
        await page.click(trigger, { timeout: 5000 });
        await page.waitForTimeout(650);
        if (item.signupEmail) {
          // Answer "no account on that email" without a database, so the audit
          // exercises the reveal rather than the network.
          await page.route('**/api/signup', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ found: false, created: false, user: null }),
          }));
          await page.fill('#signup-email', item.signupEmail);
          await page.click('#signup-submit-btn', { timeout: 5000 });
          await page.waitForTimeout(900);
          await page.unroute('**/api/signup').catch(() => {});
        }
        result = await page.evaluate(MEASURE_OPENED, item.opens);
        if (item.thenPress && !result.problems.length) {
          // Press it as a person would. Scrolling to reach it is fine; being
          // covered, disabled or absent is not.
          const shown = await page.$(item.thenPress);
          if (!shown) {
            result.problems.push(`${item.thenPress} is not on the page after the reveal`);
          } else {
            const revealed = await page.evaluate(
              () => !document.getElementById('signup-profile-fields')?.hidden
            );
            if (!revealed) result.problems.push('an unknown email did not reveal the profile step');
            try {
              await page.click(item.thenPress, { timeout: 5000 });
            } catch (error) {
              result.problems.push(`cannot press ${item.thenPress}: ${error.message.split('\n')[0]}`);
            }
          }
        }
      }
      }
    } catch (error) {
      const what = item.search ? `searching for "${item.search}"` : `pressing the ${item.key} pill`;
      result = { problems: [`${what} failed: ${error.message.split('\n')[0]}`] };
    }
    clickRows.push({ label, ...result });
    if (result.problems.length) failures += 1;
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png` });
    }
    // Close it again so the next pill starts from a clean stage.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      // Escape does not close every panel; hide any that are still up.
      ['.sigma-filters', '#share-popover', '#add-band-popover', '#feedback-popover', '#graph-empty-state', '#signup-popover']
        .forEach(sel => { const el = document.querySelector(sel); if (el && !el.hidden) el.hidden = true; });
      const field = document.querySelector('.sigma-prompt input');
      if (field) field.value = '';
    });
    await page.waitForTimeout(250);
  }

  for (const state of STATES) {
    for (const [action, argument] of state.steps) {
      await page.evaluate(
        ({ action: name, argument: value }) => {
          const controller = window.RBFT_SIGMA;
          if (!controller) return;
          if (name === 'highlightAnchor') controller.highlightFrom(controller.state.anchorId);
          if (name === 'clearHighlight') controller.clearHighlight();
          if (name === 'explore') controller.exploreFor(value);
          if (name === 'expand') controller.expand();
        },
        { action, argument }
      );
      await page.waitForTimeout(1600);
    }

    const result = await page.evaluate(MEASURE, LIMITS);
    const labelResult = await page.evaluate(MEASURE_LABELS);
    const problems = result.error ? [result.error] : result.problems;
    const label = `${dataset.label}  ${viewport.label} / ${state.label}`;
    labelRows.push({ label, ...labelResult });
    if (labelResult.problems.length) failures += 1;
    rows.push({ label, result, problems: problems.concat(consoleErrors.splice(0)) });
    if (rows[rows.length - 1].problems.length) failures += 1;

    if (SHOTS) {
      const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      await page.screenshot({ path: `${SHOTS}/${slug}.png` });
    }

    // Reset to the opening view before the next state's steps.
    await page.evaluate(() => {
      const controller = window.RBFT_SIGMA;
      if (controller) controller.clearHighlight();
    });
  }

  await context.close();
}
}

await browser.close();

console.log(`\nRendered-view audit  --  datasets: ${DATASETS.map(d => d.key).join(', ')}\n`);
console.log(`  csv  = bundled seattle_band_members CSV (the local fallback)`);
console.log(`  neon = production payload replayed from scripts/fixtures/production-bands.json\n`);
rows.forEach(({ label, result, problems }) => {
  const summary = result.error
    ? 'DID NOT BOOT'
    : `${String(result.nodes).padStart(3)} nodes  scale ${result.sizeScale}  smallest ${result.smallestNode}px  `
      + `near-misses ${result.nearMisses}  labels hidden ${result.suppressedLabels ?? '?'}`;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${label.padEnd(40)} ${summary}`);
  problems.slice(0, 4).forEach(problem => console.log(`        - ${problem}`));
  if (problems.length > 4) console.log(`        - ...and ${problems.length - 4} more`);
});

console.log('\nLabel collisions\n');
labelRows.forEach(({ label, problems, metrics }) => {
  const summary = metrics ? `${String(metrics.labels).padStart(3)} labels drawn` : 'not measured';
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${label.padEnd(40)} ${summary}`);
  problems.slice(0, 4).forEach(problem => console.log(`        - ${problem}`));
  if (problems.length > 4) console.log(`        - ...and ${problems.length - 4} more`);
});

console.log('\nStage chrome\n');
chromeRows.forEach(({ label, problems, metrics }) => {
  const summary = metrics
    ? `field ${metrics.height}px  font ${metrics.font}px  offset ${metrics.offset}px  ${metrics.pills} pills`
    : 'not measured';
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${label.padEnd(40)} ${summary}`);
  problems.forEach(problem => console.log(`        - ${problem}`));
});

console.log('\nClick-through  --  press each pill, measure what opens\n');
clickRows.forEach(({ label, problems, metrics }) => {
  const summary = metrics ? metrics.box : 'did not open';
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${label.padEnd(40)} ${summary}`);
  problems.forEach(problem => console.log(`        - ${problem}`));
});

const checks = rows.length + chromeRows.length + labelRows.length + clickRows.length;
console.log(`\n${checks - failures}/${checks} checks clean`);
process.exit(failures ? 1 : 0);
