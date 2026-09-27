// Tests for the Six Degrees game engine (scripts/six-degrees-game.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  shortestPath,
  bandHops,
  randomBand,
  pickFairPair,
} from '../scripts/six-degrees-game.mjs';

// Synthetic graph:
//   BandA -- Alice -- BandB -- Bob -- BandC
//   BandD (isolated, no members)
function toyPayload() {
  return {
    bands: [
      { id: 'a', name: 'BandA' },
      { id: 'b', name: 'BandB' },
      { id: 'c', name: 'BandC' },
      { id: 'd', name: 'BandD' },
    ],
    members: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    memberships: [
      { band_id: 'a', member_id: 'alice', relation: 'member_of' },
      { band_id: 'b', member_id: 'alice', relation: 'member_of' },
      { band_id: 'b', member_id: 'bob', relation: 'member_of' },
      { band_id: 'c', member_id: 'bob', relation: 'member_of' },
    ],
  };
}

test('shortestPath finds the direct 1-hop chain', () => {
  const g = buildGraph(toyPayload());
  const path = shortestPath(g, 'a', 'b');
  assert.deepEqual(path.map((n) => n.name), ['BandA', 'Alice', 'BandB']);
  assert.equal(bandHops(path), 1);
});

test('shortestPath finds the 2-hop chain through two members', () => {
  const g = buildGraph(toyPayload());
  const path = shortestPath(g, 'a', 'c');
  assert.deepEqual(path.map((n) => n.name), ['BandA', 'Alice', 'BandB', 'Bob', 'BandC']);
  assert.equal(bandHops(path), 2);
});

test('shortestPath returns null for unreachable bands', () => {
  const g = buildGraph(toyPayload());
  assert.equal(shortestPath(g, 'a', 'd'), null);
  assert.equal(bandHops(null), Infinity);
});

test('shortestPath handles a band to itself', () => {
  const g = buildGraph(toyPayload());
  const path = shortestPath(g, 'a', 'a');
  assert.deepEqual(path.map((n) => n.name), ['BandA']);
  assert.equal(bandHops(path), 0);
});

test('non-member_of relations are ignored', () => {
  const payload = toyPayload();
  payload.memberships.push({ band_id: 'a', member_id: 'bob', relation: 'produced' });
  const g = buildGraph(payload);
  const path = shortestPath(g, 'a', 'c');
  // Still 2 hops via Alice/BandB — the produced edge must not shortcut it.
  assert.equal(bandHops(path), 2);
});

test('randomBand returns a real band id', () => {
  const g = buildGraph(toyPayload());
  for (let i = 0; i < 20; i++) {
    assert.ok(g.bands.has(randomBand(g)));
  }
});

test('pickFairPair returns pairs within the hop window', () => {
  const g = buildGraph(toyPayload());
  const pair = pickFairPair(g, 1, 2, 200);
  assert.ok(pair);
  assert.equal(bandHops(pair.path), bandHops(shortestPath(g, pair.a, pair.b)));
  assert.ok(bandHops(pair.path) >= 1 && bandHops(pair.path) <= 2);
});

test('pickFairPair returns null when no pair fits', () => {
  const g = buildGraph(toyPayload());
  assert.equal(pickFairPair(g, 5, 6, 50), null);
});
