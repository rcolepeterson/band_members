// Regression tests for the text-size legibility pass.
//
// Tester feedback ("the text is very small, can you find a way to render it
// larger") was addressed by raising the --text-* type ramp rather than
// html{font-size}, because --space-* and --radius-* are rem-based too and
// bumping the root would have grown spacing and radii while the many
// fixed-px min-heights stayed put.
//
// These tests pin the two things that are easy to regress:
//   1. The ramp floors — a future "just make this one chip smaller" edit
//      that reintroduces sub-12px body text should fail here.
//   2. The SVG node label sizes, which live in three places (a CSS class, an
//      inline font-size D3 sets per datum, and the PNG-export stylesheet)
//      plus a mobile !important override. They drifted apart before: the
//      mobile override targeted .node-label-person, a class the render code
//      never applied, so the person-specific mobile size was dead.
//
// Sizes are asserted as numbers, not string matches, so a rem/px unit switch
// still gets checked rather than silently passing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// Root font-size is never overridden, so 1rem === the browser default 16px.
const ROOT_PX = 16;

function toPx(value, unit) {
  return unit === 'px' ? value : value * ROOT_PX;
}

// Pull `--text-foo: clamp(min, preferred, max);` and return the clamp floor
// and ceiling in px. The floor is what matters for legibility — it's what
// narrow viewports actually render.
function readRampStep(name) {
  const re = new RegExp(`--text-${name}:\\s*clamp\\(([^)]+)\\);`);
  const match = INDEX_HTML.match(re);
  assert.ok(match, `Expected a clamp() definition for --text-${name}`);
  const parts = match[1].split(',').map(p => p.trim());
  assert.equal(parts.length, 3, `--text-${name} should be clamp(min, preferred, max)`);
  const parse = expr => {
    const m = expr.match(/^([0-9.]+)(px|rem)$/);
    assert.ok(m, `Expected a bare px/rem length in --text-${name}, got "${expr}"`);
    return toPx(Number(m[1]), m[2]);
  };
  return { min: parse(parts[0]), max: parse(parts[2]) };
}

// Grab a single `font-size` declaration from inside the first CSS rule whose
// selector block starts at `anchor`.
function fontSizeInRule(anchor) {
  const start = INDEX_HTML.indexOf(anchor);
  assert.ok(start !== -1, `Expected to find rule "${anchor}" in index.html`);
  const end = INDEX_HTML.indexOf('}', start);
  assert.ok(end > start, `Rule "${anchor}" is not closed`);
  const block = INDEX_HTML.slice(start, end);
  const match = block.match(/font-size:\s*([0-9.]+)(px|rem)/);
  assert.ok(match, `Expected a font-size inside "${anchor}"`);
  return toPx(Number(match[1]), match[2]);
}

// ---------------------------------------------------------------------------
// Type ramp
// ---------------------------------------------------------------------------

test('--text-* ramp floors clear the 12px legibility threshold', () => {
  // --text-xs is the smallest token in the ramp and drives form labels,
  // section labels, the HUD badge and the verification panel. Its clamp floor
  // is the single most load-bearing number in this pass.
  const xs = readRampStep('xs');
  assert.ok(xs.min >= 13, `--text-xs floor should be >= 13px, got ${xs.min}px`);

  const sm = readRampStep('sm');
  assert.ok(sm.min >= 15, `--text-sm floor should be >= 15px, got ${sm.min}px`);

  const base = readRampStep('base');
  assert.ok(base.min >= 17, `--text-base floor should be >= 17px, got ${base.min}px`);
});

test('--text-* ramp stays monotonically increasing at both clamp ends', () => {
  const steps = ['xs', 'sm', 'base', 'lg', 'xl', '2xl'].map(readRampStep);
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(
      steps[i].min > steps[i - 1].min,
      `Ramp floor should increase at step ${i}: ${steps[i - 1].min}px -> ${steps[i].min}px`
    );
    assert.ok(
      steps[i].max > steps[i - 1].max,
      `Ramp ceiling should increase at step ${i}: ${steps[i - 1].max}px -> ${steps[i].max}px`
    );
  }
});

// ---------------------------------------------------------------------------
// SVG node labels
// ---------------------------------------------------------------------------

test('node label sizes are driven by one helper shared with the collision force', () => {
  const helper = INDEX_HTML.match(
    /const nodeLabelPx = d => d\.type === 'band' \? (\d+) : (\d+);/
  );
  assert.ok(helper, 'Expected a nodeLabelPx() helper defining band/person label sizes');
  const bandPx = Number(helper[1]);
  const personPx = Number(helper[2]);

  assert.ok(bandPx >= 15, `Band node labels should be >= 15px, got ${bandPx}px`);
  assert.ok(personPx >= 13, `Person node labels should be >= 13px, got ${personPx}px`);
  assert.ok(bandPx > personPx, 'Band labels should stay larger than person labels');

  // Both the rendered font-size and the labelHeight the collision force reads
  // must come from the helper. A hardcoded literal in either place is how the
  // reserved label box silently stops matching the painted text.
  assert.match(
    INDEX_HTML,
    /\.style\('font-size', d => `\$\{nodeLabelPx\(d\)\}px`\)/,
    'Label font-size should be set from nodeLabelPx()'
  );
  assert.match(
    INDEX_HTML,
    /d\.labelHeight = nodeLabelPx\(d\);/,
    'labelHeight should be set from nodeLabelPx() rather than a duplicated literal'
  );
});

