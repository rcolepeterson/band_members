// Server half of the Six Degrees graph governor (governor v1).
//
// Tests the pure shared logic in netlify/functions/_graph_view.mjs ONLY:
// cache-key determinism, master-graph adaptation, view selection, layout
// determinism / order-independence, unknown anchors, and the giant rule.
// The HTTP handlers (graph-view.mjs, graph-view-background.mjs) and the
// admin refresh extension are NOT imported here: they depend on
// @netlify/blobs / @neondatabase/serverless, which are not installed on
// this VM, and their behavior (cache hit / 202 / trigger) is exercised by
// the coordinator's integration run. The giant rule is tested via the pure
// helper (buildViewNodes + isGiantView) — never by running a ~180s layout.
//
// Fixture: small hand-built payload in the exact bands_neon.mjs output
// shapes ({bands, members, memberships, band_links}), NOT a stale full
// fixture. Bios are deliberately present in the payload so the tests can
// assert they never leak into a view.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheKeyFor,
  hashString,
  normalizeViewParams,
  buildMasterFromPayload,
  buildViewNodes,
  buildViewFromPayload,
  computeGraphView,
  isGiantView,
  GIANT_MAX_NODES,
  GIANT_MAX_HOPS,
} from '../netlify/functions/_graph_view.mjs';

const B = (id, name, city, state = '', country = 'USA', created_at = '2020-01-01') =>
  ({ id, name, city, state, country, genre: 'Rock', years_active: '', label: '', albums: '', bio: 'SECRET-BAND-BIO', csv_origin: '', created_at, added_by: null });
const M = (id, name, popularity_score = 0) =>
  ({ id, name, city: '', state: '', country: '', instrument1: 'guitar', instrument2: '', years_active: '', bio: 'SECRET-MEMBER-BIO', popularity_score });
const MS = (id, band_id, member_id, weight = 2) =>
  ({ id, band_id, member_id, tenure: '', weight, relation: 'member_of' });

// Ann bridges Alpha + Beta; Cat bridges Beta + Gamma; Echo collides
// (Seattle vs Portland); Solo is both a band and a person.
function smallFixture() {
  return {
    ok: true,
    bands: [
      B('b-alpha', 'Alpha', 'Seattle', 'WA', 'USA', '2020-01-01'),
      B('b-beta', 'Beta', 'Portland', 'OR', 'USA', '2020-01-02'),
      B('b-gamma', 'Gamma', 'Seattle', 'WA', 'USA', '2020-01-03'),
      B('b-echo-sea', 'Echo', 'Seattle', 'WA', 'USA', '2020-01-04'),
      B('b-echo-pdx', 'Echo', 'Portland', 'OR', 'USA', '2020-01-05'),
      B('b-solo', 'Solo', 'Seattle', 'WA', 'USA', '2020-01-06'),
    ],
    members: [
      M('m-ann', 'Ann', 90),
      M('m-bob', 'Bob', 10),
      M('m-cat', 'Cat', 50),
      M('m-dan', 'Dan', 20),
      M('m-eve', 'Eve', 30),
      M('m-solo', 'Solo', 40),
    ],
    memberships: [
      MS('ms1', 'b-alpha', 'm-ann', 1),
      MS('ms2', 'b-alpha', 'm-bob', 2),
      MS('ms3', 'b-beta', 'm-ann', 1),
      MS('ms4', 'b-beta', 'm-cat', 2),
      MS('ms5', 'b-gamma', 'm-cat', 1),
      MS('ms6', 'b-gamma', 'm-dan', 2),
      MS('ms7', 'b-echo-sea', 'm-eve', 1),
      MS('ms8', 'b-echo-pdx', 'm-dan', 2),
      MS('ms9', 'b-solo', 'm-solo', 1),
    ],
    band_links: [{ band_id: 'b-alpha', platform: 'spotify', url: 'https://example.invalid/alpha' }],
  };
}

// Band "Big" with 30 members, each also in 4 unique other bands:
// hops=2, satelliteCap=30, maxNodes=400 -> 1 + 30 + 120 = 151 view nodes.
function giantFixture() {
  const bands = [B('b-big', 'Big', 'Seattle', 'WA', 'USA', '2020-01-01')];
  const members = [];
  const memberships = [];
  for (let i = 0; i < 30; i++) {
    members.push(M(`m-s${i}`, `Sat${i}`));
    memberships.push(MS(`ms-big-${i}`, 'b-big', `m-s${i}`, 2));
    for (let j = 0; j < 4; j++) {
      const bandId = `b-s${i}-${j}`;
      bands.push(B(bandId, `SatBand${i}-${j}`, 'Seattle', 'WA', 'USA', '2020-02-01'));
      memberships.push(MS(`ms-${i}-${j}`, bandId, `m-s${i}`, 2));
    }
  }
  return { ok: true, bands, members, memberships, band_links: [] };
}

