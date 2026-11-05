// ---------------------------------------------------------------------------
// JWST power-user satellite — contributor layer (v1).
//
// This module is deliberately pure: no DOM, no Sigma, no imports. The tests
// in tests/power-user-satellite.test.mjs execute it directly under node.
//
// Locked rules (Power Users chat, 2026-11-04 — do not relitigate here):
//   - A power user gets a dedicated JWST satellite node on its OWN layer.
//     It is NOT a musician node and it is NOT merged with any musician node.
//   - It is excluded from the solver, from node counts, and from all games
//     (Daily / Rawkle / Cards). The Sigma integration renders it as a DOM
//     overlay in the stage, never as a graphology node, so the view graph,
//     the layout solver, and the game solvers literally never see it.
//   - Display size is FIXED at a regular member-satellite size. It does not
//     vary with music weight, with the anchor, or with zoom.
//   - Tokens are SHELVED for v1. There are no token fields, balances, earn
//     rates, or spend paths anywhere in this module or in the card it feeds.
//     The satellite alone is the street cred.
//   - A power-user contribution is a real bug, a nav issue, or a
//     whole-graph enhancement — documented (text message or feedback button),
//     worked by Aaron/Nova, and linked suggestion -> fix. Routine
//     band-member adds and band-card edits do NOT count: any signed-in user
//     can already do those.
//   - The satellite is always visible and its position is global: signed-out
//     viewers see it at its latest fixed location. A power user must be
//     signed in to RECORD a new issue, so the tracker can attribute it.
//   - Two-node rule: if a power user is also a musician, they have TWO nodes
//     on TWO layers (musician node + satellite), linked by ACCOUNT, never
//     merged by name. Scott today has only the satellite: there is no
//     musician node to link yet, and none is invented here.
//
// How the satellite moves in v1 (manual ledger, not live code magic):
//   - The tracker (see docs/power-user-tracker-template.csv) is the record.
//     When Aaron/Nova tick a ticket Fixed, they update the satellite's
//     `currentBand` below to the fixed band's anchor name and add a
//     contribution entry to scripts/power-user-contributions.mjs.
//   - That is the move. No code watches the tracker, and no code invents a
//     band: if `currentBand` does not match the current anchor, the
//     satellite simply does not render in that view.
// ---------------------------------------------------------------------------

// Fixed display size, in CSS pixels, for the DOM overlay. This is the
// regular member-satellite size in the view (KIND_STYLE.PLANET.size = 7 in
// Sigma units); it is intentionally NOT the hub size and NOT the touring
// size, and it never varies with music weight.
export const POWER_USER_SATELLITE_DISPLAY_PX = 32;

// Screen-space offset from the anchor node, in CSS pixels. "A bit removed":
// far enough that the satellite can never be mistaken for a member of the
// constellation, close enough that it reads as belonging to this view.
// There is NO edge between the satellite and the anchor or any other node.
export const POWER_USER_SATELLITE_OFFSET_PX = { x: 110, y: -90 };

// The contributor layer's name. Music nodes live on the music layer; the
// satellite lives here, and only here.
export const POWER_USER_CONTRIBUTOR_LAYER = 'contributor';

// Stable satellite id. It is NOT a band id, NOT a person id, and NOT a name:
// names collide (same-name bands, same-name people) and must never be used
// as a link key. The link key for a power user is their site account id,
// which is null for Scott in v1 because no site account link is known yet
// (see SCOTT_SATELLITE.accountId). Do not guess one.
export const POWER_USER_SATELLITE_ID_PREFIX = 'power-user-satellite:';

// Tracker contribution types that can qualify as a power-user contribution.
// 'suggestion' is intake only: a suggestion becomes a contribution only when
// it is verified and its fix is linked (see isQualifyingContribution).
export const POWER_USER_CONTRIBUTION_TYPES = Object.freeze([
  'bug',
  'nav',
  'whole-graph',
]);

// Tracker statuses. These names are the v1-to-ticketing-system contract:
// a fuller system later reuses exactly these names, so v1 rows migrate
// without renaming.
export const POWER_USER_TICKET_STATUSES = Object.freeze([
  'New',
  'Verified',
  'Fixed',
  'Not a hole',
  'Duplicate',
]);

