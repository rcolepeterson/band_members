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
// HONESTY RULE: do not invent specific band/member details. The two entries
// below are exactly what is known about Scott's finds so far — the
// categories "Fleetwood Mac holes" and "missing band cards" — and both are
// explicitly marked as needing specifics from the tracker. They are
// status 'Reported', NOT 'Fixed', so they must never be presented as
// completed contributions, and they must never be counted as qualifying
// contributions by isQualifyingContribution() in power-user-satellite.mjs
// (which requires status 'Fixed').
//
// NO TOKEN FIELDS: tokens are shelved for v1. Do not add balances, earn
// rates, or spend fields to these entries.
// ---------------------------------------------------------------------------

export const SCOTT_CONTRIBUTIONS = [
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
