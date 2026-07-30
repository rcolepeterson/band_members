// ---------------------------------------------------------------------------
// Label-overlap-at-settle metric. TEST/DEV ONLY -- deliberately not part of
// the page runtime and not imported by index.html or scripts/.
//
// Why this exists: ticks-to-settle is the wrong way to baseline the force
// layout. Forces are indifferent to font size, so a wall-clock/tick-count
// baseline shows no regression even when a label-size change visibly degrades
// the layout (this is why PR D's larger labels could ship without tripping any
// perf guard). What actually degrades is *readability*: how many node labels
// end up sitting on top of each other once the layout has settled.
//
// So: run a layout, then count pairs of nodes whose rendered label boxes
// overlap. That number is comparable across PRs and is sensitive to exactly
// the things that matter here -- collide radius, link distance, charge, and
// label geometry.
//
// Geometry mirrors the SVG in index.html's renderGraph(): the label is a
// <text> anchored at (getNodeOuterRadius(d) + LABEL_PAD_X, LABEL_BASELINE_Y)
// relative to the node's translate(), extending rightwards.
// ---------------------------------------------------------------------------

export const LABEL_PAD_X = 6;
export const LABEL_BASELINE_Y = 4;

// Fraction of the font size above / below the baseline that a line of text
// actually occupies. Approximates ascent/descent for the page's sans stack;
// exact values don't matter as long as they stay fixed across measurements.
const ASCENT = 0.8;
const DESCENT = 0.2;

// Absolute bounding box of one node's label. `node` needs x, y, labelWidth,
// labelHeight and either labelOffsetX or outerRadius.
export function labelBox(node) {
  const offsetX = Number.isFinite(node.labelOffsetX)
    ? node.labelOffsetX
    : (node.outerRadius || 0) + LABEL_PAD_X;
  const height = node.labelHeight || 0;
  const baseline = node.y + LABEL_BASELINE_Y;
  return {
    id: node.id,
    x0: node.x + offsetX,
    x1: node.x + offsetX + (node.labelWidth || 0),
    y0: baseline - height * ASCENT,
    y1: baseline + height * DESCENT,
  };
}

function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Counts unordered pairs of nodes whose label boxes intersect after a layout
// has settled. Nodes with an empty label (labelWidth 0) are ignored.
//
// Implemented as a sort-and-sweep on x so this stays usable on the full
// ~3,200-node graph rather than only on test-sized ones.
export function countLabelOverlaps(nodes) {
  const boxes = nodes
    .filter(d => Number.isFinite(d.x) && Number.isFinite(d.y) && (d.labelWidth || 0) > 0)
    .map(labelBox)
    .sort((a, b) => a.x0 - b.x0);

  let pairs = 0;
  const overlapping = new Set();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j].x0 < boxes[i].x1; j++) {
      if (!boxesOverlap(boxes[i], boxes[j])) continue;
      pairs++;
      overlapping.add(boxes[i].id);
      overlapping.add(boxes[j].id);
    }
  }

  return {
    pairs,
    labelledNodes: boxes.length,
    nodesInvolved: overlapping.size,
    // Overlapping pairs per labelled node -- the comparable figure across
    // datasets of different sizes.
    pairsPerNode: boxes.length ? pairs / boxes.length : 0,
  };
}

// Overall extent of the laid-out graph. Useful alongside the overlap count:
// a layout can trivially reduce overlaps by sprawling, and sprawl is the
// "stretched out in a weird direction" failure mode, so the two want to be
// read together.
export function layoutExtent(nodes) {
  const positioned = nodes.filter(d => Number.isFinite(d.x) && Number.isFinite(d.y));
  if (!positioned.length) return { width: 0, height: 0, aspect: 1 };
  const xs = positioned.map(d => d.x);
  const ys = positioned.map(d => d.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return { width, height, aspect: short ? long / short : Infinity };
}
