// Bands the game never uses while the explorer keeps them (Cole, 2026-10-09).
// "Supergroup A" / "Supergroup B" are real (Ozzy's Back to the Beginning,
// 2025) but confusing as game options. See netlify/functions/_game_exclusions.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_GAME_EXCLUSIONS,
  loadGameExclusions,
  withoutExcludedBands,
} from '../netlify/functions/_game_exclusions.mjs';
import { loadBandGraph, clearGraphCache } from '../netlify/functions/game_daily.mjs';
import { bfsDist, bfsPath, optionsFor } from '../netlify/functions/_daily.mjs';

const SUPER_A = '2cd5781b-959e-484b-be78-a37b851357e3';
const SUPER_B = 'b6fd7968-b428-407f-aab8-62dfd122fe60';

// A tagged-template stand-in for the Neon client: answers by query text.
function fakeSql(tables, { missingExclusions = false, failExclusions = false } = {}) {
  return async (strings) => {
    const q = strings.join('?');
    if (q.includes('game_excluded_bands')) {
      if (failExclusions) throw new Error('connection reset');
      if (missingExclusions && q.startsWith('select')) {
        if (!tables.created) { const e = new Error('relation "game_excluded_bands" does not exist'); e.code = '42P01'; throw e; }
        return tables.excluded;
      }
      if (q.includes('create table')) { tables.created = true; return []; }
      if (q.includes('insert into')) return [];
      return tables.excluded;
    }
    if (q.includes('from memberships')) return tables.memberships;
    if (q.includes('from bands')) return tables.bands;
    if (q.includes('from band_members')) return tables.members;
    return [];
  };
}

// Pearl Jam and Black Sabbath share a musician only through Supergroup B;
// a real route goes the long way via Temple of the Dog and Soundgarden.
function tables(extraExcluded = []) {
  const m = (band_id, member_id) => ({ band_id, member_id });
  return {
    bands: [
      { id: 'pj', name: 'Pearl Jam' }, { id: 'sab', name: 'Black Sabbath' },
      { id: 'totd', name: 'Temple of the Dog' }, { id: 'sg', name: 'Soundgarden' },
      { id: SUPER_B, name: 'Supergroup B' }, { id: SUPER_A, name: 'Supergroup A' },
    ],
    members: [],
    memberships: [
      m('pj', 'eddie'), m(SUPER_B, 'eddie'), m(SUPER_B, 'tony'), m('sab', 'tony'),
      m(SUPER_A, 'tony'), m(SUPER_A, 'kim'),
      m('pj', 'stone'), m('totd', 'stone'), m('totd', 'chris'), m('sg', 'chris'),
      m('sg', 'kim'), m('sab', 'kim'),
    ],
    excluded: extraExcluded.map((band_id) => ({ band_id })),
  };
}

test('the exclusion list starts with Supergroup A and B', () => {
  assert.deepEqual(DEFAULT_GAME_EXCLUSIONS.map((e) => e.band_id).sort(), [SUPER_A, SUPER_B].sort());
});

test('excluded bands never appear in the game graph, options, routes or endpoints', async () => {
  clearGraphCache();
  const g = await loadBandGraph(fakeSql(tables()));
  clearGraphCache();
  for (const id of [SUPER_A, SUPER_B]) {
    assert.ok(!g.adj.has(id), `${id} is not in the game graph`);
    assert.ok(!g.bandIds.includes(id), `${id} can't be dealt as an endpoint`);
    for (const nbrs of g.adj.values()) assert.ok(!nbrs.has(id), 'no band links to it');
  }
  // The route goes the long way, not through Supergroup B.
  assert.deepEqual(bfsPath(g.adj, 'pj', 'sab'), ['pj', 'totd', 'sg', 'sab']);
  const dist = bfsDist(g.adj, 'sab');
  for (let i = 0; i < 50; i += 1) {
    const opts = optionsFor({ adj: g.adj, dist, degree: g.degree, meta: g.meta, currentId: 'pj' });
    for (const o of opts) assert.ok(![SUPER_A, SUPER_B].includes(o.band_id), 'never an option or a trap');
  }
});

