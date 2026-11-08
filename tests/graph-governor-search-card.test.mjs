// Tests for the graph governor SEARCH + CARD + GROUPS half:
//   netlify/functions/graph-search.mjs
//   netlify/functions/graph-card.mjs
//   netlify/functions/graph-groups.mjs
//
// All tests run against in-memory mocks — no live DB, no Blobs, no network
// — following the _graph_cache.mjs testable pattern (sql/store passed as
// parameters). The mock sql tag routes on the query template text and the
// bound parameter (values[0]), like the real Neon tag binds ${} values.
//
// Covered (per the governor contract):
//   search: results carry ONLY the allowed fields (asserted on rows that DO
//     carry bio/links/memberships/popularity_score/genre/label/albums);
//     matching is case-insensitive and id-aware; limit clamp (1..50,
//     default 20); empty q -> 400 shape; Blobs cache hit skips the Neon
//     UNION query; Blob read failure falls back to Neon.
//   card: band returns entity + its memberships + its links only (no other
//     bands); member returns entity + its bands only; plain-name fallback
//     resolves to the matched id; unknown id -> 404; bad type / missing
//     id -> 400.
//   groups: output entries are anchors+counts only (no member lists);
//     sorted nodeCount desc then anchorId asc; anchor is busiest with ties
//     by id asc; same input -> same output (including shuffled input);
//     handler serves the Blobs copy on repeat calls and prefers the
//     api-bands Blobs copy over Neon ids-only queries.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_RESULT_FIELDS,
  parseSearchLimit,
  searchNames,
  handleGraphSearch,
} from '../netlify/functions/graph-search.mjs';
import { handleGraphCard } from '../netlify/functions/graph-card.mjs';
import {
  buildGroupsSummary,
  groupsFromApiBandsPayload,
  handleGraphGroups,
} from '../netlify/functions/graph-groups.mjs';
import {
  GAME_TABLES,
  blobKeyFor,
  getDataVersion,
} from '../netlify/functions/_graph_cache.mjs';

// --- Fixtures ---------------------------------------------------------------

const BAND = {
  id: 'band-uuid-1', name: 'Sweet Water', city: 'Seattle', state: 'WA', country: 'US',
  genre: 'Alternative', years_active: '1990-', label: 'Indie', albums: 'Superstar',
  bio: 'Seattle band bio.', created_at: '2026-01-01T00:00:00.000Z', added_by: 'user-1',
};
const OTHER_BAND = {
  id: 'band-uuid-2', name: 'Candlebox', city: 'Seattle', state: 'WA', country: 'US',
  genre: 'Rock', years_active: '1990-', label: 'Major', albums: 'Candlebox',
  bio: 'Other band bio.', created_at: '2026-01-01T00:00:00.000Z', added_by: 'user-2',
};
const MEMBER1 = {
  id: 'member-uuid-1', name: 'Cole Peterson', city: 'Seattle', state: 'WA', country: 'US',
  instrument1: 'Bass', instrument2: null, years_active: '1990-', bio: 'Bassist.',
  popularity_score: 42,
};
const MEMBER2 = {
  id: 'member-uuid-2', name: 'Paul Uhlir', city: 'Seattle', state: 'WA', country: 'US',
  instrument1: 'Drums', instrument2: null, years_active: '1990-', bio: 'Drummer.',
  popularity_score: 40,
};
const OTHER_MEMBER = {
  id: 'member-uuid-9', name: 'Someone Else', city: 'Portland', state: 'OR', country: 'US',
  instrument1: 'Guitar', instrument2: null, years_active: '2000-', bio: 'Unrelated.',
  popularity_score: 1,
};
const BAND_MEMBERSHIPS = [
  { id: 101, member_id: MEMBER1.id, tenure: '1990-', weight: 1, relation: 'member_of' },
  { id: 102, member_id: MEMBER2.id, tenure: '1990-1997', weight: 2, relation: 'member_of' },
];
const MEMBER1_BANDS = [
  { band_id: BAND.id, tenure: '1990-', weight: 1, relation: 'member_of' },
];
const BAND_LINKS = [
  { platform: 'spotify', url: 'https://open.spotify.com/artist/sweetwater' },
  { platform: 'website', url: 'https://example.com/sweetwater' },
];

