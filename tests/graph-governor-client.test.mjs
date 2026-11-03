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
      'governorViewPayloadOk, governorFailureKind, governorRetryMessage, governorDrawKind };'
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
// Parity: anchor kind (governor-node-parity-v1)
// ---------------------------------------------------------------------------
// The live bug: a governor view for Metallica arrived with the anchor's
// kind = 'home-star' (server classifyNode marks ANY anchor that way), and
// the governor client trusted it, so the center rendered as a tiny white
// node with its label blanked and no DOM overlay to label it. Legacy
// never did this: home-star is Aaron McRae only. These tests pin the
// restored rule, including against a stale cached view that still
// carries the old server kind.

const METALLICA_LINKS = [
  { source: 'Metallica', target: 'James Hetfield', weight: 1, relation: 'member_of' },
  { source: 'Metallica', target: 'Lars Ulrich', weight: 1, relation: 'member_of' },
  { source: 'Metallica', target: 'Dave Mustaine', weight: 2, relation: 'member_of' },
];

test('governorDrawKind: band anchor with a stale server home-star kind renders as a band, not a star', () => {
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Metallica', homeStarId: null, serverKind: 'home-star',
      node: { id: 'Metallica', type: 'band' }, links: METALLICA_LINKS,
    }),
    'solar-system'
  );
  // Same result when the home-star node is known but is not this node.
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Metallica', homeStarId: 'Aaron McRae', serverKind: 'home-star',
      node: { id: 'Metallica', type: 'band' }, links: METALLICA_LINKS,
    }),
    'solar-system'
  );
});

test('governorDrawKind: person anchor with a stale server home-star kind keeps its natural kind and label', () => {
  const annLinks = [
    { source: 'Alpha', target: 'Ann', weight: 1, relation: 'member_of' },
    { source: 'Beta', target: 'Ann', weight: 1, relation: 'member_of' },
  ];
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Ann', homeStarId: null, serverKind: 'home-star',
      node: { id: 'Ann', type: 'person' }, links: annLinks,
    }),
    'constellation'
  );
  const bobLinks = [{ source: 'Alpha', target: 'Bob', weight: 2, relation: 'member_of' }];
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Bob', homeStarId: null, serverKind: 'home-star',
      node: { id: 'Bob', type: 'person' }, links: bobLinks,
    }),
    'planet'
  );
  const tourLinks = [{ source: 'Alpha', target: 'Tour', weight: 3, relation: 'member_of' }];
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Tour', homeStarId: null, serverKind: 'home-star',
      node: { id: 'Tour', type: 'person' }, links: tourLinks,
    }),
    'moon'
  );
});

test('governorDrawKind: Aaron McRae anchor still renders as home-star', () => {
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Aaron McRae', homeStarId: 'Aaron McRae', serverKind: 'home-star',
      node: { id: 'Aaron McRae', type: 'person' },
      links: [{ source: 'The Protocol', target: 'Aaron McRae', weight: 1, relation: 'member_of' }],
    }),
    'home-star'
  );
  // The overlay path that labels that star is intact.
  assert.match(EXPLORER, /homeStarId === state\.anchorId \? `\$\{homeStarId\} — you are here`/);
});

test('governorDrawKind: a non-home-star server kind is kept as-is', () => {
  assert.equal(
    G.governorDrawKind({
      nodeId: 'Cat', homeStarId: null, serverKind: 'constellation',
      node: { id: 'Cat', type: 'person' },
      links: [{ source: 'Beta', target: 'Cat', weight: 2, relation: 'member_of' }],
    }),
    'constellation',
    'only home-star is discarded; full-corpus kinds for other nodes must not be recomputed from view links'
  );
});

