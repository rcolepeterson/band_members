// First-group ordering (first-group-ordering-v1) — dep-free, runs on a bare
// clone (no graphology, no npm deps). Pins:
//
//   1. Neighbor ordering: full members before short-term members, founders
//      first within full members, then popularity desc, degree desc, name.
//      Short-term members are ORDERED LAST, never dropped.
//   2. Hub cap: the anchor's neighbors use hubSatellites (10); deeper nodes
//      stay at maxSatellites (7). Hub groups page by hubGroup and clamp.
//   3. View-layer per-band weight: a view node carries its admitting edge's
//      weight, not the min across all of the person's bands.
//   4. Server params: hubSatelliteCap/hubGroup defaults + cache-key coverage.
//   5. Client wiring + blast-radius markers in the page and explorer.
//
// The ordering change intentionally does NOT touch layout: polygon/radial
// solvers are unchanged, so 1-2 degree layout output for a given node set
// is byte-identical; only WHICH nodes are selected changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getNeighborhood,
  buildAdjacency,
  NEIGHBORHOOD_BUDGET,
} from '../scripts/neighborhood-helpers.mjs';
import {
  buildViewNodes,
  normalizeViewParams,
  cacheKeyFor,
} from '../netlify/functions/_graph_view.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPLORER = readFileSync(join(__dirname, '../scripts/sigma-explorer.mjs'), 'utf8');
const PAGE = readFileSync(join(__dirname, '../graph/index.html'), 'utf8');

// Hub band with a Fleetwood-Mac-shaped roster: founders with modest
// popularity, a high-popularity journeyman, and two very-high-popularity
// short-term players (one by weight, one by relation).
function orderingFixture() {
  const nodes = [
    { id: 'Hub Band', type: 'band' },
    { id: 'Founder Fay', type: 'person', popularity_score: 10 },
    { id: 'Founder Fred', type: 'person', popularity_score: 9 },
    { id: 'Journeyman Joe', type: 'person', popularity_score: 30 },
    { id: 'Star Sue', type: 'person', popularity_score: 20 },
    { id: 'Touring Tom', type: 'person', popularity_score: 99 },
    { id: 'Guest Gus', type: 'person', popularity_score: 98 },
  ];
  const links = [
    { source: 'Hub Band', target: 'Founder Fay', relation: 'member_of', weight: 1 },
    { source: 'Hub Band', target: 'Founder Fred', relation: 'member_of', weight: 1 },
    { source: 'Hub Band', target: 'Journeyman Joe', relation: 'member_of', weight: 2 },
    { source: 'Hub Band', target: 'Star Sue', relation: 'member_of', weight: 2 },
    { source: 'Hub Band', target: 'Touring Tom', relation: 'member_of', weight: 3 },
    { source: 'Hub Band', target: 'Guest Gus', relation: 'guest', weight: 2 },
  ];
  return { nodes, links };
}

// One hub-group window of a 1-hop view: the SET admitted in that window is
// what the ordering decides, so assertions read the admitted set, not the
// final id-sorted node list.
function hubWindow(fixture, cap, group) {
  const view = getNeighborhood({
    ...fixture,
    anchorId: 'Hub Band',
    maxHops: 1,
    maxNodes: 100,
    maxSatellites: 7,
    hubSatellites: cap,
    hubGroup: group,
  });
  return view;
}

test('first-group ordering: founders first, then popularity, touring last but included', () => {
  const fixture = orderingFixture();
  // Cap 4 splits the roster: group 0 must be the two founders + the two
  // highest-popularity FULL members — neither short-term player, despite
  // their 99/98 popularity.
  const view = hubWindow(fixture, 4, 0);
  const hop1 = view.nodes.filter(n => n.hop === 1).map(n => n.id).sort();
  assert.deepEqual(hop1, ['Founder Fay', 'Founder Fred', 'Journeyman Joe', 'Star Sue']);
  // Group 1 holds exactly the two short-term players: still in the
  // constellation, never dropped, just never in the opening group.
  const view2 = hubWindow(fixture, 4, 1);
  const hop1b = view2.nodes.filter(n => n.hop === 1).map(n => n.id).sort();
  assert.deepEqual(hop1b, ['Guest Gus', 'Touring Tom']);
  assert.equal(view2.hubGroupInfo.total, 6);
  assert.equal(view2.hubGroupInfo.groupCount, 2);
});

test('first-group ordering: founders beat popularity (a founder with pop 9 outranks a member with pop 30)', () => {
  const fixture = orderingFixture();
  const view = hubWindow(fixture, 2, 0);
  const hop1 = view.nodes.filter(n => n.hop === 1).map(n => n.id).sort();
  assert.deepEqual(hop1, ['Founder Fay', 'Founder Fred']);
});

