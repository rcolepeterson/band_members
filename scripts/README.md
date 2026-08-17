# Ingestion pipeline

A read-only tool that proposes new bands to add to the Rock Band Family Tree graph. It cross-references the existing CSV against [MusicBrainz](https://musicbrainz.org/) (member-of-band relations) and [Wikipedia](https://en.wikipedia.org/) (article existence as a notability signal), scores each candidate, and writes three CSVs — one per confidence tier — for the operator to review.

**The pipeline never modifies `seattle_band_members-2-2.csv` or `index.html`.** Its only output is proposal CSVs under `scripts/output/` (gitignored).

## Files

| Path | Purpose |
|---|---|
| `ingest-musicbrainz.mjs` | Main pipeline runner (CLI entrypoint). |
| `musicbrainz.mjs` | MusicBrainz API client. Rate-limited (1 req/s) with on-disk caching. |
| `wikipedia.mjs` | Wikipedia article existence check. On-disk cached. |
| `pipeline-helpers.mjs` | Pure helpers (scoring, name normalization, tenure parsing, CSV emit). Unit-tested. |
| `data/mbid-overrides.json` | Manual disambiguation pins for ambiguous band/person names. |
| `output/` | Generated: `candidates-{high,medium,low}.csv` + `run-summary.json`. Gitignored. |
| `../.cache/musicbrainz/` and `../.cache/wikipedia/` | Raw API responses. Gitignored. Delete to force a fresh fetch. |

## Running

```sh
# Full run — expect ~1-2 hours the first time (MB rate-limited to 1 req/s;
# ~200 seed persons × ~10 relations avg + candidate detail lookups).
node scripts/ingest-musicbrainz.mjs

# Smoke test — first 3 seed persons only. Runs in about 60 seconds fresh
# and near-instantly on subsequent runs (everything is cached).
node scripts/ingest-musicbrainz.mjs --limit 3

# Point at a non-default seed CSV
node scripts/ingest-musicbrainz.mjs --seed some_other.csv

# Force fresh fetches (bypasses cache; still populates cache on the way out)
node scripts/ingest-musicbrainz.mjs --force-refresh
```

## Confidence tiers

Each candidate band is scored on 9 possible points:

| Signal | Points | Meaning |
|---|---|---|
| At least 1 existing-graph member | +2 | The bridge-fill criterion. Guarantees the band isn't an island. |
| At least 3 existing-graph members | +1 additional | Multi-bridge — strong signal. |
| MusicBrainz shows ≥3 members | +2 | Notability floor. Filters solo projects and stub entries. |
| Wikipedia article exists | +2 | Second-source confirmation. |
| MusicBrainz has a city (`begin-area`) | +1 | So scene filters work. |
| MusicBrainz has a start year | +1 | Populates the yearsActive field. |

Tiers:

- **High (≥7):** All the strong signals present. **Policy: auto-merge candidate.** For the first production run, the operator still sanity-checks the CSV before merging so we can calibrate the scoring against real output. After 1–2 successful runs, subsequent high-tier rows should merge without human review.
- **Medium (4–6):** Some signals missing. **Policy: stage for review.** Operator decides row by row.
- **Low (≤3):** Weak evidence. **Policy: reject, but log for debugging.**

The rules and boundaries live in `pipeline-helpers.mjs`; edit them there and the unit tests will guard against silent drift.

## MBID disambiguation

MusicBrainz returns dozens of hits for common band names (e.g. 39 for "Pearl Jam"). The pipeline accepts an unambiguous match — score ≥ 95 for the top hit — otherwise it flags the name and writes nothing for that person. Add an entry to `data/mbid-overrides.json` to pin the correct MBID:

```json
{
  "Pearl Jam": {
    "mbid": "83b9cbe7-9857-49e2-ab8e-b57b01038103",
    "source": "manual",
    "note": "Verified 2026-07-14 — the Seattle grunge band. MB search returns 39 hits."
  }
}
```

## Rate limiting

MusicBrainz enforces 1 request per second per User-Agent. The client in `musicbrainz.mjs` self-throttles to 1050 ms between requests — never bypass it. Wikipedia has no strict limit but the same client caches every response, so re-runs are near-instant.

The full run touches roughly:

- ~200 person name→MBID lookups (skipped for override entries)
- ~1 detail fetch per person
- ~50–200 unique candidate band detail fetches
- 1 Wikipedia check per candidate

Total ≈ 500–1,500 network requests. First run: 1–2 hours. Subsequent runs: seconds.

## Output layout

After a run, `scripts/output/` contains:

```
candidates-high.csv     # Auto-merge tier. Ready to append to the seed CSV.
candidates-medium.csv   # Needs human review.
candidates-low.csv      # Rejected. Kept for debugging the scoring.
run-summary.json        # Full audit trail: per-candidate signals, resolved MBIDs,
                        # unresolved names, and cache stats. Not for human reading;
                        # keep it around for replaying decisions or diffing runs.
```

Each row in the tier CSVs has:

```
tier,score,name,mbid,city,country,begin,end,existingConnections,memberCount,
wikipediaExists,wikipediaDisambiguation,bridgesFrom
```

`bridgesFrom` is a semicolon-delimited list of existing-graph member names — a quick audit that the "bridge" signal was real.

## Follow-up PRs (not yet built)

- **PR 2 — bridge fill:** consume `candidates-high.csv` and produce a diff patch against `seattle_band_members-2-2.csv`. Auto-merges after human review of the first batch.
- **PR 3 — cluster expand:** relax the "must connect to existing graph" gate; add ~200 well-connected bands chosen by MB tag/scene affinity.

## Testing

```sh
npm test
```

Runs 68 tests. The 24 new tests in `tests/pipeline-helpers.test.mjs` cover name normalization, tenure formatting, confidence scoring, and CSV emission. Network layers (MusicBrainz + Wikipedia clients) are intentionally not mocked — the pipeline reads them from cache during dry runs.


## Layout quality harnesses (Sigma explorer, issue #80)

The Sigma neighborhood layout is checked by two harnesses instead of by looking
at screenshots. Both were added after a run of layout bugs -- overlapping
members, missing names, nodes sitting on unrelated edges, a phantom anchor star
-- each of which was a property we could have stated up front.

### `npm test` -> tests/layout-invariants.test.mjs

Pure geometry, no browser, runs in CI on every push. Sweeps a matrix of graph
shapes x anchors x hop/node budgets and asserts:

- every visible node gets a position, and no two share coordinates
- no two nodes are closer than the separation floor
- no edge passes through a node it is not attached to, measured against the
  CURVE that actually gets drawn
- each degree of separation reads as further from the anchor
- nothing unrelated crosses the anchor
- the same view produces identical coordinates every time

Graph shapes live in `tests/helpers/layout-checks.mjs`, including
`tests/fixtures/live-graph-sample.json` -- a trimmed snapshot of the real graph,
because live data takes lopsided, cross-linked shapes no hand-written fixture
thought of. **When a layout bug is reported, add the shape that produced it.**

`KNOWN_TIGHT` in the test file records the handful of dense real-data views that
still have tight spots, with an allowance each: a regression fails, and so does
an improvement (with a message telling you to lower the number).

### `npm run audit:layout` -> scripts/layout-audit.mjs

The same properties in real rendered pixels, because only a live page knows node
radii, label culling and camera framing. Needs a local Chromium; not in CI.

    npm run audit:layout                          # against http://127.0.0.1:8123
    node scripts/layout-audit.mjs --url https://deploy-preview-81--bandmembers.netlify.app/
    node scripts/layout-audit.mjs --shots ./audit-shots

Sweeps viewport sizes (including a tall window and a phone) x view states
(opening, highlight, search, expanded, expanded twice) and additionally catches
unnamed nodes, clipped labels, phantom overlays and console errors.

### `npm run test:layout` -> scripts/layout-tune.mjs

Sweeps layout tuning constants against the invariant checks and reports which
combinations are clean, so the constants are chosen by measurement rather than by
feel. `--current` just checks today's defaults.

### Refreshing the live fixture

Serve the site locally, then in a scratch script with `playwright-core`, load
`?renderer=sigma`, read `window.RBFT_MASTER_GRAPH`, trim it to the multi-hop
neighbourhoods of a few interesting anchors, and write
`tests/fixtures/live-graph-sample.json`. Keep it small -- it exists to be
representative, not complete.
