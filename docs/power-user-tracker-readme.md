# Power-user tracker — v1 (JWST satellite)

This is the manual tracker behind the JWST power-user satellite. It is
deliberately small: a form/sheet, not a built ticketing system.

## Where feedback comes in

Intake is the site's existing feedback button. In v1, feedback submissions
arrive as they do today (Netlify Form → email); Aaron/Nova transcribe each
one into a row of `power-user-tracker-template.csv`. Do not build a new
backend endpoint for v1 — the sheet IS the system for now.

A row is credited only when the reporter was **signed in**: the form must
be able to attribute the submission to a site account id. A signed-out
submission can still be logged, but it cannot be credited to a power user,
and it cannot move a satellite. The satellite itself is always visible and
its position is global — signed-out viewers see it at its latest fixed
location, because that location reflects a bug already reported and fixed
through this tracker.

## Columns

- `date` — ISO date the issue/suggestion was reported.
- `reporter_id` — signed-in site account id. Never a name: names collide.
  Leave blank for signed-out submissions (which cannot be credited).
- `reporter_handle` — display handle, for humans reading the sheet.
- `is_power_user` — yes/no. This is how the sheet knows a report was
  Scott's versus a regular user's. A regular user's report is still
  tracked; it just does not move a satellite unless the reporter is a
  power user and the item meets the credit rule below.
- `band_view` — the band/view the reporter was on (e.g. `Fleetwood Mac`).
  This is the band the satellite moves to when the ticket is Fixed.
- `type` — one of: `bug`, `nav`, `whole-graph`, `suggestion`.
- `description` — what was reported, in the reporter's words, plus any
  specifics Aaron/Nova add while working it. Do not guess specifics that
  were not reported.
- `status` — one of: `New`, `Verified`, `Fixed`, `Not a hole`,
  `Duplicate`. These exact names are the v1-to-ticketing-system contract:
  a fuller system later reuses them, so v1 rows migrate without renaming.
- `fix_link` — link to the fix (PR, commit, or ship file) once Fixed.
  A ticket is not Fixed without this.
- `credit` — who is credited (the finder), once Fixed.

## The credit rule (locked)

Routine band-member adds and band-card edits do **not** count as
power-user contributions — any signed-in user can already do those.
A power-user contribution must be a real bug, a nav issue, or a
whole-graph enhancement, documented here, worked by Aaron/Nova, and
linked suggestion → fix.

## How a satellite moves in v1 (manual ledger)

1. Tick the ticket `Fixed` in the tracker, with `fix_link` filled in.
2. Add a contribution entry with status `Fixed` to
   `scripts/power-user-contributions.mjs`.
3. Update that satellite's `currentBand` in
   `scripts/power-user-satellite.mjs` to the ticket's `band_view`.
   That update IS the move. No code watches the tracker in v1.

## What is NOT in v1

- No tokens: no starting balance, earn rates, spend, or Total earned /
  Available display. Tokens are shelved until a game needs them. The
  satellite alone is the street cred.
- No screenshot attachment on feedback — that is V2.
- No priority, assignment, or public status page — that is the fuller
  ticketing system later, when traffic justifies it. The v1 fields above
  (same status names, reporter id, fix link) are chosen so that system
  can adopt these rows without renaming.
- No social badge listing (Facebook/Instagram) — parked.
- No producer layer, fantasy game, or any other feature — this tracker
  is only for power-user contributions.