// JWST icon geometry: gold hexagon mirror cluster only, no silver
// sunshield/base, even hexagon sizes, tight even spacing — the approved
// draft geometry, also shipped as graph/jwst-icon.svg (transparent).
// Each entry is one hexagon's points in a 200x200 viewBox.
export const JWST_HEX_POLYGONS = Object.freeze([
  '120.7,20.5 110.2,38.7 89.2,38.7 78.7,20.5 89.2,2.3 110.2,2.3',
  '86.3,40.6 75.8,58.8 54.8,58.8 44.3,40.6 54.8,22.5 75.8,22.5',
  '155.2,40.9 144.7,59.1 123.7,59.1 113.2,40.9 123.7,22.7 144.7,22.7',
  '52.4,60.2 41.9,78.4 20.9,78.4 10.4,60.2 20.9,42.1 41.9,42.1',
  '121.0,60.5 110.5,78.7 89.5,78.7 79.0,60.5 89.5,42.3 110.5,42.3',
  '187.1,62.5 176.6,80.7 155.6,80.7 145.1,62.5 155.6,44.3 176.6,44.3',
  '86.6,80.4 76.1,98.6 55.1,98.6 44.6,80.4 55.1,62.2 76.1,62.2',
  '155.4,80.4 144.9,98.6 123.9,98.6 113.4,80.4 123.9,62.2 144.9,62.2',
  '52.4,100.0 41.9,118.2 20.9,118.2 10.4,100.0 20.9,81.8 41.9,81.8',
  '120.7,100.3 110.2,118.5 89.2,118.5 78.7,100.3 89.2,82.1 110.2,82.1',
  '189.6,100.0 179.1,118.2 158.1,118.2 147.6,100.0 158.1,81.8 179.1,81.8',
  '86.6,120.2 76.1,138.3 55.1,138.3 44.6,120.2 55.1,102.0 76.1,102.0',
  '155.4,120.2 144.9,138.3 123.9,138.3 113.4,120.2 123.9,102.0 144.9,102.0',
  '52.7,139.8 42.2,157.9 21.2,157.9 10.7,139.8 21.2,121.6 42.2,121.6',
  '120.7,140.0 110.2,158.2 89.2,158.2 78.7,140.0 89.2,121.9 110.2,121.9',
  '189.9,139.8 179.4,157.9 158.4,157.9 147.9,139.8 158.4,121.6 179.4,121.6',
  '86.6,160.2 76.1,178.4 55.1,178.4 44.6,160.2 55.1,142.0 76.1,142.0',
  '155.4,160.2 144.9,178.4 123.9,178.4 113.4,160.2 123.9,142.0 144.9,142.0',
  '120.7,179.8 110.2,198.0 89.2,198.0 78.7,179.8 89.2,161.6 110.2,161.6',
]);