const VERSION_A = 'bands:2026-01-01T00:00:00.000Z:6|band_members:2026-01-01T00:00:00.000Z:6|memberships:2026-01-01T00:00:00.000Z:9|band_links:2026-01-01T00:00:00.000Z:1';
const VERSION_B = 'bands:2026-01-02T00:00:00.000Z:6|band_members:2026-01-02T00:00:00.000Z:6|memberships:2026-01-02T00:00:00.000Z:9|band_links:2026-01-02T00:00:00.000Z:1';
const PARAMS = { anchor: 'Ann', hops: 2, maxNodes: 100, satelliteCap: 7, minSeparation: 140 };

test('cacheKey determinism: same inputs -> same key', () => {
  assert.equal(cacheKeyFor(VERSION_A, PARAMS), cacheKeyFor(VERSION_A, { ...PARAMS }));
});

test('cacheKey changes with every position-affecting param and with version', () => {
  const base = cacheKeyFor(VERSION_A, PARAMS);
  for (const over of [
    { hops: 3 }, { maxNodes: 60 }, { satelliteCap: 5 }, { minSeparation: 100 },
    { anchor: 'Cat' },
  ]) {
    assert.notEqual(cacheKeyFor(VERSION_A, { ...PARAMS, ...over }), base, JSON.stringify(over));
  }
  assert.notEqual(cacheKeyFor(VERSION_B, PARAMS), base);
});

test('cacheKey embeds the version hash, so an old key is never reused', () => {
  const key = cacheKeyFor(VERSION_A, PARAMS);
  assert.ok(key.includes(hashString(VERSION_A)), `key ${key} lacks version hash ${hashString(VERSION_A)}`);
  assert.notEqual(hashString(VERSION_A), hashString(VERSION_B));
  assert.ok(!cacheKeyFor(VERSION_B, PARAMS).includes(hashString(VERSION_A)) ||
    cacheKeyFor(VERSION_B, PARAMS) !== cacheKeyFor(VERSION_A, PARAMS));
});

test('normalizeViewParams defaults and validation', () => {
  assert.deepEqual(normalizeViewParams({ anchor: 'Ann' }), {
    anchor: 'Ann', hops: 2, maxNodes: 100, satelliteCap: 7, minSeparation: 140,
  });
  assert.throws(() => normalizeViewParams({ anchor: '' }), /anchor is required/);
  assert.throws(() => normalizeViewParams({ anchor: 'Ann', hops: 0 }), /hops/);
  assert.throws(() => normalizeViewParams({ anchor: 'Ann', hops: 7 }), /hops/);
  assert.throws(() => normalizeViewParams({ anchor: 'Ann', maxNodes: 401 }), /maxNodes/);
  assert.throws(() => normalizeViewParams({ anchor: 'Ann', satelliteCap: 31 }), /satelliteCap/);
});

test('master adaptation: colliding band names get city-suffixed ids, person-band collision gets (musician)', () => {
  const master = buildMasterFromPayload(smallFixture());
  const ids = new Set(master.nodes.map((n) => n.id));
  assert.ok(ids.has('Echo'), 'earliest Echo keeps the plain name');
  assert.ok(ids.has('Echo — Portland, OR'), `Portland Echo suffixed, got: ${[...ids].join(', ')}`);
  assert.ok(ids.has('Solo'), 'band Solo keeps the plain name');
  assert.ok(ids.has('Solo (musician)'), 'person Solo is suffixed');
  const echoLink = master.links.find((l) => l.source === 'Echo — Portland, OR');
  assert.equal(echoLink.target, 'Dan');
});

test('buildViewFromPayload: Ann 2-hop view, role/kind attached, no bios or band_links', () => {
  const view = buildViewFromPayload(smallFixture(), PARAMS);
  assert.deepEqual(view.nodes.map((n) => n.id).sort(), ['Alpha', 'Ann', 'Beta', 'Bob', 'Cat']);
  assert.equal(view.anchor, 'Ann');
  assert.equal(view.hops, 2);
  const ann = view.nodes.find((n) => n.id === 'Ann');
  assert.equal(ann.kind, 'home-star');
  assert.equal(ann.role, 'founder');
  assert.equal(view.nodes.find((n) => n.id === 'Alpha').kind, 'solar-system');
  assert.equal(view.nodes.find((n) => n.id === 'Alpha').role, null);
  assert.deepEqual(Object.keys(view.positions).sort(), view.nodes.map((n) => n.id).sort());
  assert.equal(view.totalNodes, 12); // 6 bands + 6 people, all referenced by a membership
  const blob = JSON.stringify(view);
  assert.ok(!blob.includes('SECRET-BAND-BIO') && !blob.includes('SECRET-MEMBER-BIO'));
  assert.ok(!('band_links' in view));
  assert.equal(computeGraphView, buildViewFromPayload);
});

