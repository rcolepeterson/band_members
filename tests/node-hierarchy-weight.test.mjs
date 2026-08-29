// The node hierarchy must read the column the role is actually stored in.
//
// WHY THIS EXISTS
//
// classifyNode decided "moon" (a short-term player: touring, session, guest) by
// testing link.relation against MOON_RELATIONS. Nothing in the live data has
// ever populated that field with those words — every membership row, in the
// original CSV export and in Postgres alike, carries relation = 'member_of'.
//
// So `memberships.every(...)` was never true, no node was ever classified a
// moon, and the touring tier silently vanished when the renderer moved from SVG
// to Sigma. The pre-Sigma renderer had drawn the distinction correctly, because
// it read `weight` — different radius, fill, stroke and colour per weight. The
// data was there the whole time, in the column nobody was reading: 492
// memberships at weight 1 and 60 at weight 3 in production.
//
// This is the failure mode worth testing for: not a crash, but a whole visual
// tier quietly collapsing into another one while every test still passed.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyNode,
  buildAdjacency,
  isShortTermMembership,
  MEMBERSHIP_WEIGHT,
  MOON_RELATIONS,
  NODE_KINDS,
} from '../scripts/neighborhood-helpers.mjs';

// A person in one band only, so the weight tier is what decides their kind.
// Anyone in two or more bands is a constellation regardless of role.
function graphWith(weight, relation = 'member_of') {
  const nodes = [
    { id: 'Some Band', type: 'band' },
    { id: 'One Player', type: 'person' },
    { id: 'Other Player', type: 'person' },
  ];
  const links = [
    { source: 'Some Band', target: 'One Player', weight, relation },
    { source: 'Some Band', target: 'Other Player', weight: 2, relation: 'member_of' },
  ];
  return { nodes, links, adjacency: buildAdjacency(nodes, links) };
}

function kindOf(weight, relation) {
  const { nodes, links, adjacency } = graphWith(weight, relation);
  return classifyNode(nodes[1], { adjacency, links });
}

// -----------------------------------------------------------------------
// The regression itself.
// -----------------------------------------------------------------------

test('a touring member is a moon even though relation says member_of', () => {
  // The exact shape of every row in production. Before the fix this returned
  // PLANET, which is why the touring tier was invisible.
  assert.equal(kindOf(3, 'member_of'), NODE_KINDS.MOON);
});

test('a founder and a plain member are both planets, not moons', () => {
  assert.equal(kindOf(1, 'member_of'), NODE_KINDS.PLANET);
  assert.equal(kindOf(2, 'member_of'), NODE_KINDS.PLANET);
});

test('the weight tiers match the values the add-band form writes', () => {
  // index.html's "Member weight" select offers exactly 1/2/3 with these
  // meanings. If they ever drift apart, the graph starts lying about roles.
  assert.equal(MEMBERSHIP_WEIGHT.FOUNDER, 1);
  assert.equal(MEMBERSHIP_WEIGHT.MEMBER, 2);
  assert.equal(MEMBERSHIP_WEIGHT.TOURING, 3);
});

// -----------------------------------------------------------------------
// The fallback still works for data that predates or bypasses weight.
// -----------------------------------------------------------------------

test('relation wording is still honoured when no weight is present', () => {
  for (const relation of MOON_RELATIONS) {
    assert.equal(
      isShortTermMembership({ relation }),
      true,
      `Expected relation "${relation}" to read as short-term when weight is absent.`
    );
  }
});

test('either signal alone is enough, because both have lossy defaults', () => {
  // Weight cannot be the only source of truth: normalizeNeonToRows defaults a
  // null weight to '1', so "nothing recorded" and "founder" arrive identical.
  // A weight-first rule would read this row — an import carrying its role in
  // the relation and no weight at all — as a founding member.
  assert.equal(isShortTermMembership({ weight: 1, relation: 'touring' }), true);
  // And relation cannot be the only source of truth either: that is the bug
  // this whole file exists for, since every production row says 'member_of'.
  assert.equal(isShortTermMembership({ weight: 3, relation: 'member_of' }), true);
  // Neither signal present: a permanent seat.
  assert.equal(isShortTermMembership({ weight: 1, relation: 'member_of' }), false);
});

test('unusable weights fall through to the relation instead of guessing', () => {
  for (const weight of [null, undefined, '', 0, NaN, 'unknown']) {
    assert.equal(
      isShortTermMembership({ weight, relation: 'session' }),
      true,
      `Expected weight ${JSON.stringify(weight)} to fall back to the relation.`
    );
    assert.equal(
      isShortTermMembership({ weight, relation: 'member_of' }),
      false,
      `Expected weight ${JSON.stringify(weight)} with a plain relation to stay a planet.`
    );
  }
});

test('a string weight from the API payload is read as a number', () => {
  // normalizeNeonToRows stringifies it: weight: String(membership.weight).
  // A strict === 3 comparison would silently fail on every live row.
  assert.equal(isShortTermMembership({ weight: '3', relation: 'member_of' }), true);
  assert.equal(isShortTermMembership({ weight: '1', relation: 'member_of' }), false);
});

test('a missing link does not throw', () => {
  assert.equal(isShortTermMembership(null), false);
  assert.equal(isShortTermMembership(undefined), false);
});

// -----------------------------------------------------------------------
// Tiers that must not be disturbed by the change.
// -----------------------------------------------------------------------

test('a touring player in two bands is still a constellation', () => {
  // Being a bridge between bands outranks the role held in either of them:
  // that is what makes six-degrees paths work.
  const nodes = [
    { id: 'Band A', type: 'band' },
    { id: 'Band B', type: 'band' },
    { id: 'Hired Hand', type: 'person' },
  ];
  const links = [
    { source: 'Band A', target: 'Hired Hand', weight: 3, relation: 'member_of' },
    { source: 'Band B', target: 'Hired Hand', weight: 3, relation: 'member_of' },
  ];
  assert.equal(
    classifyNode(nodes[2], { adjacency: buildAdjacency(nodes, links), links }),
    NODE_KINDS.CONSTELLATION
  );
});

test('a mixed player who is permanent somewhere is a planet, not a moon', () => {
  // every() semantics: only someone whose EVERY membership is short-term
  // orbits. One real seat in one band makes them a planet.
  const nodes = [
    { id: 'Band A', type: 'band' },
    { id: 'Mixed Player', type: 'person' },
  ];
  const links = [
    { source: 'Band A', target: 'Mixed Player', weight: 3, relation: 'member_of' },
    { source: 'Band A', target: 'Mixed Player', weight: 1, relation: 'member_of' },
  ];
  assert.equal(
    classifyNode(nodes[1], { adjacency: buildAdjacency(nodes, links), links }),
    NODE_KINDS.PLANET
  );
});

test('the anchor and bands keep their own kinds', () => {
  const { nodes, links, adjacency } = graphWith(3);
  assert.equal(classifyNode(nodes[1], { anchorId: 'One Player', adjacency, links }), NODE_KINDS.HOME_STAR);
  assert.equal(classifyNode(nodes[0], { adjacency, links }), NODE_KINDS.SOLAR_SYSTEM);
});

test('a person with no memberships is still an asteroid', () => {
  const nodes = [{ id: 'Orphan', type: 'person' }];
  assert.equal(
    classifyNode(nodes[0], { adjacency: buildAdjacency(nodes, []), links: [] }),
    NODE_KINDS.ASTEROID
  );
});
