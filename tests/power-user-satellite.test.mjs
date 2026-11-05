// JWST power-user satellite — unit tests (v1).
// Pure module: scripts/power-user-satellite.mjs has no DOM/Sigma imports,
// so node --test can execute it directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POWER_USER_SATELLITES,
  POWER_USER_SATELLITE_DISPLAY_PX,
  POWER_USER_SATELLITE_OFFSET_PX,
  POWER_USER_CONTRIBUTOR_LAYER,
  SCOTT_SATELLITE,
  JWST_HEX_POLYGONS,
  jwstIconSvg,
  satelliteForAnchor,
  satelliteScreenPosition,
  clampSatelliteLabelX,
  isPowerUserContributionType,
  isQualifyingContribution,
  sortContributionsNewestFirst,
  isSatelliteNode,
  countNodesExcludingSatellites,
  excludeSatellitesFromNodes,
  nodesForPowerUser,
  contributionCardRows,
} from '../scripts/power-user-satellite.mjs';
import { SCOTT_CONTRIBUTIONS } from '../scripts/power-user-contributions.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPLORER = readFileSync(join(__dirname, '../scripts/sigma-explorer.mjs'), 'utf8');
const CONTRIBUTIONS_SRC = readFileSync(join(__dirname, '../scripts/power-user-contributions.mjs'), 'utf8');
const SVG_SRC = readFileSync(join(__dirname, '../graph/jwst-icon.svg'), 'utf8');

test('satellite is on its own contributor layer, fixed member-satellite size, unconnected', () => {
  assert.equal(SCOTT_SATELLITE.layer, POWER_USER_CONTRIBUTOR_LAYER);
  assert.equal(SCOTT_SATELLITE.layer, 'contributor');
  assert.notEqual(SCOTT_SATELLITE.layer, 'band');
  assert.notEqual(SCOTT_SATELLITE.layer, 'person');
  assert.equal(POWER_USER_SATELLITE_DISPLAY_PX, 32);
  // Offset fix (follow-up to v1): 7 o'clock, outside the member ring —
  // the v1 upper-right offset {x: 110, y: -90} still sat inside the ring
  // and overlapped Bob Welch's label.
  assert.deepEqual(POWER_USER_SATELLITE_OFFSET_PX, { x: -150, y: 260 });
  // No edge, no graph position, no music weight on the satellite config.
  assert.equal(SCOTT_SATELLITE.edge, undefined);
  assert.equal(SCOTT_SATELLITE.x, undefined);
  assert.equal(SCOTT_SATELLITE.weight, undefined);
});

test('satellite renders only in its current band view (Fleetwood Mac interim)', () => {
  assert.equal(SCOTT_SATELLITE.currentBand, 'Fleetwood Mac');
  assert.equal(satelliteForAnchor('Fleetwood Mac', POWER_USER_SATELLITES), SCOTT_SATELLITE);
  assert.equal(satelliteForAnchor('Metallica', POWER_USER_SATELLITES), null);
  assert.equal(satelliteForAnchor(null, POWER_USER_SATELLITES), null);
  assert.equal(satelliteForAnchor('Fleetwood Mac', []), null);
});

test('satellite screen position is a fixed screen-space offset, never a graph position', () => {
  assert.deepEqual(satelliteScreenPosition({ x: 400, y: 300 }), { x: 250, y: 560 });
  assert.deepEqual(satelliteScreenPosition({ x: 400, y: 300 }, undefined, { x: 20, y: -30 }), { x: 270, y: 530 });
  assert.equal(satelliteScreenPosition(null), null);
  assert.equal(satelliteScreenPosition({}), null);
});

test('offset fix: 7 o\'clock, distance 300, outside the Fleetwood Mac member ring', () => {
  const { x, y } = POWER_USER_SATELLITE_OFFSET_PX;
  // 7 o'clock: lower left in screen space (x negative, y positive).
  assert.ok(x < 0 && y > 0, 'offset must point down-left');
  const dist = Math.hypot(x, y);
  assert.ok(Math.abs(dist - 300) < 1, `offset distance must be 300, got ${dist}`);
  // Phone first-group view, measured 2026-11-04: hub (195, 426), outermost
  // member dots ~138px from the hub. The satellite must sit well clear.
  const hub = { x: 195, y: 426 };
  const sat = satelliteScreenPosition(hub);
  assert.deepEqual(sat, { x: 45, y: 686 });
  const members = [
    { name: 'Dave Walker', x: 145, y: 332 },
    { name: 'Bob Welch', x: 270, y: 332 },
    { name: 'Dave Mason', x: 207, y: 350 },
    { name: 'Jeremy Spencer', x: 102, y: 395 },
    { name: 'Bekka Bramlett', x: 255, y: 400 },
    { name: 'John McVie', x: 57, y: 442 },
    { name: 'Stevie Nicks', x: 332, y: 447 },
    { name: 'Mick Fleetwood', x: 120, y: 480 },
    { name: 'Rick Vito', x: 207, y: 477 },
    { name: 'Peter Green', x: 200, y: 542 },
  ];
  for (const m of members) {
    const d = Math.hypot(sat.x - m.x, sat.y - m.y);
    assert.ok(d > 200, `satellite must be >200px from ${m.name}, got ${d.toFixed(0)}`);
  }
  // The label (centred under the icon, ~104px wide) must not clip at the
  // left stage edge at this position.
  assert.equal(clampSatelliteLabelX(sat.x, 104, 390), 60);
});