test('node labels carry a type class so the mobile size override can target them', () => {
  // The mobile media query has a `text.node-label-person` rule. It only does
  // anything if the render code actually applies that class.
  assert.match(
    INDEX_HTML,
    /\.attr\('class', d => d\.type === 'band' \? 'node-label node-label-band' : 'node-label node-label-person'\)/,
    'Node label <text> elements should get a band/person class alongside .node-label'
  );
});

test('mobile node labels are at least as large as desktop', () => {
  const helper = INDEX_HTML.match(
    /const nodeLabelPx = d => d\.type === 'band' \? (\d+) : (\d+);/
  );
  assert.ok(helper, 'Expected a nodeLabelPx() helper to compare against');
  const desktopBand = Number(helper[1]);
  const desktopPerson = Number(helper[2]);

  const mobileBand = fontSizeInRule('#graph-svg text {');
  const mobilePerson = fontSizeInRule('#graph-svg text.node-label-person {');

  assert.ok(
    mobileBand >= desktopBand,
    `Mobile band labels (${mobileBand}px) must not be smaller than desktop (${desktopBand}px)`
  );
  assert.ok(
    mobilePerson >= desktopPerson,
    `Mobile person labels (${mobilePerson}px) must not be smaller than desktop (${desktopPerson}px)`
  );
});

test('the PNG-export stylesheet keeps node labels legible too', () => {
  // Shared graphs are rasterised through an inline stylesheet on a cloned SVG,
  // which does not inherit the page's .node-label rule.
  const match = INDEX_HTML.match(/\.node-label \{ fill: #e7f3fb; font-size: (\d+)px;/);
  assert.ok(match, 'Expected a .node-label rule in the export inline stylesheet');
  assert.ok(
    Number(match[1]) >= 13,
    `Exported node labels should be >= 13px, got ${match[1]}px`
  );
});

// ---------------------------------------------------------------------------
// Surfaces that bypass the ramp
// ---------------------------------------------------------------------------

test('compact toolbar pill labels clear 12px despite bypassing the ramp', () => {
  // This !important block overrides .tool-chip's var(--text-sm), so raising
  // the ramp alone does nothing for toolbar chip labels — they have to be
  // raised here, and a future edit that shrinks them again should fail.
  const start = INDEX_HTML.indexOf('.primary-btn.share-btn,\n.panel-toggle-btn {');
  assert.ok(start !== -1, 'Expected the compact toolbar pill rule');
  const block = INDEX_HTML.slice(start, INDEX_HTML.indexOf('}', start));

  const fontMatch = block.match(/font-size:\s*([0-9.]+)(px|rem)\s*!important/);
  assert.ok(fontMatch, 'Compact pills should declare a font-size');
  const fontPx = toPx(Number(fontMatch[1]), fontMatch[2]);
  assert.ok(fontPx >= 12, `Toolbar chip labels should be >= 12px, got ${fontPx}px`);
});

test('node card text is legible on every row type', () => {
  const surfaces = {
    '.node-card {': 14,           // card body / bio copy
    '.node-card__name {': 16,     // band or musician name
    '.node-card__sub {': 13,      // scene / instrument subtitle
    '.node-card__rows > .k {': 12, // info row keys
    '.node-card__rows > .v {': 14, // info row values
    '.node-card__row-label {': 12, // connections heading
    '.node-card__chip {': 13,     // member / band chips
    '.node-card__signin-hint {': 13,
  };
  for (const [anchor, floor] of Object.entries(surfaces)) {
    const px = fontSizeInRule(anchor);
    assert.ok(px >= floor, `${anchor.trim()} should be >= ${floor}px, got ${px}px`);
  }
});

test('no declared font-size in index.html falls below 11px', () => {
  // Catch-all floor. Anything under 12px must be a deliberately compact
  // secondary line in the mobile HUD badge, which is width-constrained by the
  // graph overlay it floats above.
  const lines = INDEX_HTML.split('\n');
  const offenders = [];
  lines.forEach((line, idx) => {
    for (const match of line.matchAll(/font-size:\s*([0-9.]+)(px|rem|em)/g)) {
      if (match[2] === 'em') continue; // relative to the parent, not the root
      const px = toPx(Number(match[1]), match[2]);
      if (px < 12) offenders.push({ line: idx + 1, px, text: line });
    }
  });

  for (const offender of offenders) {
    assert.ok(
      offender.px >= 11,
      `index.html:${offender.line} declares ${offender.px}px, below the 11px hard floor`
    );
    assert.match(
      offender.text,
      /graph-stats-badge/,
      `index.html:${offender.line} declares ${offender.px}px outside the allowed mobile HUD badge`
    );
  }
});

// ---------------------------------------------------------------------------
// Styles the pass must not have disturbed
// ---------------------------------------------------------------------------

test('placeholder example hints stay faded and italic', () => {
  // The faded-italic placeholder treatment is deliberate — placeholders hold
  // example values ("Temple of the Dog"), so they must not read as filled-in
  // data. The legibility pass only scales them via the inherited ramp.
  const match = INDEX_HTML.match(/input::placeholder,textarea::placeholder\{([^}]+)\}/);
  assert.ok(match, 'Expected the shared placeholder rule');
  assert.match(match[1], /font-style:italic/, 'Placeholders should stay italic');
  assert.match(match[1], /color:rgba\(230,232,240,0\.32\)/, 'Placeholders should stay faded');
  assert.doesNotMatch(
    match[1],
    /font-size/,
    'Placeholders should inherit their size from the input, not pin their own'
  );
});

test('mobile form inputs stay at 16px so iOS does not zoom on focus', () => {
  const px = fontSizeInRule('.mobile-sheet .mobile-sheet-filter-row select {');
  assert.ok(px >= 16, `Mobile sheet inputs should be >= 16px, got ${px}px`);
});
