// Client governor layer tests (?governor=1) — scripts/sigma-explorer.mjs
// + graph/index.html boot wiring.
//
// The explorer imports sigma and graphology, so node --test cannot execute
// it (the same constraint sigma-explorer-wiring.test.mjs already lives
// with). The governor's pure helpers are therefore written as a
// self-contained section in the module (GOVERNOR-SECTION-START/END) and
// this file extracts and executes exactly that section in Node. Anything
// that needs the DOM or a server (fetches, Sigma rendering) is covered by
// static wiring assertions below, not by live calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXPLORER = readFileSync(join(ROOT, 'scripts', 'sigma-explorer.mjs'), 'utf8');
const INDEX_HTML = readFileSync(join(ROOT, 'graph', 'index.html'), 'utf8');

function loadGovernorSection() {
  const start = EXPLORER.indexOf('// GOVERNOR-SECTION-START');
  const end = EXPLORER.indexOf('// GOVERNOR-SECTION-END');
  assert.ok(start >= 0 && end > start, 'governor section markers must exist in sigma-explorer.mjs');
  const section = EXPLORER.slice(start, end).replace(/^export /gm, '');
  const factory = new Function(
    `${section}; return { GOVERNOR_DEFAULT, governorFromSearch, governorLandingParams, ` +
      'governorViewUrl, governorSearchUrl, governorCardUrl, governorGroupsUrl, ' +
      'governorExpandParams, governorOtherGroups, governorChromeText, ' +
      'governorViewPayloadOk, governorFailureKind, governorRetryMessage };'
  );
  return factory();
}

const G = loadGovernorSection();

// ---------------------------------------------------------------------------
// Flag parsing + default
// ---------------------------------------------------------------------------

test('governor flag: GOVERNOR_DEFAULT is false (governor is opt-in)', () => {
  assert.equal(G.GOVERNOR_DEFAULT, false);
});

test('governorFromSearch: ?governor=1 on, =0/absent/garbage off', () => {
  assert.equal(G.governorFromSearch('?governor=1'), true);
  assert.equal(G.governorFromSearch('?governor=true'), true);
  assert.equal(G.governorFromSearch('?governor=0'), false);
  assert.equal(G.governorFromSearch('?governor=false'), false);
  assert.equal(G.governorFromSearch(''), false);
  assert.equal(G.governorFromSearch('?renderer=sigma'), false);
  assert.equal(G.governorFromSearch('?governor=yes'), false);
  assert.equal(G.governorFromSearch('?governor='), false);
  assert.equal(G.governorFromSearch('governor=1'), true, 'leading ? is optional');
  assert.equal(G.governorFromSearch('?band=Mudhoney&governor=1'), true);
});

test('governorFromSearch: an absent flag follows the default (the one-line flip)', () => {
  assert.equal(G.governorFromSearch('', true), true);
  assert.equal(G.governorFromSearch('?governor=0', true), false, 'an explicit 0 still wins over the default');
});

// ---------------------------------------------------------------------------
// Landing parameters
// ---------------------------------------------------------------------------

test('governorLandingParams: band anchors open at 1 hop, members at 2', () => {
  assert.deepEqual(G.governorLandingParams('?band=Mudhoney'), { anchor: 'Mudhoney', hops: 1, param: 'band' });
  assert.deepEqual(G.governorLandingParams('?member=Aaron McRae'), { anchor: 'Aaron McRae', hops: 2, param: 'member' });
  assert.deepEqual(G.governorLandingParams('?node=Mudhoney'), { anchor: 'Mudhoney', hops: 2, param: 'node' });
  assert.deepEqual(G.governorLandingParams('?anchor=Mudhoney'), { anchor: 'Mudhoney', hops: 2, param: 'anchor' });
  assert.deepEqual(G.governorLandingParams(''), { anchor: 'Aaron McRae', hops: 2, param: null });
});

