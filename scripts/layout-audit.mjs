// ---------------------------------------------------------------------------
// Rendered-view audit for the Sigma neighborhood explorer.
//
// The companion to tests/layout-invariants.test.mjs. That one checks layout
// geometry in the abstract and runs in CI; this one checks what is actually on
// screen -- real node radii, real label culling, real camera framing -- across
// the matrix that kept producing bug reports:
//
//   viewport sizes  x  view states  x  checks
//
// Viewports include a tall/narrow desktop window and a phone, because node
// radii are screen pixels: a view that is comfortable at 1440x900 can collide
// at 1056x1089. View states include the gold/blue highlight, because
// highlighting changes node sizes and label visibility. Checks include:
//
//   - node/node collisions in drawn pixels
//   - node/edge clearance against the CURVE that is drawn
//   - unnamed nodes (labels silently culled by size threshold)
//   - nodes rendered outside the viewport (camera framing too tight)
//   - phantom overlays (an anchor star drawn for a node not in the view)
//   - console errors and failed module loads
//
// Usage (needs a local Chromium and playwright-core):
//   node scripts/layout-audit.mjs                       # against a local server
//   node scripts/layout-audit.mjs --url https://...      # against a deploy preview
//   node scripts/layout-audit.mjs --shots ./audit-shots  # also save screenshots
//
// Exits non-zero if anything fails, so it can gate a release manually or from a
// workflow that has a browser available. Not part of `npm test`: CI has no
// browser, and the geometry gate already runs there.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';

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
  // Mirrors Sigma's edge-curve control point so the measurement matches the
  // pixels: midpoint pushed perpendicular by curvature * length.
  const curved = (p, a, b, curvature) => {
    if (!curvature) return straight(p, a, b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const cx = (a.x + b.x) / 2 - dy * curvature;
    const cy = (a.y + b.y) / 2 + dx * curvature;
    let best = Infinity;
    let previous = a;
    for (let i = 1; i <= 16; i += 1) {
      const t = i / 16;
      const u = 1 - t;
      const current = {
        x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
        y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
      };
      best = Math.min(best, straight(p, previous, current));
      previous = current;
    }
    return best;
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
      const gap = curved(point, a, b, attrs.curvature || 0) - point.r;
      const message = `${point.id} sits ${gap.toFixed(1)}px from ${source} -- ${target}`;
      if (gap <= limits.edgeGapHard) problems.push(message);
      else if (gap <= limits.edgeGapSoft) nearMisses.push(message);
    });
  });

  // Silently unnamed nodes. The anchor is exempt: its name is carried by the
  // ringed-star overlay instead of a Sigma label.
  const unnamed = points.filter(point => !point.label && point.id !== controller.state.anchorId);
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

let failures = 0;
const rows = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
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
    const problems = result.error ? [result.error] : result.problems;
    const label = `${viewport.label} / ${state.label}`;
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

await browser.close();

console.log('\nRendered-view audit\n');
rows.forEach(({ label, result, problems }) => {
  const summary = result.error
    ? 'DID NOT BOOT'
    : `${String(result.nodes).padStart(3)} nodes  scale ${result.sizeScale}  smallest ${result.smallestNode}px  near-misses ${result.nearMisses}`;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${label.padEnd(34)} ${summary}`);
  problems.slice(0, 4).forEach(problem => console.log(`        - ${problem}`));
  if (problems.length > 4) console.log(`        - ...and ${problems.length - 4} more`);
});

console.log(`\n${rows.length - failures}/${rows.length} views clean`);
process.exit(failures ? 1 : 0);
