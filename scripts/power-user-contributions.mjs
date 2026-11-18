// ---------------------------------------------------------------------------
// Power-user contributions data — manually maintained by Aaron/Nova (v1).
//
// This is the card's data source, and it is deliberately a hand-maintained
// list, not a live query: v1 has no built suggestion system, only the
// tracker sheet (docs/power-user-tracker-template.csv). When a ticket is
// ticked Fixed in the tracker, add an entry here with status 'Fixed' and
// the fix link, and update the satellite's `currentBand` in
// scripts/power-user-satellite.mjs to the fixed band — that update IS the
// satellite's move in v1.
//
// HONESTY RULE: do not invent specific band/member details. The last two
// entries below are placeholders for Scott's earlier finds — the
// categories "Fleetwood Mac holes" and "missing band cards" — explicitly
// marked as needing specifics from the tracker. They stay status
// 'Reported', NOT 'Fixed', must never be presented as completed
// contributions, and must never be counted as qualifying contributions.
// The War entry is different: a specific, verified catch (duplicate
// member rows), fixed 2026-11-18, so it carries real details and status
// 'Fixed' — it IS a qualifying contribution under
// isQualifyingContribution() in power-user-satellite.mjs (which requires
// status 'Fixed').
//
// NO TOKEN FIELDS: tokens are shelved for v1. Do not add balances, earn
// rates, or spend fields to these entries.
// ---------------------------------------------------------------------------

export const SCOTT_CONTRIBUTIONS = [
  {
    id: 'scott-war-duplicate-members',
    title: 'War duplicate members',
    type: 'bug',
    band: 'War',
    date: '2026-11-18',
    status: 'Fixed',
    description:
      'War\'s card listed 14 members for 8 people — name variants (Leroy "Lonnie" Jordan, B. B. Dickerson, Howard E. Scott, Harold Ray Brown, Thomas Allen) had been imported as separate people. Merged 2026-11-18: War now lists its 8 actual members, and the graph-wide scan this catch triggered cleaned 16 more split identities (Brain Mantia, Jim O\'Rourke, D.J. Bonebrake, and others).',
    fixLink: null,
  },
  {
    id: 'scott-fleetwood-mac-holes',
    title: 'Fleetwood Mac holes',
    type: 'whole-graph',
    band: 'Fleetwood Mac',
    date: null,
    status: 'Reported',
    description:
      'Specific band/member details to be filled from the tracker — not yet documented in detail. Do not guess them.',
    fixLink: null,
  },
  {
    id: 'scott-missing-band-cards',
    title: 'Missing band cards',
    type: 'nav',
    band: null,
    date: null,
    status: 'Reported',
    description:
      'Specific bands/cards to be filled from the tracker — not yet documented in detail. Do not guess them.',
    fixLink: null,
  },
];

// Contributions by satellite id, so a second power user later is just a
// new key here plus a new entry in POWER_USER_SATELLITES. Scott is the
// only power user in v1.
export const POWER_USER_CONTRIBUTIONS_BY_SATELLITE = Object.freeze({
  'power-user-satellite:scott': SCOTT_CONTRIBUTIONS,
});