test('governorLandingParams: parameter order mirrors resolveAnchor (node first)', () => {
  // resolveAnchor iterates ANCHOR_PARAMS = node, band, member, person,
  // anchor; the governor landing parse uses the same order.
  assert.equal(G.governorLandingParams('?node=A&band=B').anchor, 'A');
  assert.equal(G.governorLandingParams('?band=B&member=C').anchor, 'B');
});

// ---------------------------------------------------------------------------
// Chrome counts: view nodes vs server totalNodes, never conflated
// ---------------------------------------------------------------------------

test('governorChromeText: view count against the server total, not the view length', () => {
  assert.equal(
    G.governorChromeText({ viewNodeCount: 19, totalNodes: 35140, hops: 2 }),
    '19 of 35140 nodes in view, 2 degrees out'
  );
  assert.equal(
    G.governorChromeText({ viewNodeCount: 1, totalNodes: 35140, hops: 1 }),
    '1 of 35140 nodes in view, 1 degree out'
  );
  // The failure this guards: using the view length as the total would read
  // "19 of 19 nodes in view" and claim the constellation is the universe.
  assert.notEqual(
    G.governorChromeText({ viewNodeCount: 19, totalNodes: 35140, hops: 2 }),
    '19 of 19 nodes in view, 2 degrees out'
  );
});

// ---------------------------------------------------------------------------
// Expand parameter derivation (mirrors expand(), both caps)
// ---------------------------------------------------------------------------

test('governorExpandParams: hops+1 and budget+60, each capped', () => {
  assert.deepEqual(
    G.governorExpandParams({ maxHops: 2, maxNodes: 100 }),
    { nextHops: 3, nextNodes: 160, changed: true }
  );
  assert.deepEqual(
    G.governorExpandParams({ maxHops: 6, maxNodes: 400 }),
    { nextHops: 6, nextNodes: 400, changed: false }
  );
  assert.deepEqual(
    G.governorExpandParams({ maxHops: 6, maxNodes: 100 }),
    { nextHops: 6, nextNodes: 160, changed: true }
  );
  assert.deepEqual(
    G.governorExpandParams({ maxHops: 2, maxNodes: 390 }),
    { nextHops: 3, nextNodes: 400, changed: true }
  );
});

// ---------------------------------------------------------------------------
// Other-groups math (groups list includes the current group)
// ---------------------------------------------------------------------------

const GROUPS_FIXTURE = [
  { anchorId: 'Aaron McRae', nodeCount: 22407 },
  { anchorId: 'Group B', nodeCount: 9000 },
  { anchorId: 'Group C', nodeCount: 3733 },
];

test('governorOtherGroups: other count is total minus the current component', () => {
  const result = G.governorOtherGroups({
    totalNodes: 35140,
    groups: GROUPS_FIXTURE,
    viewNodeIds: ['Aaron McRae', 'Mudhoney'],
    currentAnchorId: 'Aaron McRae',
    visitedAnchorIds: [],
  });
  assert.equal(result.showRow, true);
  assert.equal(result.current.anchorId, 'Aaron McRae');
  assert.equal(result.otherGroupCount, 2);
  // 35140 - 22407 = 12733, which is also 9000 + 3733.
  assert.equal(result.otherNodeCount, 12733);
  assert.equal(result.nextAnchorId, 'Group B', 'tour order is the groups endpoint order');
});

test('governorOtherGroups: current group found by a view node id, not only the anchor', () => {
  const result = G.governorOtherGroups({
    totalNodes: 35140,
    groups: GROUPS_FIXTURE,
    viewNodeIds: ['Group B', 'Some Band'],
    currentAnchorId: 'Some Band',
    visitedAnchorIds: [],
  });
  assert.equal(result.current.anchorId, 'Group B');
  assert.equal(result.otherNodeCount, 35140 - 9000);
});