test('setGovernorView draw loop uses governorDrawKind with homeStarId and the server kind', () => {
  const body = EXPLORER.slice(EXPLORER.indexOf('function setGovernorView(view'));
  assert.match(body, /governorDrawKind\(\{/);
  assert.match(body, /homeStarId,/);
  assert.match(body, /serverKind: node\.kind/);
});

test('tap-to-travel and drag are unchanged: 10px mouse grab, 10px drag threshold, tap travels', () => {
  assert.match(EXPLORER, /const GRAB_RADIUS_MOUSE_PX = 10;/, 'mouse grab radius stays at the pre-governor 10px — no new interaction');
  assert.match(EXPLORER, /const DRAG_THRESHOLD_PX = 10;/);
  assert.match(EXPLORER, /const tappedId = dragState\.nodeId;/);
  assert.match(EXPLORER, /if \(tappedId\) travelTo\(tappedId\);/);
  assert.match(EXPLORER, /if \(state\.governor\) \{ void governorTravelTo\(node\); return; \}/);
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

// ---------------------------------------------------------------------------
// Landing-boot footer (governor-landing-footer-v1)
// ---------------------------------------------------------------------------
// Live bug 2026-11-02: a fresh ?governor=1 landing on Aaron McRae showed
// "19 of 19 nodes in view, Every connection in this region is on screen"
// and no other-groups row, persisting for minutes across refreshes, while
// a travel view to the same anchor showed the correct "19 of 35140,
// 4 connected nodes just beyond, 12733 more nodes in 2904 groups".
// Cause chain, as traced in code: (1) the governor boot painted a local
// view from the 19-node view-only master first, whose footer is always
// 19 of 19 with an empty frontier; (2) the page's re-apply guard treated
// "a view is set" as "the governor view is applied", so it skipped the
// re-application that would have corrected that footer; (3) an empty
// groups list from a timed-out groups fetch was treated as applied, so
// the other-groups row could never appear on boot (travel, which passes
// no groups, retried the fetch). The fix removes all three: boot never
// paints locally, the guard checks the server total, and empty groups
// retry. These tests pin that wiring; the footer values themselves are
// pinned by governorChromeText / governorOtherGroups below.

test('landing boot: governor boot passes skipFirstPaint so no local footer is ever painted', () => {
  const boot = EXPLORER.slice(EXPLORER.indexOf('if (governorFromSearch(win.location.search))'));
  assert.match(boot, /skipFirstPaint: true/);
  assert.match(EXPLORER, /skipFirstPaint = false/);
  // The first-paint render is gated on the flag, with the anchor still set
  // so syncAddressBar keeps working on boot.
  const firstPaint = EXPLORER.slice(EXPLORER.indexOf('// -- first paint'));
  assert.match(firstPaint, /if \(skipFirstPaint\)/);
  assert.match(firstPaint, /state\.anchorId = resolved\.anchorId;/);
});

test('landing boot: legacy first paint is unchanged when skipFirstPaint is not passed', () => {
  // Default false, and the renderNeighborhood first-paint call is still
  // present in the else branch — plain mode and non-boot paths are untouched.
  assert.match(EXPLORER, /skipFirstPaint = false/);
  assert.match(EXPLORER, /renderNeighborhood\(\{\s*anchorId: resolved\.anchorId,/);
});

test('landing boot: page re-apply guard checks the server total, not merely "a view is set"', () => {
  assert.match(INDEX_HTML, /Number\(controller\.state\.governorTotalNodes\) === Number\(view\.totalNodes\)/);
  assert.doesNotMatch(INDEX_HTML, /!\(controller\.state && controller\.state\.view\)/);
});

test('landing boot: an empty groups list is retried, not treated as applied', () => {
  const body = EXPLORER.slice(EXPLORER.indexOf('function setGovernorView(view'));
  assert.match(body, /if \(Array\.isArray\(groups\) && groups\.length\) state\.governorGroups = groups;/);
  assert.match(body, /else if \(!state\.governorGroups\.length\) governorRefreshGroups\(\);/);
});

test('boot blank fix: init return object must not reference an undefined flyTo', () => {
  // REGRESSION (governor-boot-blank-fix-v1, live 2026-11-02 after #495):
  // initSigmaExplorer's return object carried a bare `flyTo,` shorthand
  // while no flyTo function existed in the file (deleted in the 2026-10-24
  // upload a320068 -> 022a3d4, uses removed, return line left). Evaluating
  // that object threw ReferenceError on EVERY init, so bootFromPage never
  // received a controller and never called setGovernorView. Plain mode and
  // pre-#495 governor mode only looked fine because the local first paint
  // ran BEFORE the return and left a constellation on screen; #495's
  // skipFirstPaint removed that paint, turning the latent throw into a
  // blank stage with a generic footer and no retry. No caller uses
  // controller.flyTo anywhere in the repo. This test fails if a shorthand
  // is ever left without a matching function definition again.
  const hasShorthand = /^\s*flyTo,$/m.test(EXPLORER);
  const hasDefinition = /function flyTo\(/.test(EXPLORER);
  assert.equal(hasShorthand && !hasDefinition, false,
    'init return references flyTo but no flyTo function is defined — init would throw and boot would stay blank');
});

test('boot blank fix: bootFromPage applies the server view after init returns a controller', () => {
  // With the flyTo throw gone, init returns a controller and boot must
  // hand it the server view — that call is the only thing that paints a
  // skipFirstPaint boot. If init threw, this call was never reached and
  // the stage stayed blank with no error.
  const boot = EXPLORER.slice(EXPLORER.indexOf('if (governorFromSearch(win.location.search))'));
  assert.match(boot, /win\.RBFT_SIGMA = controller;/);
  assert.match(boot, /controller\.setGovernorView\(view, \{ groups, animate: false \}\);/);
});

test('landing boot footer: Aaron McRae governor footer values match the travel view', () => {
  assert.equal(
    G.governorChromeText({ viewNodeCount: 19, totalNodes: 35140, hops: 2 }),
    '19 of 35140 nodes in view, 2 degrees out'
  );
  // Live shape: groups endpoint anchorIds are UUIDs, view ids are display
  // names, so no group matches by id — the fallback pins the other count
  // to totalNodes minus the server component count, and every listed
  // group counts as other (2904 live; 2 in this fixture).
  const result = G.governorOtherGroups({
    totalNodes: 35140,
    groups: [
      { anchorId: 'f2ae25ad-04d6-488f-8ff6-6e9acb8f8883', nodeCount: 22410 },
      { anchorId: 'b36163e1-2703-4d6b-8956d116457', nodeCount: 32 },
    ],
    viewNodeIds: ['Aaron McRae', 'Black Box Recovery Unit'],
    currentAnchorId: 'Aaron McRae',
    currentComponentNodeCount: 22407,
    visitedAnchorIds: [],
  });
  assert.equal(result.showRow, true);
  assert.equal(result.otherNodeCount, 12733, '35140 - 22407');
  assert.equal(result.otherGroupCount, 2, 'all listed groups count as other when none matches by id');
  assert.equal(result.nextAnchorId, 'f2ae25ad-04d6-488f-8ff6-6e9acb8f8883');
});

test('landing boot: GOVERNOR_DEFAULT stays false — no flip in this batch', () => {
  assert.equal(G.GOVERNOR_DEFAULT, false);
});
