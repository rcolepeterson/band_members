// ---------------------------------------------------------------------------
// Layout parameter sweep.
//
// The neighborhood layout has a handful of tuning knobs -- how much of its
// angular gap a branch may use, the separation floor, how far sub-rings sit
// apart, how hard edges bow. Nudging them one at a time and re-checking by eye
// is how this work turned into a long series of "still looks wrong" rounds.
//
// This runs the SAME invariant checks as the CI gate
// (tests/layout-invariants.test.mjs, via tests/helpers/layout-checks.mjs) across
// the full graph-shape x anchor x budget matrix, for every combination of knob
// values, and reports which combinations are clean.
//
// Pure geometry: no browser, no network. Seconds to run.
//
//   node scripts/layout-tune.mjs            # sweep and rank
//   node scripts/layout-tune.mjs --current  # just check today's defaults
// ---------------------------------------------------------------------------

import { linkEndpoints } from './neighborhood-helpers.mjs';
import { SHAPES, BUDGETS, SPACING, layoutFor, violations } from '../tests/helpers/layout-checks.mjs';

// Knobs that matter now that edges are drawn straight: how much arc every node
// is guaranteed, how far apart consecutive rings sit, and how far a node may
// wander in or out of its ring while the solver resolves overlaps.
const CANDIDATES = {
  minSeparation: [64, 76, 88],
  spacingScale: [1, 1.25],
  radialBand: [0.16, 0.26],
};

function anchorsFor(graph) {
  const busiest = graph.nodes
    .filter(node => node.type === 'band')
    .map(node => ({
      id: node.id,
      degree: graph.links.filter(link => linkEndpoints(link).includes(node.id)).length,
    }))
    .sort((a, b) => b.degree - a.degree)[0];
  const leaf = graph.nodes
    .filter(node => node.type === 'person' && node.id !== 'Aaron McRae')
    .slice(-1)[0];
  return ['Aaron McRae', busiest && busiest.id, leaf && leaf.id].filter(Boolean);
}

function evaluate(tuning) {
  let failures = 0;
  let worstCases = [];
  for (const build of Object.values(SHAPES)) {
    const graph = build();
    for (const anchorId of anchorsFor(graph)) {
      for (const budget of BUDGETS) {
        const laid = layoutFor(graph, anchorId, budget, tuning);
        if (!laid.view.nodes.length) continue;
        const found = violations(laid, anchorId);
        if (found.length) {
          failures += found.length;
          if (worstCases.length < 3) worstCases.push(found[0]);
        }
      }
    }
  }
  return { failures, worstCases };
}

const tuningFor = combo => ({
  layout: {
    minSeparation: combo.minSeparation,
    spacing: SPACING * combo.spacingScale,
    radialBand: combo.radialBand,
  },
});

if (process.argv.includes('--current')) {
  const result = evaluate({});
  console.log(`current defaults: ${result.failures} violation(s)`);
  result.worstCases.forEach(c => console.log(`  ${c}`));
  process.exit(result.failures ? 1 : 0);
}

const combos = [];
for (const minSeparation of CANDIDATES.minSeparation) {
  for (const spacingScale of CANDIDATES.spacingScale) {
    for (const radialBand of CANDIDATES.radialBand) {
      combos.push({ minSeparation, spacingScale, radialBand });
    }
  }
}

const scored = combos.map(combo => {
  const { failures, worstCases } = evaluate(tuningFor(combo));
  return { combo, failures, worstCases };
});
scored.sort((a, b) => a.failures - b.failures);

console.log(`swept ${scored.length} combinations\n`);
scored.slice(0, 12).forEach(({ combo, failures, worstCases }) => {
  const label = Object.entries(combo)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log(`${String(failures).padStart(4)} violations  ${label}`);
  if (failures && worstCases[0]) console.log(`               e.g. ${worstCases[0]}`);
});
const clean = scored.filter(entry => entry.failures === 0);
console.log(`\n${clean.length} clean combination(s)`);
