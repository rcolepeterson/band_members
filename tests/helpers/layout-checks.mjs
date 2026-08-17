// ---------------------------------------------------------------------------
// Shared machinery for the layout quality gate.
//
// Used by tests/layout-invariants.test.mjs (the CI gate) and by
// scripts/layout-tune.mjs (the parameter sweep), so the properties being
// asserted and the properties being tuned for can never drift apart.
//
// Graph SHAPES here exist because they each broke something real, or because
// they are shapes the live data actually takes. Add a shape whenever a new
// layout bug is reported: that is how the bug stops coming back.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  getNeighborhood,
  radialLayout,
  straightDistance,
  linkEndpoints,
  NEIGHBORHOOD_BUDGET,
} from '../../scripts/neighborhood-helpers.mjs';

// A trimmed snapshot of the real graph: the multi-hop neighbourhoods of a few
// anchors that produced layout bug reports. Synthetic shapes are useful because
// they are extreme; this one is useful because it is REAL -- the live data has
// lopsided, cross-linked structures no hand-written fixture thought to include.
// Refresh it by re-running the capture documented in scripts/README.md.
const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_SAMPLE = JSON.parse(
  readFileSync(join(HERE, '..', 'fixtures', 'live-graph-sample.json'), 'utf8')
);

export const SPACING = 190;
export const MIN_SEPARATION = 76;
// A node must clear an unrelated edge by at least this much, in layout units.
//
// Division of responsibility, worth being explicit about:
//
//   THIS FILE guarantees geometry that the layout controls absolutely --
//   completeness, node separation, ring order, determinism, and that no edge
//   runs through the middle of a node. It runs in CI in seconds.
//
//   scripts/layout-audit.mjs is the authority on how it LOOKS, because only a
//   rendered page knows real node radii, density scaling and camera framing. It
//   needs a browser, so it is a manual/release gate rather than a CI one.
//
// The threshold here is therefore a "not misleading" one, not an aesthetic one:
// a musician in eight bands cannot be drawn adjacent to all eight, so some
// near-misses are unavoidable in any 2D drawing of a non-planar graph. What must
// never happen is an edge passing through a node, which reads as a membership
// that does not exist.
// Thresholds are derived from the drawn node radius rather than picked by feel.
//
// framingRatio() guarantees that minSeparation of arc is worth at least
// (2 * maxNodeSize + gap) pixels on screen, so one layout unit is worth at least
// minSeparation / (2 * maxNodeSize + gap) pixels, and a node of radius
// maxNodeSize covers about this many layout units:
// ...at the density floor the renderer actually draws dense views at (0.6 of the
// designed size, see densitySizeScale), which is where these near-misses occur.
const NODE_RADIUS_UNITS = (MIN_SEPARATION * 13 * 0.6) / (2 * 13 + 10);
// HARD: an edge closer than a node's own radius is running through the node,
// which invents a membership. Never acceptable.
export const EDGE_CLEARANCE_HARD = NODE_RADIUS_UNITS;
// SOFT: within half a radius beyond that is a tight near-miss -- cosmetically
// imperfect, not misleading.
export const EDGE_CLEARANCE_SOFT = NODE_RADIUS_UNITS * 1.6;
// A few near-misses per view are inherent to drawing a non-planar graph; a
// picture full of them is a regression.
export const SOFT_BUDGET = 4;
// The anchor gets a stricter rule: it is the node every visitor is looking at,
// and chooseEdgeCurvatures is told to protect it explicitly.
export const ANCHOR_CLEARANCE = MIN_SEPARATION / 2;

