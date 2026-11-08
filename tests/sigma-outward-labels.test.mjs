// Geometry unit tests for Sigma outward labels (2026-11-07).
//
// outwardLabelBox() is the single source of truth for a label's box: the
// blocker measures with it, the custom label renderer draws with it, and
// drawHover() places its plate with it. These tests pin the geometry itself;
// the wiring (that all three call sites actually use the helper) is pinned
// in tests/sigma-explorer-wiring.test.mjs.
//
// Pure logic — no DOM, no sigma. The fake measureText charges 6px per
// character so every width is exact and deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { outwardLabelBox } from '../scripts/neighborhood-helpers.mjs';

const measureText = text => ({ width: text.length * 6 });
const LABEL = 'Fleetwood Mac'; // 13 chars -> 78px wide at the fake measure
const LABEL_SIZE = 12;
const NODE_SIZE = 8;

function boxAt(x, hubX, overrides = {}) {
  return outwardLabelBox({
    x,
    y: 200,
    nodeSize: NODE_SIZE,
    label: LABEL,
    hubX,
    labelSize: LABEL_SIZE,
    measureText,
    ...overrides,
  });
}

test('right of the hub: label starts at node.x + nodeSize + 3, Sigma default geometry', () => {
  const box = boxAt(500, 300);
  assert.equal(box.side, 'right');
  assert.equal(box.left, 500 + NODE_SIZE + 3);
  assert.equal(box.right, box.left + 78);
  // Baseline and vertical extent are Sigma's default draw exactly.
  assert.equal(box.baseline, 200 + LABEL_SIZE / 3);
  assert.equal(box.top, box.baseline - LABEL_SIZE * 0.78);
  assert.equal(box.bottom, box.baseline + LABEL_SIZE * 0.24);
});

test('left of the hub: label ends at node.x - nodeSize - 3', () => {
  const box = boxAt(100, 300);
  assert.equal(box.side, 'left');
  assert.equal(box.right, 100 - NODE_SIZE - 3);
  assert.equal(box.left, box.right - 78);
  assert.equal(box.baseline, 200 + LABEL_SIZE / 3);
  assert.equal(box.top, box.baseline - LABEL_SIZE * 0.78);
  assert.equal(box.bottom, box.baseline + LABEL_SIZE * 0.24);
});

test('the two sides are mirrors: same width, same 3px gap to the node', () => {
  const right = boxAt(500, 300);
  const left = boxAt(100, 300);
  assert.equal(right.right - right.left, left.right - left.left);
  assert.equal(right.left - 500, 100 - left.right); // both nodeSize + 3
  assert.equal(right.top, left.top);
  assert.equal(right.bottom, left.bottom);
});

test('tie under the hub reads right, and a missing hub reads right', () => {
  // The anchor node sits exactly under the hub, so it ties to the right —
  // the pre-outward behaviour — and a view with no anchor yet does the same.
  assert.equal(boxAt(300, 300).side, 'right');
  assert.equal(boxAt(100, null).side, 'right');
  assert.equal(boxAt(100, undefined).side, 'right');
});

test('the helper is pure: same inputs, same box', () => {
  assert.deepEqual(boxAt(100, 300), boxAt(100, 300));
  assert.deepEqual(boxAt(500, 300), boxAt(500, 300));
});

test('a longer label only moves the far edge, never the node-side edge', () => {
  const shortLeft = boxAt(100, 300, { label: 'AB' });
  const longLeft = boxAt(100, 300, { label: 'ABCDEFGHIJ' });
  assert.equal(shortLeft.right, longLeft.right); // node-side edge fixed
  assert.ok(longLeft.left < shortLeft.left); // far edge moves left
  const shortRight = boxAt(500, 300, { label: 'AB' });
  const longRight = boxAt(500, 300, { label: 'ABCDEFGHIJ' });
  assert.equal(shortRight.left, longRight.left); // node-side edge fixed
  assert.ok(longRight.right > shortRight.right);
});
