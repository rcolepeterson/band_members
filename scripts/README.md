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