export const SHAPES = {
  // One musician, a handful of bands, a few members each: the opening view.
  smallScene() {
    const nodes = [{ id: 'Aaron McRae', type: 'person' }];
    const links = [];
    ['Ka-Chunk', 'The Protocol', 'Camp Hero', 'Sweet Water', 'SGM'].forEach((band, b) => {
      nodes.push({ id: band, type: 'band' });
      links.push({ source: band, target: 'Aaron McRae', relation: 'member' });
      for (let m = 0; m < 3 + (b % 3); m += 1) {
        const id = `${band} member ${m}`;
        nodes.push({ id, type: 'person' });
        links.push({ source: band, target: id, relation: 'member' });
      }
    });
    return { nodes, links };
  },

  // A hub band with far more members than fit on one ring: the "beads on a
  // wire" and sub-ring cases.
  wideHub() {
    const nodes = [{ id: 'Aaron McRae', type: 'person' }, { id: 'Hub Band', type: 'band' }];
    const links = [{ source: 'Hub Band', target: 'Aaron McRae', relation: 'member' }];
    for (let m = 0; m < 45; m += 1) {
      const id = `Member ${String(m).padStart(2, '0')}`;
      nodes.push({ id, type: 'person' });
      links.push({ source: 'Hub Band', target: id, relation: 'member' });
    }
    return { nodes, links };
  },

  // A long chain of bands linked by shared members: the deep case that made
  // recursive wedge nesting collapse.
  deepChain({ bands = 30, perBand = 12 } = {}) {
    const nodes = [{ id: 'Aaron McRae', type: 'person' }];
    const links = [];
    for (let b = 0; b < bands; b += 1) {
      const band = `Band ${String(b).padStart(2, '0')}`;
      nodes.push({ id: band, type: 'band' });
      for (let m = 0; m < perBand; m += 1) {
        const id = `Member ${b}-${m}`;
        nodes.push({ id, type: 'person' });
        links.push({ source: band, target: id, relation: 'member' });
        if (m === 0 && b > 0) {
          links.push({ source: `Band ${String(b - 1).padStart(2, '0')}`, target: id, relation: 'member' });
        }
      }
    }
    links.push({ source: 'Band 00', target: 'Aaron McRae', relation: 'member' });
    return { nodes, links };
  },

  // Lopsided: one enormous branch beside several tiny ones. This is what
  // starved leaf nodes of arc when shares were purely weight-proportional.
  lopsided() {
    const nodes = [{ id: 'Aaron McRae', type: 'person' }];
    const links = [];
    ['Tiny One', 'Tiny Two', 'Tiny Three'].forEach(band => {
      nodes.push({ id: band, type: 'band' });
      links.push({ source: band, target: 'Aaron McRae', relation: 'member' });
      nodes.push({ id: `${band} solo`, type: 'person' });
      links.push({ source: band, target: `${band} solo`, relation: 'member' });
    });
    nodes.push({ id: 'Big Band', type: 'band' });
    links.push({ source: 'Big Band', target: 'Aaron McRae', relation: 'member' });
    for (let m = 0; m < 25; m += 1) {
      const id = `Big member ${String(m).padStart(2, '0')}`;
      nodes.push({ id, type: 'person' });
      links.push({ source: 'Big Band', target: id, relation: 'member' });
      // Half of them are also in a side project: plenty of non-tree chords.
      if (m % 2 === 0) {
        const side = `Side Project ${m}`;
        nodes.push({ id: side, type: 'band' });
        links.push({ source: side, target: id, relation: 'member' });
      }
    }
    return { nodes, links };
  },

  // Dense cross-linking: everyone plays with everyone. Worst case for chords
  // passing over nodes.
  incestuousScene() {
    const nodes = [];
    const links = [];
    const bands = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
    const people = Array.from({ length: 14 }, (_, i) => `Player ${String(i).padStart(2, '0')}`);
    bands.forEach(band => nodes.push({ id: band, type: 'band' }));
    people.forEach(person => nodes.push({ id: person, type: 'person' }));
    people.forEach((person, i) => {
      bands.forEach((band, b) => {
        if ((i + b) % 3 === 0) links.push({ source: band, target: person, relation: 'member' });
      });
    });
    nodes.push({ id: 'Aaron McRae', type: 'person' });
    links.push({ source: 'Alpha', target: 'Aaron McRae', relation: 'member' });
    links.push({ source: 'Delta', target: 'Aaron McRae', relation: 'member' });
    return { nodes, links };
  },

  // Degenerate shapes that must not throw.
  soloAct() {
    return {
      nodes: [{ id: 'Aaron McRae', type: 'person' }, { id: 'Only Band', type: 'band' }],
      links: [{ source: 'Only Band', target: 'Aaron McRae', relation: 'member' }],
    };
  },

  // Real data.
  liveSample() {
    return LIVE_SAMPLE;
  },

  singleChain() {
    const nodes = [{ id: 'Aaron McRae', type: 'person' }];
    const links = [];
    let previous = 'Aaron McRae';
    for (let i = 0; i < 8; i += 1) {
      const band = `Chain Band ${i}`;
      const person = `Chain Person ${i}`;
      nodes.push({ id: band, type: 'band' }, { id: person, type: 'person' });
      links.push({ source: band, target: previous, relation: 'member' });
      links.push({ source: band, target: person, relation: 'member' });
      previous = person;
    }
    return { nodes, links };
  },
};