// Names payload rows for search: one row deliberately carries every
// forbidden field, so the allowlist test is meaningful.
function namesRows() {
  const rows = [
    {
      ...BAND, type: 'band',
      links: BAND_LINKS, memberships: BAND_MEMBERSHIPS,
      popularity_score: 99,
    },
    {
      ...MEMBER1, type: 'member',
      links: BAND_LINKS, memberships: MEMBER1_BANDS,
    },
    // City-suffixed id differs from the plain name: id-aware matching.
    {
      id: 'Skid Row (Aberdeen)', name: 'Skid Row', city: 'Aberdeen',
      state: 'WA', country: 'US', type: 'band',
    },
  ];
  for (let i = 1; i <= 60; i += 1) {
    rows.push({
      id: `test-band-${i}`, name: `Test Band ${String(i).padStart(2, '0')}`,
      city: 'Seattle', state: 'WA', country: 'US', type: 'band',
    });
  }
  return rows;
}

// --- Mocks ------------------------------------------------------------------

function makeMockSql() {
  const calls = [];
  const tag = (strings, ...values) => {
    const text = strings.join(' ');
    calls.push(text);
    const param = values[0];
    if (/alter table/i.test(text)) return Promise.resolve([]);
    if (/max\(updated_at\)/i.test(text)) {
      return Promise.resolve([{ max_updated: new Date('2026-10-10T12:00:00Z'), n: '10' }]);
    }
    if (/union all/i.test(text)) return Promise.resolve(namesRows());
    // Card: name-list lookups (id = any(...)) before single-row lookups.
    if (/from band_members/i.test(text) && /id = any/i.test(text)) {
      return Promise.resolve([MEMBER1, MEMBER2].map((m) => ({ id: m.id, name: m.name, instrument1: m.instrument1, instrument2: m.instrument2 })));
    }
    if (/from bands/i.test(text) && /id = any/i.test(text)) {
      return Promise.resolve([{ id: BAND.id, name: BAND.name }]);
    }
    if (/from band_members/i.test(text) && /where id =/i.test(text)) {
      return Promise.resolve(param === MEMBER1.id ? [MEMBER1] : param === MEMBER2.id ? [MEMBER2] : []);
    }
    if (/from band_members/i.test(text) && /where name =/i.test(text)) {
      return Promise.resolve(
        param === MEMBER1.name ? [MEMBER1] : param === MEMBER2.name ? [MEMBER2] : [],
      );
    }
    if (/from bands/i.test(text) && /where id =/i.test(text)) {
      return Promise.resolve(param === BAND.id ? [BAND] : param === OTHER_BAND.id ? [OTHER_BAND] : []);
    }
    if (/from bands/i.test(text) && /where name =/i.test(text)) {
      return Promise.resolve(param === BAND.name ? [BAND] : param === OTHER_BAND.name ? [OTHER_BAND] : []);
    }
    if (/from memberships/i.test(text) && /where band_id =/i.test(text)) {
      return Promise.resolve(param === BAND.id ? BAND_MEMBERSHIPS : []);
    }
    if (/from memberships/i.test(text) && /where member_id =/i.test(text)) {
      return Promise.resolve(param === MEMBER1.id ? MEMBER1_BANDS : []);
    }
    if (/from band_links/i.test(text)) {
      return Promise.resolve(param === BAND.id ? BAND_LINKS : []);
    }
    // Groups Neon fallback: ids only.
    if (/select id from bands/i.test(text)) {
      return Promise.resolve([{ id: BAND.id }, { id: OTHER_BAND.id }]);
    }
    if (/select id from band_members/i.test(text)) {
      return Promise.resolve([{ id: MEMBER1.id }, { id: MEMBER2.id }]);
    }
    if (/select band_id, member_id from memberships/i.test(text)) {
      return Promise.resolve([
        { band_id: BAND.id, member_id: MEMBER1.id },
        { band_id: BAND.id, member_id: MEMBER2.id },
        { band_id: OTHER_BAND.id, member_id: MEMBER2.id },
      ]);
    }
    return Promise.resolve([]);
  };
  tag.unsafe = (s) => s;
  tag.calls = calls;
  return tag;
}

function makeMockStore(initial = {}) {
  const data = {};
  for (const [k, v] of Object.entries(initial)) data[k] = JSON.parse(JSON.stringify(v));
  return {
    data,
    failGet: false,
    gets: [],
    sets: [],
    async get(key) {
      this.gets.push(key);
      if (this.failGet) throw new Error('blob read failed');
      const v = data[key];
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    },
    async setJSON(key, value) {
      this.sets.push(key);
      data[key] = JSON.parse(JSON.stringify(value));
    },
  };
}

