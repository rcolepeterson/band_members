// Solo Run backend tests: pair dealing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSoloPair } from '../netlify/functions/game_solo_play.mjs';
import { buildBandAdj, bfsDist } from '../netlify/functions/_daily.mjs';

// A linear chain of 8 bands: b0—b1—b2—b3—b4—b5—b6—b7 (each link = 1 hop).
// Memberships: band_i shares member m_i with band_{i+1}.
function linearGraph(n) {
  const memberships = [];
  for (let i = 0; i < n - 1; i++) {
    memberships.push({ band_id: `b${i}`, member_id: `m${i}` });
    memberships.push({ band_id: `b${i + 1}`, member_id: `m${i}` });
  }
  const { adj } = buildBandAdj(memberships);
  const bandIds = Array.from({ length: n }, (_, i) => `b${i}`);
  return { adj, bandIds };
}

test('honors the player band_a pick, deals band_b 3-5 hops away', () => {
  const { adj, bandIds } = linearGraph(8);
  for (let i = 0; i < 20; i++) {
    const pair = pickSoloPair({ adj, bandIds, bandA: 'b0' });
    assert.ok(pair, 'dealt a pair');
    assert.equal(pair.band_a, 'b0');
    const d = bfsDist(adj, 'b0').get(pair.band_b);
    assert.ok(d >= 3 && d <= 5, `band_b ${pair.band_b} is ${d} hops away`);
    assert.equal(pair.optimal_hops, d);
  }
});

test('deals both bands when the player picks nothing', () => {
  const { adj, bandIds } = linearGraph(8);
  for (let i = 0; i < 20; i++) {
    const pair = pickSoloPair({ adj, bandIds, bandA: null });
    assert.ok(pair, 'dealt a pair');
    assert.notEqual(pair.band_a, pair.band_b);
    const d = bfsDist(adj, pair.band_a).get(pair.band_b);
    assert.ok(d >= 3 && d <= 5, `pair is ${d} hops apart`);
  }
});

test('returns null when no fair pair exists', () => {
  // Two bands, one hop apart — nothing in the 3-5 window.
  const { adj, bandIds } = linearGraph(2);
  const pair = pickSoloPair({ adj, bandIds, bandA: 'b0' });
  assert.equal(pair, null);
});

test('ignores an unknown band_a and deals randomly instead', () => {
  const { adj, bandIds } = linearGraph(8);
  const pair = pickSoloPair({ adj, bandIds, bandA: 'nope' });
  assert.ok(pair, 'dealt a pair anyway');
  const d = bfsDist(adj, pair.band_a).get(pair.band_b);
  assert.ok(d >= 3 && d <= 5, `pair is ${d} hops apart`);
});