// Inline SVG for the satellite overlay. The standalone file
// graph/jwst-icon.svg carries the same geometry with a transparent
// background; this string is what the Sigma stage actually draws, so the
// icon cannot fail to load as a separate request.
export function jwstIconSvg() {
  const polys = JWST_HEX_POLYGONS.map(
    (points) => `<polygon points="${points}" fill="#f0b64a" stroke="#04070b" stroke-width="1.5"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%" role="img" aria-label="JWST power-user satellite">${polys}</svg>`;
}

// Scott's satellite, v1. Interim placement: the Fleetwood Mac view, as
// agreed, sitting a bit removed and unconnected. When a later ticket is
// ticked Fixed, update `currentBand` to that band's anchor name — that
// update IS the move in v1. Do not add a musician node id here: Scott has
// no musician node linked yet, and inventing one would violate the
// two-node rule's account-link requirement.
export const SCOTT_SATELLITE = Object.freeze({
  id: `${POWER_USER_SATELLITE_ID_PREFIX}scott`,
  displayName: 'Scott',
  accountId: null,
  icon: 'jwst-hex',
  layer: POWER_USER_CONTRIBUTOR_LAYER,
  currentBand: 'Fleetwood Mac',
  musicianNodeId: null,
});

export const POWER_USER_SATELLITES = Object.freeze([SCOTT_SATELLITE]);

// The satellite for the current anchor view, or null. The satellite renders
// ONLY in the view of its current band: it is never injected into other
// views, never searched, and never travelled to. Anchor matching is exact
// against the anchor name the view is centred on.
export function satelliteForAnchor(anchorId, satellites = POWER_USER_SATELLITES) {
  if (!anchorId || !Array.isArray(satellites)) return null;
  return satellites.find((sat) => sat && sat.currentBand === anchorId) || null;
}

// Screen position for the satellite overlay, given the anchor's viewport
// point. Pure screen-space offset: the satellite is "a bit removed" at
// every zoom level, and it has no graph position, no edge, and no layout
// participation whatsoever.
export function satelliteScreenPosition(anchorViewport, offset = POWER_USER_SATELLITE_OFFSET_PX) {
  if (!anchorViewport || typeof anchorViewport.x !== 'number' || typeof anchorViewport.y !== 'number') return null;
  return {
    x: anchorViewport.x + (offset ? offset.x : 0),
    y: anchorViewport.y + (offset ? offset.y : 0),
  };
}

// Is this tracker type one that CAN qualify as a power-user contribution?
// Routine work is deliberately absent: 'member-add' and 'card-edit' are
// what any signed-in user can do, and 'suggestion' alone is intake.
export function isPowerUserContributionType(type) {
  return POWER_USER_CONTRIBUTION_TYPES.includes(type);
}

// Does this tracker entry qualify as a power-user contribution? Both
// conditions must hold: the right kind AND a linked fix. A reported bug
// that was never verified or fixed does not move a satellite and does not
// earn a card entry as a completed contribution — it stays on the card
// only as a reported item (see the contributions data, where reported
// items are explicitly marked as such).
export function isQualifyingContribution(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return isPowerUserContributionType(entry.type) && entry.status === 'Fixed';
}

// Contributions for the card: newest first, scroll for history. Dates are
// ISO strings when known; entries without a known date keep their input
// order at the end, so an undated entry can never jump above a dated one
// by accident. Node's sort is stable, so equal dates keep input order.
export function sortContributionsNewestFirst(contributions) {
  const list = Array.isArray(contributions) ? [...contributions] : [];
  return list.sort((a, b) => {
    const da = a && a.date ? Date.parse(a.date) : NaN;
    const db = b && b.date ? Date.parse(b.date) : NaN;
    if (Number.isNaN(da) && Number.isNaN(db)) return 0;
    if (Number.isNaN(da)) return 1;
    if (Number.isNaN(db)) return -1;
    return db - da;
  });
}

// Node counts, solver inputs, and game rosters must never see the
// satellite. This is the single filter for all of them: drop anything
// whose id is a satellite id, whose layer is the contributor layer, or
// whose type is the satellite type. The Sigma integration does not even
// need this filter (the satellite is never added to the view graph), but
// any future code that merges view data with contributor data must pass
// through it, and the tests pin it.
export function isSatelliteNode(node, satelliteIds = POWER_USER_SATELLITES.map((s) => s.id)) {
  if (!node || typeof node !== 'object') return false;
  if (node.id && satelliteIds.includes(node.id)) return true;
  if (node.layer === POWER_USER_CONTRIBUTOR_LAYER) return true;
  if (node.type === 'power-user-satellite') return true;
  return false;
}

export function countNodesExcludingSatellites(nodes, satelliteIds) {
  if (!Array.isArray(nodes)) return 0;
  return nodes.filter((node) => !isSatelliteNode(node, satelliteIds)).length;
}

export function excludeSatellitesFromNodes(nodes, satelliteIds) {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((node) => !isSatelliteNode(node, satelliteIds));
}

// Two-node rule. A power user who is also a musician has TWO nodes on TWO
// layers, linked by ACCOUNT. This function takes the account id explicitly
// and never takes a name: name matching is how same-name people and bands
// get merged, and that must never happen here. The two ids must be
// distinct; a musician node id that equals the satellite id is a data
// error, not a merge — it is returned as-is with merged: false so callers
// can surface it, never silently collapse it.
export function nodesForPowerUser({ accountId = null, musicianNodeId = null, satelliteNodeId = null } = {}) {
  return {
    accountId,
    musician: musicianNodeId || null,
    satellite: satelliteNodeId || null,
    linkedBy: 'account',
    merged: false,
  };
}

// Card rows for a satellite, in card order (newest first). This is the
// shape the Sigma card renders; it carries no token fields, by design.
export function contributionCardRows(satellite, contributions) {
  if (!satellite) return [];
  const sorted = sortContributionsNewestFirst(contributions);
  return sorted.map((entry) => ({
    id: entry.id || null,
    title: entry.title || 'Contribution',
    type: entry.type || null,
    band: entry.band || null,
    date: entry.date || null,
    status: entry.status || null,
    description: entry.description || '',
    fixLink: entry.fixLink || null,
  }));
}