test('label clamp keeps the label fully in view near stage edges', () => {
  assert.equal(clampSatelliteLabelX(305, 104, 390), 305);
  assert.equal(clampSatelliteLabelX(45, 104, 390), 60);
  assert.equal(clampSatelliteLabelX(380, 104, 390), 330);
  assert.equal(clampSatelliteLabelX(640, 104, 1280), 640);
  assert.equal(clampSatelliteLabelX(1250, 104, 1280), 1220);
});

test('Sigma integration: satellite drag is session-only, tap still opens the card', () => {
  assert.match(EXPLORER, /powerSatelliteDragById = new Map/);
  assert.match(EXPLORER, /POWER_SAT_DRAG_THRESHOLD_PX = 10/);
  assert.match(EXPLORER, /powerSatelliteDragged/);
  assert.match(EXPLORER, /touch-action:none/);
  // Drag state is in-memory only: the satellite setup block must not
  // persist a drag position anywhere.
  const setupStart = EXPLORER.indexOf('JWST satellite drag (offset-fix follow-up)');
  const setupEnd = EXPLORER.indexOf('if (powerCardCloseEl)', setupStart);
  const setupBlock = EXPLORER.slice(setupStart, setupEnd);
  assert.ok(setupBlock.length > 0);
  assert.doesNotMatch(setupBlock, /localStorage|sessionStorage/);
  // The click handler suppresses the card on a dragged release.
  assert.match(EXPLORER, /if \(powerSatelliteDragged\) \{ powerSatelliteDragged = false; return; \}/);
});

test('credit rule: only bug / nav / whole-graph, and only when Fixed', () => {
  assert.equal(isPowerUserContributionType('bug'), true);
  assert.equal(isPowerUserContributionType('nav'), true);
  assert.equal(isPowerUserContributionType('whole-graph'), true);
  assert.equal(isPowerUserContributionType('member-add'), false);
  assert.equal(isPowerUserContributionType('card-edit'), false);
  assert.equal(isPowerUserContributionType('suggestion'), false);
  assert.equal(isQualifyingContribution({ type: 'bug', status: 'Fixed' }), true);
  assert.equal(isQualifyingContribution({ type: 'bug', status: 'Verified' }), false);
  assert.equal(isQualifyingContribution({ type: 'bug', status: 'Reported' }), false);
  assert.equal(isQualifyingContribution({ type: 'member-add', status: 'Fixed' }), false);
  assert.equal(isQualifyingContribution(null), false);
});

