// The role belongs to the membership, not to the person.
//
// Ben Weinman founded The Dillinger Escape Plan and joined Suicidal Tendencies
// as a player. One node cannot be a founder and a member at the same time, and
// classifyNode's single `kind` forced exactly that collapse — worse,
// `bandCount > 1` returned CONSTELLATION before role was ever consulted, so
// being in two bands erased the role outright. 123 people in the live graph hold
// genuinely different roles in different bands. Stone Gossard founded Brad,
// Mother Love Bone, Pearl Jam and Temple of the Dog but played in Citizen Dick
// and Gossman Project; every one of those rendered as the same purple dot.
//
// Two axes now, on two channels: `kind` answers how connected you are and drives
// size, `role` answers what you were and drives colour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Graph from 'graphology';
import {
  MEMBERSHIP_ROLES,
  MEMBERSHIP_WEIGHT,
  NODE_KINDS,
  roleFromMembership,
  strongestRole,
  roleForNode,
  toGraphologyGraph,
  classifyNode,
} from '../scripts/neighborhood-helpers.mjs';

const FOUNDER = MEMBERSHIP_ROLES.FOUNDER;
const MEMBER = MEMBERSHIP_ROLES.MEMBER;
const TOURING = MEMBERSHIP_ROLES.TOURING;

const member = (band, person, weight) => ({
  source: band, target: person, relation: 'member_of', weight,
});

// ---------------------------------------------------------------------------
// One membership
// ---------------------------------------------------------------------------

test('weight maps to role the way the add-band form says it does', () => {
  assert.equal(roleFromMembership(member('A', 'p', MEMBERSHIP_WEIGHT.FOUNDER)), FOUNDER);
  assert.equal(roleFromMembership(member('A', 'p', MEMBERSHIP_WEIGHT.MEMBER)), MEMBER);
  assert.equal(roleFromMembership(member('A', 'p', MEMBERSHIP_WEIGHT.TOURING)), TOURING);
});

test('a relation naming a short stint still reads as touring', () => {
  // Nothing in the live data populates relation this way, but an imported row
  // might, and it is the only role signal such a row would carry.
  assert.equal(
    roleFromMembership({ source: 'A', target: 'p', relation: 'session', weight: '' }),
    TOURING,
  );
});

test('an absent weight is a member, never an invented founder', () => {
  // normalizeNeonToRows defaults a null weight to '1', so "no weight recorded"
  // and "founder" arrive indistinguishable. Founder is a strict === 1 for that
  // reason: a missing or malformed weight must not manufacture a founding member.
  for (const weight of ['', null, undefined, 'abc', 0, -1]) {
    assert.equal(roleFromMembership(member('A', 'p', weight)), MEMBER, `weight ${weight}`);
  }
  assert.equal(roleFromMembership(null), MEMBER);
});

test('strongestRole prefers founder, then member, then touring', () => {
  assert.equal(strongestRole([member('A', 'p', 3), member('B', 'p', 1)]), FOUNDER);
  assert.equal(strongestRole([member('A', 'p', 3), member('B', 'p', 2)]), MEMBER);
  assert.equal(strongestRole([member('A', 'p', 3)]), TOURING);
  assert.equal(strongestRole([]), null);
});

// ---------------------------------------------------------------------------
// The Ben Weinman case
// ---------------------------------------------------------------------------

const BEN = 'Ben Weinman';
const DEP = 'The Dillinger Escape Plan';
const ST = 'Suicidal Tendencies';

const nodes = [
  { id: DEP, type: 'band' },
  { id: ST, type: 'band' },
  { id: BEN, type: 'person' },
];
const links = [
  member(DEP, BEN, MEMBERSHIP_WEIGHT.FOUNDER),
  member(ST, BEN, MEMBERSHIP_WEIGHT.MEMBER),
];

test('centred on Dillinger, Ben Weinman is a founder', () => {
  assert.equal(
    roleForNode({ id: BEN, type: 'person' }, { anchorId: DEP, links }),
    FOUNDER,
  );
});

test('centred on Suicidal Tendencies, the same node is a member', () => {
  assert.equal(
    roleForNode({ id: BEN, type: 'person' }, { anchorId: ST, links }),
    MEMBER,
  );
});

test('being in two bands no longer erases the role', () => {
  // The regression this exists for: classifyNode returns CONSTELLATION here, and
  // that used to be the only thing the renderer knew about him.
  assert.equal(
    classifyNode({ id: BEN, type: 'person' }, { anchorId: DEP, links }),
    NODE_KINDS.CONSTELLATION,
  );
  assert.equal(roleForNode({ id: BEN, type: 'person' }, { anchorId: DEP, links }), FOUNDER);
});

test('anchored on a band he is not in, the node shows his strongest role', () => {
  const other = [...links, member('Botch', 'Brian Cook', 1)];
  assert.equal(
    roleForNode({ id: BEN, type: 'person' }, { anchorId: 'Botch', links: other }),
    FOUNDER,
  );
});