// The budget combinations a user can actually reach: opening view, expanded
// view, and the deliberate expand steps beyond it.
export const BUDGETS = [
  { maxHops: 3, maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES },
  { maxHops: 3, maxNodes: NEIGHBORHOOD_BUDGET.MAX_NODES },
  { maxHops: 4, maxNodes: 160 },
  { maxHops: 5, maxNodes: 220 },
  { maxHops: 6, maxNodes: NEIGHBORHOOD_BUDGET.EXPAND_MAX_NODES },
];

// ---------------------------------------------------------------------------
// Property checks
// ---------------------------------------------------------------------------

// `tuning` lets scripts/layout-tune.mjs sweep layout parameters against the
// exact same checks the CI gate uses.
export function layoutFor(graph, anchorId, budget, tuning = {}) {
  const view = getNeighborhood({ nodes: graph.nodes, links: graph.links, anchorId, ...budget });
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId,
    depths: view.depths,
    spacing: SPACING,
    minSeparation: MIN_SEPARATION,
    ...tuning.layout,
  });
  // Edges are drawn straight, so clearance is simply point-to-segment distance.
  return { view, positions };
}

export function violations({ view, positions }, anchorId) {
  const found = [];
  const soft = [];

  // 1. Completeness
  view.nodes.forEach(node => {
    if (!positions.has(node.id)) found.push(`unpositioned: ${node.id}`);
  });

  // 2 + 3. Distinctness and separation
  const entries = Array.from(positions.entries());
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance === 0) found.push(`same coordinates: ${idA} / ${idB}`);
      else if (distance < MIN_SEPARATION * 0.5) {
        found.push(`too close (${distance.toFixed(1)}): ${idA} / ${idB}`);
      }
    }
  }

  // 4. Edge clearance, against the drawn curve.
  const incident = new Map(view.nodes.map(node => [node.id, new Set()]));
  view.links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    if (incident.has(source)) incident.get(source).add(link);
    if (incident.has(target)) incident.get(target).add(link);
  });
  view.nodes.forEach(node => {
    const point = positions.get(node.id);
    if (!point) return;
    view.links.forEach(link => {
      if (incident.get(node.id).has(link)) return;
      const [source, target] = linkEndpoints(link);
      const a = positions.get(source);
      const b = positions.get(target);
      if (!a || !b) return;
      const clearance = straightDistance(point, a, b);
      const message = `${node.id} sits ${clearance.toFixed(1)} from ${source} -- ${target}`;
      if (clearance < EDGE_CLEARANCE_HARD) found.push(message);
      else if (clearance < EDGE_CLEARANCE_SOFT) soft.push(message);
      // 6. Locality: nothing unrelated may cross the anchor at the centre.
      if (node.id === anchorId && clearance < ANCHOR_CLEARANCE) {
        found.push(`${source} -- ${target} crosses the anchor`);
      }
    });
  });

  // 5. Ring order
  const radiiByHop = new Map();
  view.nodes.forEach(node => {
    const point = positions.get(node.id);
    if (!point) return;
    if (!radiiByHop.has(point.hop)) radiiByHop.set(point.hop, []);
    radiiByHop.get(point.hop).push(Math.hypot(point.x, point.y));
  });
  const radiusByHop = new Map(
    Array.from(radiiByHop.entries()).map(([hop, radii]) => {
      const sorted = radii.slice().sort((a, b) => a - b);
      return [hop, { median: sorted[Math.floor(sorted.length / 2)] }];
    })
  );
  // Compared on MEDIANS, not extremes. The layout is deliberately a scattered
  // constellation rather than concentric rings, so an individual node may sit
  // slightly inside or outside its neighbours' band; what must hold is that each
  // degree of separation reads as further out on average.
  const hops = Array.from(radiusByHop.keys()).sort((a, b) => a - b);
  for (let i = 1; i < hops.length; i += 1) {
    const inner = radiusByHop.get(hops[i - 1]);
    const outer = radiusByHop.get(hops[i]);
    if (outer.median <= inner.median) {
      found.push(`hop ${hops[i]} does not read as further out than hop ${hops[i - 1]}`);
    }
  }

  // Too many near-misses at once is itself a regression, even though any single
  // one is tolerable.
  if (soft.length > SOFT_BUDGET) {
    found.push(`${soft.length} tight near-misses (budget ${SOFT_BUDGET}): ${soft[0]}`);
  }

  return found;
}