test('card order: newest first, scroll for history (undated entries keep input order at the end)', () => {
  const rows = sortContributionsNewestFirst([
    { id: 'old', date: '2026-11-01' },
    { id: 'new', date: '2026-11-04' },
    { id: 'undated', date: null },
    { id: 'mid', date: '2026-11-02' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['new', 'mid', 'old', 'undated']);
  const card = contributionCardRows(SCOTT_SATELLITE, SCOTT_CONTRIBUTIONS);
  assert.equal(card.length, SCOTT_CONTRIBUTIONS.length);
  // Card rows carry no token fields, by design (tokens shelved).
  for (const row of card) {
    assert.equal('tokens' in row, false);
    assert.equal('totalEarned' in row, false);
    assert.equal('available' in row, false);
  }
});

test('Scott contributions data invents no specific hole details', () => {
  for (const entry of SCOTT_CONTRIBUTIONS) {
    assert.equal(entry.status, 'Reported');
    assert.match(entry.description, /to be filled from the tracker/);
    assert.equal(entry.fixLink, null);
  }
  assert.equal(SCOTT_CONTRIBUTIONS.some((e) => isQualifyingContribution(e)), false);
});

test('satellite is excluded from counts and node lists by id, layer, and type', () => {
  const nodes = [
    { id: 'Fleetwood Mac', type: 'band' },
    { id: 'Mick Fleetwood', type: 'person' },
    { id: SCOTT_SATELLITE.id, type: 'power-user-satellite', layer: 'contributor' },
    { id: 'someone-else', layer: 'contributor' },
  ];
  assert.equal(countNodesExcludingSatellites(nodes), 2);
  assert.deepEqual(excludeSatellitesFromNodes(nodes).map((n) => n.id), ['Fleetwood Mac', 'Mick Fleetwood']);
  assert.equal(isSatelliteNode({ id: SCOTT_SATELLITE.id }), true);
  assert.equal(isSatelliteNode({ id: 'Fleetwood Mac' }), false);
  assert.equal(countNodesExcludingSatellites([]), 0);
  assert.equal(countNodesExcludingSatellites(null), 0);
});

test('two-node rule: musician and satellite are distinct, linked by account, never merged by name', () => {
  const pair = nodesForPowerUser({
    accountId: 'account-123',
    musicianNodeId: 'Mick Fleetwood',
    satelliteNodeId: SCOTT_SATELLITE.id,
  });
  assert.equal(pair.merged, false);
  assert.equal(pair.linkedBy, 'account');
  assert.notEqual(pair.musician, pair.satellite);
  // No name is ever an input to the link: the function takes no name.
  const scottOnly = nodesForPowerUser({ accountId: null, musicianNodeId: null, satelliteNodeId: SCOTT_SATELLITE.id });
  assert.equal(scottOnly.musician, null);
  assert.equal(scottOnly.satellite, SCOTT_SATELLITE.id);
  assert.equal(scottOnly.merged, false);
});

test('JWST icon: gold hex cluster only, even geometry, no silver base, transparent', () => {
  assert.equal(JWST_HEX_POLYGONS.length, 19);
  const svg = jwstIconSvg();
  assert.match(svg, /viewBox="0 0 200 200"/);
  assert.doesNotMatch(svg, /sunshield|silver/i);
  assert.match(svg, /#f0b64a/);
  // Standalone file carries the same geometry, transparent (no background rect).
  assert.doesNotMatch(SVG_SRC, /<rect[^>]*fill="(?!none)/);
  const filePolys = [...SVG_SRC.matchAll(/points="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(filePolys, [...JWST_HEX_POLYGONS]);
});

test('Sigma integration: satellite is a DOM overlay, never added to the view graph', () => {
  // Stage markup + CSS exist.
  assert.match(EXPLORER, /sigma-power-satellite/);
  assert.match(EXPLORER, /sigma-power-card/);
  assert.match(EXPLORER, /data-jwst-satellite/);
  assert.match(EXPLORER, /data-jwst-card-list/);
  // The overlay is positioned in positionOverlays from the anchor's
  // viewport point, with a fixed screen offset.
  assert.match(EXPLORER, /satelliteForAnchor\(state\.anchorId/);
  assert.match(EXPLORER, /satelliteScreenPosition\(anchorPoint/);
  // It is never viewGraph.addNode'd: the satellite block inside
  // positionOverlays (up to the end of that function) contains no addNode.
  const satStart = EXPLORER.indexOf('JWST power-user satellite (v1). It is NOT a graph node');
  const satEnd = EXPLORER.indexOf('// One canvas context, reused, for measuring label widths.', satStart);
  const satBlock = EXPLORER.slice(satStart, satEnd);
  assert.ok(satBlock.length > 0);
  assert.doesNotMatch(satBlock, /viewGraph\.addNode/);
  // No token UI strings in the satellite integration, and no token
  // fields in the contributions data (the word "token" may appear in
  // comments explaining that tokens are shelved — that is documentation,
  // not a field or a UI string).
  assert.doesNotMatch(EXPLORER, /Total earned|Available to play/);
  assert.doesNotMatch(CONTRIBUTIONS_SRC, /totalEarned|availableBalance|tokenBalance/);
});

test('Sigma integration: satellite hides (and its card closes) when the anchor is not its band', () => {
  assert.match(EXPLORER, /if \(powerCardSatellite\) closePowerCard\(\)/);
  assert.match(EXPLORER, /powerSatelliteEl\.hidden = true/);
});

test('games exclusion: satellite module imports no game code, and the explorer adds no satellite to game data', () => {
  const src = readFileSync(join(__dirname, '../scripts/power-user-satellite.mjs'), 'utf8');
  // Pure module: zero imports, so it cannot depend on any game solver.
  // (The words Daily/Rawkle/Cards may appear in comments explaining the
  // exclusion — that is documentation, not a dependency.)
  assert.doesNotMatch(src, /^import /m);
  assert.doesNotMatch(src, /six-degrees-game|daily-|rawkle-|cards\//i);
  // The explorer's satellite code does not touch game state.
  assert.doesNotMatch(EXPLORER, /power-user-satellite.*daily|daily.*power-user-satellite/i);
});