test('anchored on himself, the node still shows his strongest role', () => {
  assert.equal(roleForNode({ id: BEN, type: 'person' }, { anchorId: BEN, links }), FOUNDER);
});

test('a band has no role of its own', () => {
  assert.equal(roleForNode({ id: DEP, type: 'band' }, { anchorId: DEP, links }), null);
});

test('a person with no memberships has no role', () => {
  assert.equal(roleForNode({ id: 'Nobody', type: 'person' }, { anchorId: DEP, links }), null);
});

// ---------------------------------------------------------------------------
// What the renderer actually receives
// ---------------------------------------------------------------------------

test('every edge carries its own role, in one graph, at one time', () => {
  // The half that survives the camera: the node can only show one role, but both
  // lines are simultaneously correct.
  const graph = toGraphologyGraph({ nodes, links }, Graph, { anchorId: DEP });
  assert.equal(graph.getEdgeAttribute(DEP, BEN, 'role'), FOUNDER);
  assert.equal(graph.getEdgeAttribute(ST, BEN, 'role'), MEMBER);
});

test('the node role follows the anchor between two renders of the same data', () => {
  const onDep = toGraphologyGraph({ nodes, links }, Graph, { anchorId: DEP });
  const onSt = toGraphologyGraph({ nodes, links }, Graph, { anchorId: ST });
  assert.equal(onDep.getNodeAttribute(BEN, 'role'), FOUNDER);
  assert.equal(onSt.getNodeAttribute(BEN, 'role'), MEMBER);
});

test('kind and role are both present, and independent', () => {
  const graph = toGraphologyGraph({ nodes, links }, Graph, { anchorId: DEP });
  assert.equal(graph.getNodeAttribute(BEN, 'kind'), NODE_KINDS.CONSTELLATION);
  assert.equal(graph.getNodeAttribute(BEN, 'role'), FOUNDER);
  // Bands keep their own identity on both axes.
  assert.equal(graph.getNodeAttribute(ST, 'kind'), NODE_KINDS.SOLAR_SYSTEM);
  assert.equal(graph.getNodeAttribute(ST, 'role'), null);
});

test('a touring player who passed through several bands reads as touring', () => {
  // The other half of the erasure: 13 multi-band people in the live graph have
  // touring stints, and CONSTELLATION hid every one of them.
  const hand = 'Session Player';
  const g = toGraphologyGraph({
    nodes: [{ id: 'A', type: 'band' }, { id: 'B', type: 'band' }, { id: hand, type: 'person' }],
    links: [member('A', hand, 3), member('B', hand, 3)],
  }, Graph, { anchorId: 'A' });
  assert.equal(g.getNodeAttribute(hand, 'kind'), NODE_KINDS.CONSTELLATION);
  assert.equal(g.getNodeAttribute(hand, 'role'), TOURING);
});

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const EXPLORER = readFileSync(new URL('../scripts/sigma-explorer.mjs', import.meta.url), 'utf8');

test('hue carries the role, and every role has a distinct one', () => {
  const block = EXPLORER.slice(EXPLORER.indexOf('const ROLE_STYLE'), EXPLORER.indexOf('const ROLE_EDGE_STYLE'));
  const hues = block.match(/#[0-9a-f]{6}/gi) || [];
  assert.equal(hues.length, 3, 'expected one colour per role');
  assert.equal(new Set(hues.map(h => h.toLowerCase())).size, 3, 'roles must not share a hue');
  // Bands keep cyan, so a person can never be mistaken for a band.
  assert.ok(!hues.map(h => h.toLowerCase()).includes('#8fe8f6'));
});

test('role drives colour and kind drives size, on separate channels', () => {
  const roleBlock = EXPLORER.slice(EXPLORER.indexOf('const ROLE_STYLE'), EXPLORER.indexOf('const ROLE_EDGE_STYLE'));
  assert.doesNotMatch(roleBlock, /size:/, 'ROLE_STYLE must not set size; kind owns size');
  const reduce = EXPLORER.slice(EXPLORER.indexOf('function reduceNode('), EXPLORER.indexOf('function reduceEdge('));
  assert.match(reduce, /ROLE_STYLE\[attrs\.role\]/);
  assert.match(reduce, /size: \(attrs\.size \|\| style\.size\)/);
});

test('edges are coloured per membership at rest', () => {
  const reduce = EXPLORER.slice(EXPLORER.indexOf('function reduceEdge('), EXPLORER.indexOf('// -- sizing'));
  assert.match(reduce, /ROLE_EDGE_STYLE\[attrs\.role\]/);
  // A highlight still wins: selection has to remain readable.
  assert.match(reduce, /state\.highlightEdges\.has\(edge\)/);
});