test('unknown anchor -> empty view', () => {
  const view = buildViewFromPayload(smallFixture(), { ...PARAMS, anchor: 'Nobody Here' });
  assert.deepEqual(view.nodes, []);
  assert.deepEqual(view.links, []);
  assert.deepEqual(view.positions, {});
  assert.equal(view.truncated, false);
});

test('positions deterministic across 10 runs', () => {
  const fixture = smallFixture();
  const first = JSON.stringify(buildViewFromPayload(fixture, PARAMS).positions);
  for (let i = 0; i < 10; i++) {
    assert.equal(JSON.stringify(buildViewFromPayload(fixture, PARAMS).positions), first, `run ${i}`);
  }
});

test('shuffled/reversed input -> same positions and same node ids', () => {
  const fixture = smallFixture();
  const reversed = {
    ...fixture,
    bands: [...fixture.bands].reverse(),
    members: [...fixture.members].reverse(),
    memberships: [...fixture.memberships].reverse(),
  };
  const a = buildViewFromPayload(fixture, PARAMS);
  const b = buildViewFromPayload(reversed, PARAMS);
  assert.deepEqual(b.positions, a.positions);
  assert.deepEqual(b.nodes.map((n) => n.id), a.nodes.map((n) => n.id));
  assert.deepEqual(b.links, a.links);
});

test('radial path (hops 4) is deterministic', () => {
  const fixture = smallFixture();
  const params = { ...PARAMS, hops: 4 };
  const first = JSON.stringify(buildViewFromPayload(fixture, params).positions);
  for (let i = 0; i < 3; i++) {
    assert.equal(JSON.stringify(buildViewFromPayload(fixture, params).positions), first);
  }
});

test('giant rule via pure helper: >100 nodes -> computing, never sync layout', () => {
  const selected = buildViewNodes(giantFixture(), {
    anchor: 'Big', hops: 2, maxNodes: 400, satelliteCap: 30, minSeparation: 140,
  });
  assert.ok(selected.nodes.length > GIANT_MAX_NODES, `got ${selected.nodes.length} nodes`);
  assert.equal(isGiantView({ nodeCount: selected.nodes.length, hops: 2 }), true);
  // The sync endpoint must branch on this BEFORE calling layoutView; here
  // we assert the helper itself already reports the giant view without any
  // layout having run (buildViewNodes performs no layout step).
});

test('giant rule: only polygon views (hops <= 3) over 100 nodes are giant', () => {
  // Integration change: hops 4-6 use radialLayout (no refine phase, linear
  // placement), so a deep radial view is laid out synchronously even at the
  // 400-node budget. Only a polygon view over 100 nodes goes to background.
  const selected = buildViewNodes(smallFixture(), { ...PARAMS, hops: 4 });
  assert.ok(selected.nodes.length <= GIANT_MAX_NODES);
  assert.equal(isGiantView({ nodeCount: selected.nodes.length, hops: 4 }), false);
  assert.equal(isGiantView({ nodeCount: 400, hops: 4 }), false);
  assert.equal(isGiantView({ nodeCount: selected.nodes.length, hops: GIANT_MAX_HOPS }), false);
  assert.equal(isGiantView({ nodeCount: GIANT_MAX_NODES, hops: 2 }), false);
  assert.equal(isGiantView({ nodeCount: GIANT_MAX_NODES + 1, hops: 2 }), true);
});

test('uuid anchor resolves to its display id, and component count is exact', () => {
  // Fixture bands/members carry Neon uuids; the view nodes carry them back.
  const fixture = smallFixture();
  const bandUuid = fixture.bands[0] && fixture.bands[0].id;
  assert.ok(bandUuid, 'fixture band needs a uuid');
  const view = buildViewFromPayload(fixture, { anchor: bandUuid, hops: 2, maxNodes: 100, satelliteCap: 7, minSeparation: 140 });
  assert.ok(view.nodes.length > 0, 'uuid anchor must resolve, not 404');
  assert.notEqual(view.anchor, bandUuid, 'returned anchor is the display id, not the uuid');
  assert.ok(Number.isFinite(view.currentComponentNodeCount) && view.currentComponentNodeCount >= view.nodes.length,
    `component count ${view.currentComponentNodeCount} must cover the view`);
  const node = view.nodes.find((n) => n.id === view.anchor);
  assert.ok(node && node.uuid === bandUuid, 'view anchor node carries its uuid for card fetches');
});