const searchReq = (query) => new Request(`http://localhost/api/graph-search?${query}`);
const cardReq = (query) => new Request(`http://localhost/api/graph-card?${query}`);
const groupsReq = () => new Request('http://localhost/api/graph-groups');

// --- Search: pure helpers ---------------------------------------------------

test('search results carry ONLY the allowed fields, even when rows carry extras', () => {
  const results = searchNames(namesRows(), 'sweet', 20);
  assert.equal(results.length, 1);
  assert.deepEqual(Object.keys(results[0]).sort(), [...SEARCH_RESULT_FIELDS].sort());
  const body = JSON.stringify(results);
  for (const forbidden of ['bio', 'links', 'memberships', 'popularity_score', 'genre', 'label', 'albums']) {
    assert.ok(!body.includes(`"${forbidden}"`), `must not leak ${forbidden}`);
  }
});

test('search matching is case-insensitive', () => {
  assert.equal(searchNames(namesRows(), 'SWEET', 20).length, 1);
  assert.equal(searchNames(namesRows(), 'sWeEt WaTeR', 20)[0].name, 'Sweet Water');
  assert.equal(searchNames(namesRows(), 'cole peterson', 20)[0].type, 'member');
});

test('search matching is id-aware: a city-suffixed id matches its suffix', () => {
  const results = searchNames(namesRows(), 'aberdeen', 20);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'Skid Row (Aberdeen)');
  assert.equal(results[0].name, 'Skid Row');
});

test('limit clamp: 1..50, default 20', () => {
  assert.equal(parseSearchLimit(null), 20);
  assert.equal(parseSearchLimit(''), 20);
  assert.equal(parseSearchLimit('abc'), 20);
  assert.equal(parseSearchLimit('0'), 1);
  assert.equal(parseSearchLimit('-5'), 1);
  assert.equal(parseSearchLimit('100'), 50);
  assert.equal(parseSearchLimit('2.9'), 2);
  assert.equal(searchNames(namesRows(), 'test band', 100).length, 50);
  assert.equal(searchNames(namesRows(), 'test band', 0).length, 1);
  assert.equal(searchNames(namesRows(), 'test band').length, 20);
});

// --- Search: handler ---------------------------------------------------------

test('search handler: empty q -> 400 shape', async () => {
  for (const query of ['q=', 'q=%20%20', '']) {
    const res = await handleGraphSearch(searchReq(query), { sql: makeMockSql(), store: makeMockStore() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, error: 'q is required' });
  }
});

test('search handler: results are names-only with version and cache headers', async () => {
  const res = await handleGraphSearch(searchReq('q=sweet'), { sql: makeMockSql(), store: makeMockStore() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=3600');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.ok(body.version.length > 0);
  assert.equal(body.results.length, 1);
  assert.deepEqual(Object.keys(body.results[0]).sort(), [...SEARCH_RESULT_FIELDS].sort());
});

test('search handler: Blobs cache hit skips the Neon UNION query', async () => {
  const sql = makeMockSql();
  const store = makeMockStore();
  const unionCalls = () => sql.calls.filter((c) => /union all/i.test(c)).length;
  await handleGraphSearch(searchReq('q=sweet'), { sql, store });
  assert.equal(unionCalls(), 1);
  await handleGraphSearch(searchReq('q=test'), { sql, store });
  assert.equal(unionCalls(), 1, 'second request must serve the cached names payload');
});

test('search handler: Blob read failure falls back to Neon', async () => {
  const store = makeMockStore();
  store.failGet = true;
  const res = await handleGraphSearch(searchReq('q=sweet'), { sql: makeMockSql(), store });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].name, 'Sweet Water');
});

// --- Card --------------------------------------------------------------------