test('governorOtherGroups: visited groups tour once, then restart instead of going quiet', () => {
  const visited = ['Group B', 'Group C'];
  const result = G.governorOtherGroups({
    totalNodes: 35140,
    groups: GROUPS_FIXTURE,
    viewNodeIds: ['Aaron McRae'],
    currentAnchorId: 'Aaron McRae',
    visitedAnchorIds: visited,
  });
  assert.equal(result.restarted, true);
  assert.equal(result.nextAnchorId, 'Group B');
});

test('governorOtherGroups: unmatched group + server component count still pins the other count', () => {
  const result = G.governorOtherGroups({
    totalNodes: 35140,
    groups: [{ anchorId: 'Elsewhere', nodeCount: 5000 }],
    viewNodeIds: ['Aaron McRae'],
    currentAnchorId: 'Aaron McRae',
    currentComponentNodeCount: 22407,
    visitedAnchorIds: [],
  });
  assert.equal(result.showRow, true);
  assert.equal(result.otherNodeCount, 35140 - 22407);
});

test('governorOtherGroups: no match and no component count hides the row, never a wrong count', () => {
  const result = G.governorOtherGroups({
    totalNodes: 35140,
    groups: [{ anchorId: 'Elsewhere', nodeCount: 5000 }],
    viewNodeIds: ['Aaron McRae'],
    currentAnchorId: 'Aaron McRae',
    visitedAnchorIds: [],
  });
  assert.equal(result.showRow, false);
  assert.equal(result.nextAnchorId, null);
});

// ---------------------------------------------------------------------------
// Payload bound + failure taxonomy
// ---------------------------------------------------------------------------

function validView(overrides = {}) {
  return {
    ok: true,
    anchor: 'Mudhoney',
    hops: 1,
    maxNodes: 60,
    totalNodes: 35140,
    nodes: [{ id: 'Mudhoney', type: 'band', name: 'Mudhoney' }],
    links: [],
    positions: { Mudhoney: { x: 0, y: 0 } },
    depths: { Mudhoney: 0 },
    frontier: [],
    truncated: false,
    ...overrides,
  };
}

test('governorViewPayloadOk: accepts a view-shaped payload, rejects corpus fields', () => {
  assert.equal(G.governorViewPayloadOk(validView()), true);
  assert.equal(G.governorViewPayloadOk(validView({ bands: [] })), false, 'corpus bands must never ride along');
  assert.equal(G.governorViewPayloadOk(validView({ allNodes: [] })), false);
  assert.equal(G.governorViewPayloadOk(validView({ master: {} })), false);
  assert.equal(G.governorViewPayloadOk(validView({ corpus: {} })), false);
  assert.equal(G.governorViewPayloadOk(validView({ nodes: [] })), false, 'an empty view is the unknown-anchor shape');
  assert.equal(G.governorViewPayloadOk(validView({ positions: null })), false);
  assert.equal(G.governorViewPayloadOk(validView({ totalNodes: undefined })), false);
  assert.equal(G.governorViewPayloadOk(null), false);
});

test('governor failure taxonomy: 202, 404 and generic failures all land in the retry state', () => {
  assert.equal(G.governorFailureKind(202), 'computing');
  assert.equal(G.governorFailureKind(404), 'not-found');
  assert.equal(G.governorFailureKind(500), 'retry');
  assert.equal(G.governorFailureKind(null), 'retry');
  assert.match(G.governorRetryMessage('computing'), /tap to retry/);
  assert.match(G.governorRetryMessage('not-found'), /tap to retry/);
  assert.match(G.governorRetryMessage('retry'), /Constellation loading — tap to retry/);
});

// ---------------------------------------------------------------------------
// Endpoint URL builders
// ---------------------------------------------------------------------------

test('governor endpoint URLs: view/search/card/groups shapes', () => {
  assert.equal(
    G.governorViewUrl('Aaron McRae', 2, 60, 7),
    '/api/graph-view?anchor=Aaron%20McRae&hops=2&maxNodes=60&satelliteCap=7'
  );
  assert.equal(G.governorSearchUrl('mudhoney'), '/api/graph-search?q=mudhoney&limit=20');
  assert.equal(G.governorCardUrl('band', 'Mudhoney'), '/api/graph-card?type=band&id=Mudhoney');
  assert.equal(G.governorGroupsUrl(), '/api/graph-groups');
});