test('hub cap 10 vs deeper cap 7, and hub-group clamping', () => {
  const nodes = [{ id: 'Hub Band', type: 'band' }];
  const links = [];
  for (let i = 1; i <= 12; i += 1) {
    nodes.push({ id: `Member ${String(i).padStart(2, '0')}`, type: 'person', popularity_score: 100 - i });
    links.push({ source: 'Hub Band', target: `Member ${String(i).padStart(2, '0')}`, relation: 'member_of', weight: 2 });
  }
  // One hop-1 member also plays in 9 other bands: at hop 2 that member is
  // a DEEPER parent, so its neighbors cap at 7, not the hub 10.
  for (let i = 1; i <= 9; i += 1) {
    nodes.push({ id: `Side Band ${i}`, type: 'band' });
    links.push({ source: `Side Band ${i}`, target: 'Member 01', relation: 'member_of', weight: 2 });
  }
  const base = { nodes, links, anchorId: 'Hub Band', maxHops: 2, maxNodes: 100, maxSatellites: 7, hubSatellites: 10 };
  const g0 = getNeighborhood({ ...base, hubGroup: 0 });
  assert.equal(g0.nodes.filter(n => n.hop === 1).length, 10);
  assert.deepEqual(g0.hubGroupInfo, { total: 12, group: 0, groupCount: 2, cap: 10 });
  // Hop-2 side bands are capped at the DEEPER cap, not the hub cap.
  const sideShown = g0.nodes.filter(n => n.id.startsWith('Side Band ')).length;
  assert.equal(sideShown, 7);
  const g1 = getNeighborhood({ ...base, hubGroup: 1 });
  assert.equal(g1.nodes.filter(n => n.hop === 1).length, 2);
  assert.equal(g1.hubGroupInfo.group, 1);
  // An out-of-range group clamps to the last group instead of rendering
  // an empty hub window.
  const gX = getNeighborhood({ ...base, hubGroup: 99 });
  assert.equal(gX.hubGroupInfo.group, 1);
  assert.equal(gX.nodes.filter(n => n.hop === 1).length, 2);
});

test('view-layer per-band weight: admitting edge wins over the min across bands', () => {
  // Dana is a founder of Band A (w1) but touring for Hub Band (w3).
  // The min-collapse would report weight 1 in both views; the view layer
  // must report 3 in the Hub view and 1 in the Band A view.
  const payload = {
    bands: [
      { id: 'b-hub', name: 'Hub Band', created_at: '2020-01-01' },
      { id: 'b-a', name: 'Band A', created_at: '2020-01-02' },
    ],
    members: [
      { id: 'm-dana', name: 'Dana', popularity_score: 10 },
      { id: 'm-erin', name: 'Erin', popularity_score: 10 },
    ],
    memberships: [
      { band_id: 'b-hub', member_id: 'm-dana', weight: 3, relation: 'member_of' },
      { band_id: 'b-hub', member_id: 'm-erin', weight: 2, relation: 'member_of' },
      { band_id: 'b-a', member_id: 'm-dana', weight: 1, relation: 'member_of' },
    ],
  };
  const hubView = buildViewNodes(payload, { anchor: 'Hub Band', hops: 1, maxNodes: 100 });
  const danaHub = hubView.nodes.find(n => n.id === 'Dana');
  assert.equal(danaHub.weight, 3);
  assert.equal(danaHub.role, 'touring');
  const aView = buildViewNodes(payload, { anchor: 'Band A', hops: 1, maxNodes: 100 });
  const danaA = aView.nodes.find(n => n.id === 'Dana');
  assert.equal(danaA.weight, 1);
  assert.equal(danaA.role, 'founder');
  // Hub group info rides the server view for the client footer row.
  assert.equal(hubView.hubGroupInfo.total, 2);
  assert.equal(hubView.hubGroupInfo.groupCount, 1);
});

test('server params: hub defaults and cache-key coverage', () => {
  const p = normalizeViewParams({ anchor: 'Fleetwood Mac' });
  assert.equal(p.hubSatelliteCap, 10);
  assert.equal(p.hubGroup, 0);
  assert.equal(p.satelliteCap, 7);
  const k0 = cacheKeyFor('v1', { anchor: 'Fleetwood Mac' });
  const k1 = cacheKeyFor('v1', { anchor: 'Fleetwood Mac', hubGroup: 1 });
  const k2 = cacheKeyFor('v1', { anchor: 'Fleetwood Mac', hubSatelliteCap: 7 });
  assert.notEqual(k0, k1);
  assert.notEqual(k0, k2);
});

test('budget constant: hub cap is 10, deeper cap stays 7', () => {
  assert.equal(NEIGHBORHOOD_BUDGET.HUB_SATELLITE_CAP, 10);
  assert.equal(NEIGHBORHOOD_BUDGET.SATELLITE_CAP, 7);
});

test('client wiring: hub-group row, cycle function, governor hubGroup param', () => {
  assert.match(EXPLORER, /sigma-hub-groups/);
  assert.match(EXPLORER, /function cycleHubGroup\(\)/);
  assert.match(EXPLORER, /hubGroup=\$\{encodeURIComponent\(group\)\}/);
  assert.match(EXPLORER, /HUB_SATELLITE_CAP/);
  assert.match(EXPLORER, /Show next members/);
  // The hub row is distinct from the disconnected-components row: the old
  // "Show next group" button and its tour semantics are untouched.
  assert.match(EXPLORER, /Show next group/);
});

test('blast radius: governor/sign-in/card/pencil wiring still present in the page', () => {
  assert.match(PAGE, /governorBoot\(\);/);
  assert.match(PAGE, /initSignup\(\);/);
  assert.match(PAGE, /const initSignup = \(function initSignup\(\) \{/);
  assert.match(PAGE, /viewNode && viewNode\.uuid/);
  assert.match(PAGE, /nodeCardEditBtn\.hidden = !\(canEdit \|\| showSigninHint\)/);
});