test('the list grows from the table, no code change', async () => {
  clearGraphCache();
  const g = await loadBandGraph(fakeSql(tables(['totd'])));
  clearGraphCache();
  assert.ok(!g.adj.has('totd'));
  assert.equal(bfsPath(g.adj, 'pj', 'sab'), null, 'with Temple of the Dog out too, no route is left');
});

test('a missing table is created and seeded; a broken one falls back to the built-in list', async () => {
  const t = tables(['totd']);
  const ids = await loadGameExclusions(fakeSql(t, { missingExclusions: true }));
  assert.ok(t.created, 'table created on first use');
  assert.ok(ids.has(SUPER_A) && ids.has(SUPER_B) && ids.has('totd'));
  const fallback = await loadGameExclusions(fakeSql(tables(), { failExclusions: true }));
  assert.deepEqual([...fallback].sort(), [SUPER_A, SUPER_B].sort());
});

test('withoutExcludedBands only drops excluded bands\' memberships', () => {
  const rows = [{ band_id: 'pj' }, { band_id: SUPER_B }];
  assert.deepEqual(withoutExcludedBands(rows, new Set([SUPER_B])), [{ band_id: 'pj' }]);
  assert.equal(withoutExcludedBands(rows, new Set()), rows);
});

test('the explorer is untouched: /api/bands does not read the exclusion list', () => {
  const bandsApi = readFileSync(new URL('../netlify/functions/bands_neon.mjs', import.meta.url), 'utf8');
  assert.ok(!/game_excluded_bands|_game_exclusions/.test(bandsApi));
});

test('practice refuses an excluded band as its start', () => {
  const solo = readFileSync(new URL('../netlify/functions/game_solo_play.mjs', import.meta.url), 'utf8');
  assert.match(solo, /if \(excluded && excluded\.has\(String\(check\[0\]\.id\)\)\) return badRequest/);
});

test('Neon transfer: the game graph comes from the CDN-cached /api/game-graph, Neon only as fallback', async () => {
  const daily = readFileSync(new URL('../netlify/functions/game_daily.mjs', import.meta.url), 'utf8');
  assert.match(daily, /const rows = \(await fetchGameGraphRows\(\)\) \|\| \(await readGameGraphRows\(sql\)\);/);
  const endpoint = readFileSync(new URL('../netlify/functions/game_graph.mjs', import.meta.url), 'utf8');
  assert.match(endpoint, /path: '\/api\/game-graph'/);
  assert.match(endpoint, /'netlify-cdn-cache-control': 'public, max-age=3600/);
  // The CDN copy builds the same graph, exclusions included.
  const saved = { url: process.env.URL, fetch: globalThis.fetch };
  process.env.URL = 'https://example.test';
  globalThis.fetch = async (u) => ({
    ok: String(u) === 'https://example.test/api/game-graph',
    json: async () => ({
      ok: true,
      memberships: [['pj', 'eddie'], [SUPER_B, 'eddie'], [SUPER_B, 'tony'], ['sab', 'tony'], ['pj', 'stone'], ['totd', 'stone'], ['totd', 'chris'], ['sg', 'chris'], ['sg', 'kim'], ['sab', 'kim']],
      bands: [{ id: 'pj', name: 'Pearl Jam' }, { id: 'sab', name: 'Black Sabbath' }, { id: 'totd', name: 'Temple of the Dog' }, { id: 'sg', name: 'Soundgarden' }, { id: SUPER_B, name: 'Supergroup B' }],
      members: [],
      excluded: [SUPER_B],
    }),
  });
  try {
    clearGraphCache();
    const neverCalled = async () => { throw new Error('Neon should not be read'); };
    const g = await loadBandGraph(neverCalled);
    clearGraphCache();
    assert.ok(!g.adj.has(SUPER_B));
    assert.deepEqual(bfsPath(g.adj, 'pj', 'sab'), ['pj', 'totd', 'sg', 'sab']);
  } finally {
    if (saved.url === undefined) delete process.env.URL; else process.env.URL = saved.url;
    globalThis.fetch = saved.fetch;
  }
});