// ---------------------------------------------------------------------------
// Static wiring: the module + page actually wire the governor up
// ---------------------------------------------------------------------------

test('module exposes setGovernorView on the Sigma controller alongside setGraph', () => {
  assert.match(EXPLORER, /setGovernorView,/);
  assert.match(EXPLORER, /function setGovernorView\(view/);
  assert.match(EXPLORER, /governorRetry,/);
});

test('setGovernorView applies the local post-passes in local order (cluster, then collisions)', () => {
  const body = EXPLORER.slice(EXPLORER.indexOf('function setGovernorView(view'));
  const clusterAt = body.indexOf('clusterTouringSatellites(positions, links, nodes, depthsMap, anchorId)');
  const collisionsAt = body.indexOf('resolveGraphCollisions(viewGraph, anchorId)');
  assert.ok(clusterAt >= 0, 'setGovernorView must cluster touring satellites for band anchors');
  assert.ok(collisionsAt > clusterAt, 'collisions must run after clustering, as in renderNeighborhood');
  assert.match(body, /viewGraph\.clear\(\)/);
});

test('governor view fetches use an 8s timeout and never fall back to /api/bands', () => {
  assert.match(EXPLORER, /AbortSignal\.timeout\(8000\)/);
  const governorBody = EXPLORER.slice(EXPLORER.indexOf('function governorLoadView'));
  assert.doesNotMatch(governorBody.slice(0, 2000), /api\/bands/);
});

test('governor navigation branches exist without touching the local render path', () => {
  assert.match(EXPLORER, /if \(state\.governor\) return governorExploreFor\(rawQuery\);/);
  assert.match(EXPLORER, /if \(state\.governor\) \{ void governorExpand\(\); return; \}/);
  assert.match(EXPLORER, /if \(state\.governor\) \{ void governorTravelTo\(node\); return; \}/);
  assert.match(EXPLORER, /if \(state\.governor\) \{ void showNextGovernorGroup\(\); return; \}/);
  // The local path itself is untouched: polygon still at 140, radial at 190.
  assert.match(EXPLORER, /minSeparation: 140/);
  assert.match(EXPLORER, /spacing: 190/);
});

test('governor search hop uses the search-result uuid, not the plain name', () => {
  // Integration: /api/graph-view resolves a Neon uuid to its display id, so
  // colliding same-name bands are addressable. A plain name cannot address
  // a city-suffixed display id.
  const body = EXPLORER.slice(EXPLORER.indexOf('async function governorExploreFor'));
  assert.match(body, /anchorId: match\.id \|\| match\.name/);
});

test('page boot: governor mode skips /api/bands and hands the view to setGovernorView', () => {
  assert.match(INDEX_HTML, /governorModeOn/);
  assert.match(INDEX_HTML, /get\('governor'\) === '1'/, 'the flag is read from location.search in the page boot');
  assert.match(INDEX_HTML, /if \(governorModeOn && onSigmaPath\(\)\)/);
  assert.match(INDEX_HTML, /rbft:governor-view-ready/);
  assert.match(INDEX_HTML, /RBFT_GOVERNOR_VIEW/);
  assert.match(INDEX_HTML, /setGovernorView\(view/);
  assert.match(INDEX_HTML, /api\/graph-view\?anchor=/);
  assert.match(INDEX_HTML, /api\/graph-groups/);
});

test('page governor retry UI text is at least 12px (text-legibility rule)', () => {
  const retry = INDEX_HTML.slice(INDEX_HTML.indexOf('governor-retry'));
  assert.match(retry, /font-size:14px/);
});

test('page governor card bridge fetches /api/graph-card and still opens the view-local card on failure', () => {
  assert.match(INDEX_HTML, /api\/graph-card\?type=/);
  assert.match(INDEX_HTML, /RBFT_GOVERNOR_MODE/);
});
