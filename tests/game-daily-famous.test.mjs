// Famous-band dailies (Cole/Paul, 2026-10-08): the daily pair's ends come
// from a headliner list, the shortest route must run through famous bands
// only, and the multiple-choice slate puts famous bands first.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bfsDist, pickDailyPair, optionsFor } from '../netlify/functions/_daily.mjs';
import { FAMOUS_BANDS, HEADLINER_BANDS, famousIdsFrom } from '../netlify/functions/_famous.mjs';

// A - B - C - D is all famous; A - x - y - D is an unknown route of the same
// length; z is an unknown dead-end candidate, F a famous one.
function graph(edges) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const [a, b] of edges) { add(a, b); add(b, a); }
  return adj;
}
const adj = graph([['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'x'], ['x', 'y'], ['y', 'D'], ['z', 'w'], ['F', 'G'], ['w', 'D'], ['G', 'D']]);
const famous = new Set(['A', 'B', 'C', 'D', 'F', 'G']);
const meta = new Map([...adj.keys()].map((id) => [id, { name: id, genre: 'Rock' }]));
const degree = new Map([...adj].map(([id, s]) => [id, s.size]));

test('bfsDist can walk famous bands only', () => {
  assert.equal(bfsDist(adj, 'D').get('A'), 3);
  assert.equal(bfsDist(adj, 'D', famous).get('A'), 3);
  assert.equal(bfsDist(adj, 'D', new Set(['A', 'D', 'x', 'y'])).get('B'), undefined);
});

test('pickDailyPair with requireWithin rejects pairs joined only by unknown bands', () => {
  const g = graph([['A', 'x'], ['x', 'y'], ['y', 'D']]);
  const pair = pickDailyPair({ bandIds: ['A', 'D'], adj: g, seed: 's', minHops: 3, maxHops: 3, requireWithin: famous });
  assert.equal(pair, null);
  const ok = pickDailyPair({ bandIds: ['A', 'D'], adj, seed: 's', minHops: 3, maxHops: 3, requireWithin: famous });
  assert.equal(ok.hops, 3);
});

test('slate prefers the famous right answer that keeps the famous route alive', () => {
  const dist = bfsDist(adj, 'D');
  for (let i = 0; i < 25; i++) {
    const opts = optionsFor({
      adj, dist, degree, meta, currentId: 'A',
      excludeIds: new Set(['D']), trapExcludeIds: new Set(['D']),
      preferIds: famous, preferDist: bfsDist(adj, 'D', famous), rng: Math.random,
    });
    const optimal = opts.filter((o) => o.kind === 'optimal').map((o) => o.band_id);
    assert.deepEqual(optimal, ['B'], 'B, not the unknown x');
    // Famous non-neighbors C, F, G exist, so every dead end is one of them.
    const traps = opts.filter((o) => o.kind === 'deadend').map((o) => o.band_id);
    assert.equal(traps.length, 3);
    assert.ok(traps.every((t) => famous.has(t)), `famous dead ends only, got ${traps}`);
  }
});

test('without preferIds the slate is unchanged (Solo still uses this path)', () => {
  const dist = bfsDist(adj, 'D');
  const opts = optionsFor({ adj, dist, degree, meta, currentId: 'A', excludeIds: new Set(['D']), trapExcludeIds: new Set(['D']) });
  const optimal = opts.filter((o) => o.kind === 'optimal').map((o) => o.band_id).sort();
  assert.deepEqual(optimal, ['B', 'x']);
});

test('headliners are a subset of the famous list, and names resolve case-insensitively', () => {
  const famousLower = new Set(FAMOUS_BANDS.map((n) => n.toLowerCase()));
  for (const h of HEADLINER_BANDS) assert.ok(famousLower.has(h.toLowerCase()), `${h} is also in FAMOUS_BANDS`);
  const m = new Map([['1', { name: 'NIRVANA' }], ['2', { name: 'Obscure Band' }], ['3', { name: 'Pearl Jam' }]]);
  const a = new Map([['1', new Set(['2'])], ['2', new Set(['1'])]]);
  assert.deepEqual([...famousIdsFrom(m, a)], ['1'], 'Pearl Jam has no links here, so it is skipped');
});

test('solo can deal a famous pair and plays it famous-first (practice mode)', async () => {
  const { readFileSync } = await import('node:fs');
  const solo = readFileSync(new URL('../netlify/functions/game_solo_play.mjs', import.meta.url), 'utf8');
  assert.match(solo, /body\.famous === true && !bandA/);
  assert.match(solo, /requireWithin: famous/);
  assert.match(solo, /preferIds: famousRun \? famous : null/);
  assert.match(solo, /excludeIds: new Set\(\[\.\.\.deadPicked, \.\.\.visited,/);
});
