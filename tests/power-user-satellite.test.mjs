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
  assert.deepEqual(POWER_USER_SATELLITE_OFFSET_PX, { x: 110, y: -90 });
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
  assert.deepEqual(satelliteScreenPosition({ x: 400, y: 300 }), { x: 510, y: 210 });
  assert.equal(satelliteScreenPosition(null), null);
  assert.equal(satelliteScreenPosition({}), null);
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