test('card band returns entity + its memberships + its links only', async () => {
  const res = await handleGraphCard(cardReq(`type=band&id=${BAND.id}`), { sql: makeMockSql() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.type, 'band');
  assert.equal(body.entity.id, BAND.id);
  assert.equal(body.entity.name, 'Sweet Water');
  assert.equal(body.entity.bio, 'Seattle band bio.');
  assert.deepEqual(body.memberships.map((m) => m.member_id), [MEMBER1.id, MEMBER2.id]);
  assert.deepEqual(body.memberships.map((m) => m.member_name), ['Cole Peterson', 'Paul Uhlir']);
  // Edit-dialog fields: the roster fetch needs the membership row id (for
  // remove/update ops) and the members' instruments (for the row fields).
  assert.deepEqual(body.memberships.map((m) => m.id), [101, 102]);
  assert.deepEqual(body.memberships.map((m) => m.instrument1), ['Bass', 'Drums']);
  assert.deepEqual(body.memberships.map((m) => m.instrument2), [null, null]);
  assert.deepEqual(body.links, BAND_LINKS);
  const flat = JSON.stringify(body);
  assert.ok(!flat.includes('Candlebox'), 'no other band may appear');
  assert.ok(!flat.includes('Someone Else'), 'no other member may appear');
});

test('card member returns entity + its bands only, links empty', async () => {
  const res = await handleGraphCard(cardReq(`type=member&id=${MEMBER1.id}`), { sql: makeMockSql() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'member');
  assert.equal(body.entity.name, 'Cole Peterson');
  assert.equal(body.entity.instrument1, 'Bass');
  assert.deepEqual(body.memberships.map((m) => m.band_id), [BAND.id]);
  assert.deepEqual(body.memberships.map((m) => m.band_name), ['Sweet Water']);
  assert.deepEqual(body.links, []);
  const flat = JSON.stringify(body);
  assert.ok(!flat.includes('Candlebox'), 'no other band may appear');
  assert.ok(!flat.includes('Paul Uhlir'), 'no other member may appear');
});

test('card plain-name fallback returns the matched id', async () => {
  const res = await handleGraphCard(cardReq('type=band&id=Sweet%20Water'), { sql: makeMockSql() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entity.id, BAND.id, 'name fallback must return the matched row id');
  const memberRes = await handleGraphCard(cardReq('type=member&id=Cole%20Peterson'), { sql: makeMockSql() });
  assert.equal((await memberRes.json()).entity.id, MEMBER1.id);
});

test('card unknown id -> 404, bad type / missing id -> 400', async () => {
  const sql = makeMockSql();
  const res404 = await handleGraphCard(cardReq('type=band&id=no-such-id'), { sql });
  assert.equal(res404.status, 404);
  assert.deepEqual(await res404.json(), { ok: false, error: 'not found' });

  const resType = await handleGraphCard(cardReq('type=person&id=x'), { sql });
  assert.equal(resType.status, 400);
  assert.equal((await resType.json()).ok, false);

  const resId = await handleGraphCard(cardReq('type=band'), { sql });
  assert.equal(resId.status, 400);
  assert.deepEqual(await resId.json(), { ok: false, error: 'id is required' });
});

// --- Groups: pure helpers ------------------------------------------------------

test('groups output is anchors+counts only, no member lists', () => {
  const nodes = [
    { id: 'b1' }, { id: 'm1' }, { id: 'm2' }, { id: 'b2' }, { id: 'orphan' },
  ];
  const links = [
    { source: 'b1', target: 'm1' },
    { source: 'b1', target: 'm2' },
    { source: 'b2', target: 'm2' },
  ];
  const { totalNodes, groupCount, groups } = buildGroupsSummary(nodes, links);
  assert.equal(totalNodes, 5);
  assert.equal(groupCount, 2);
  for (const g of groups) {
    assert.deepEqual(Object.keys(g).sort(), ['anchorId', 'nodeCount']);
  }
  assert.ok(!JSON.stringify(groups).includes('member_id'), 'no member lists');
  const big = groups.find((g) => g.nodeCount === 4);
  assert.equal(big.anchorId, 'b1', 'b1 and m2 tie at degree 2; smallest id wins');
  const single = groups.find((g) => g.nodeCount === 1);
  assert.deepEqual(single, { anchorId: 'orphan', nodeCount: 1 });
});

test('groups sorted nodeCount desc then anchorId asc; anchor ties by id asc', () => {
  // Two 2-node components (tie on count -> anchorId asc) + one 3-node comp.
  // In the 2-node comps the tie on degree (1 each) must pick the smaller id.
  const nodes = [
    { id: 'z-band' }, { id: 'z-member' },
    { id: 'a-band' }, { id: 'a-member' },
    { id: 'hub' }, { id: 's1' }, { id: 's2' },
  ];
  const links = [
    { source: 'z-band', target: 'z-member' },
    { source: 'a-band', target: 'a-member' },
    { source: 'hub', target: 's1' },
    { source: 'hub', target: 's2' },
  ];
  const { groups } = buildGroupsSummary(nodes, links);
  assert.deepEqual(groups, [
    { anchorId: 'hub', nodeCount: 3 },
    { anchorId: 'a-band', nodeCount: 2 },
    { anchorId: 'z-band', nodeCount: 2 },
  ]);
});

test('groups: same input -> same output, including shuffled input order', () => {
  const nodes = [
    { id: 'b1' }, { id: 'm1' }, { id: 'm2' }, { id: 'b2' }, { id: 'solo' },
  ];
  const links = [
    { source: 'b1', target: 'm1' },
    { source: 'b1', target: 'm2' },
    { source: 'b2', target: 'm2' },
  ];
  const first = buildGroupsSummary(nodes, links);
  const second = buildGroupsSummary(nodes, links);
  assert.deepEqual(second, first);
  const shuffled = buildGroupsSummary(
    [...nodes].reverse(),
    [...links].reverse(),
  );
  assert.deepEqual(shuffled, first);
});

test('groupsFromApiBandsPayload ignores bios/links and maps membership endpoints', () => {
  const summary = groupsFromApiBandsPayload({
    bands: [{ ...BAND, bio: 'ignored', genre: 'ignored' }, OTHER_BAND],
    members: [MEMBER1, MEMBER2],
    memberships: [
      { band_id: BAND.id, member_id: MEMBER1.id },
      { band_id: BAND.id, member_id: MEMBER2.id },
      { band_id: OTHER_BAND.id, member_id: MEMBER2.id },
    ],
    band_links: BAND_LINKS,
  });
  assert.equal(summary.totalNodes, 4);
  assert.equal(summary.groupCount, 1);
  // BAND and MEMBER2 tie at degree 2; smallest id ('band-uuid-1') wins.
  assert.deepEqual(summary.groups, [{ anchorId: BAND.id, nodeCount: 4 }]);
});

// --- Groups: handler -----------------------------------------------------------

test('groups handler: Neon ids-only fallback, then Blobs copy on repeat', async () => {
  const sql = makeMockSql();
  const store = makeMockStore();
  const idsCalls = () => sql.calls.filter((c) => /select id from/i.test(c)).length;

  const first = await handleGraphGroups(groupsReq(), { sql, store });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(typeof firstBody.version, 'string');
  assert.equal(firstBody.totalNodes, 4);
  assert.equal(firstBody.groupCount, 1);
  assert.deepEqual(firstBody.groups, [{ anchorId: BAND.id, nodeCount: 4 }]);
  const afterFirst = idsCalls();
  assert.ok(afterFirst > 0, 'first call must read ids from Neon');

  const second = await handleGraphGroups(groupsReq(), { sql, store });
  assert.equal((await second.json()).groups.length, 1);
  assert.equal(idsCalls(), afterFirst, 'second call must serve the cached groups payload');
});

test('groups handler: prefers the api-bands Blobs copy over Neon ids queries', async () => {
  const sql = makeMockSql();
  const version = await getDataVersion(sql, GAME_TABLES);
  const apiBandsKey = blobKeyFor('api-bands', version);
  const store = makeMockStore({
    [apiBandsKey]: {
      bands: [{ id: BAND.id }, { id: OTHER_BAND.id }],
      members: [{ id: MEMBER1.id }, { id: MEMBER2.id }],
      memberships: [
        { band_id: BAND.id, member_id: MEMBER1.id },
        { band_id: BAND.id, member_id: MEMBER2.id },
        { band_id: OTHER_BAND.id, member_id: MEMBER2.id },
      ],
    },
  });
  const idsBefore = sql.calls.filter((c) => /select id from/i.test(c)).length;
  const res = await handleGraphGroups(groupsReq(), { sql, store });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.groupCount, 1);
  assert.deepEqual(body.groups, [{ anchorId: BAND.id, nodeCount: 4 }]);
  assert.equal(
    sql.calls.filter((c) => /select id from/i.test(c)).length,
    idsBefore,
    'api-bands copy present: no Neon ids-only queries may run',
  );
});
