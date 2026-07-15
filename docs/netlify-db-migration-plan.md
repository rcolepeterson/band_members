# Netlify Blobs → Netlify DB migration plan

**Status**: planned, not scheduled. This document describes what the migration will look like when we outgrow the current Blobs-based storage. As of PR 16 (2026-07-14) we have an audit log in place to detect a race-driven lost write; when we see one, or when the submissions blob passes ~5 MB, this plan gets executed.

---

## Where we are today

- Backend: `netlify/functions/bands.mjs`, Netlify Functions v2.
- Storage: `@netlify/blobs`. Two site-scoped stores:
  - `band-submissions` — single JSON array of drafts under the key `submissions`. Read-modify-write on every POST/DELETE.
  - `band-submissions-audit` — append-only, one blob per event, added in PR 16.
- Client: `index.html` calls `/.netlify/functions/bands` on load (GET) and on the "Add your band" flow (POST). Server returns the drafts array; client's `applyDraftToMaster()` folds each draft into the in-memory graph.
- Deploys: static site served from repo root, Functions bundled with esbuild. No build step.

**Constraints inherited by any migration**:
- Draft shape is locked. Server returns objects the client's `applyDraftToMaster()` already knows how to consume; we don't want to touch the client-side folding logic during the storage migration.
- Schema is USPS-style: `city` (plain text), `state` (USPS 2-letter, US only), `country` (ISO 3166-1 alpha-3).
- Multi-member submissions: each draft carries a `members[]` array of `{ member, instrument, relation }`.
- The audit store already models each write as its own row — natural fit for a relational table.

---

## Why Netlify DB

- Zero-config from a Netlify site's perspective: connection string is injected as an environment variable, no separate account.
- Backed by Neon Postgres (managed, autoscaling, branching for previews).
- Same team, same billing, same auth surface. Reduces the "one more vendor" tax.
- Migrating from Blobs to Postgres is exactly the path Netlify documents in [their DB launch post](https://www.netlify.com/blog/netlify-db/).
- Free tier is generous (roughly 0.5 GB storage, plenty of compute for our load); a paid tier at ~$25/mo covers well past the scale where we'd care.

Trade-offs vs. alternatives:

| Option | Pro | Con |
|---|---|---|
| **Netlify DB (Neon Postgres)** | Zero-vendor-add, native Netlify integration, real SQL, preview-branch isolation | Netlify lock-in (though the DB is portable Postgres) |
| Supabase | Auth + realtime + storage in one, larger ecosystem | Separate account, separate billing, more moving parts than we need |
| Turso / Cloudflare D1 | SQLite at the edge, cheapest, lowest latency | Extra vendor, less mature Netlify integration, SQLite quirks |

For our use case — one small table of submissions, one small audit table, no realtime, no auth flow beyond the admin token — Netlify DB is the cleanest fit.

---

## Target schema

Two tables. Both have surrogate ids (UUIDs, matching what the current draft `id` field already uses). Draft objects flatten cleanly: no JSONB required for anything the graph needs, but we keep a `raw` column for forward-compat with fields the client adds later.

```sql
-- Every accepted submission. Drop-in replacement for the JSON array in the
-- `submissions` blob today; each row is one draft.
CREATE TABLE submissions (
  id            UUID PRIMARY KEY,
  band          TEXT NOT NULL,
  city          TEXT NOT NULL DEFAULT '',
  state         CHAR(2)  NOT NULL DEFAULT '',  -- USPS 2-letter, US only
  country       CHAR(3)  NOT NULL DEFAULT '',  -- ISO 3166-1 alpha-3
  genre         TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  years_active  TEXT NOT NULL DEFAULT '',
  label         TEXT NOT NULL DEFAULT '',
  albums        TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL,                 -- 'new-band-entry' | 'existing-band-connection'
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw           JSONB NOT NULL,                -- full original draft for forward-compat
  -- Soft moderation flags for the future queue (not used at migration time)
  hidden        BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_reason TEXT
);

CREATE INDEX submissions_saved_at_idx ON submissions (saved_at DESC);
CREATE INDEX submissions_country_state_city_idx ON submissions (country, state, city);
CREATE INDEX submissions_band_lower_idx ON submissions (lower(band));

-- One row per band member listed in a submission. Foreign-keyed to submissions
-- so a DELETE cascades and we don't leak orphan rows.
CREATE TABLE submission_members (
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  ordinal       SMALLINT NOT NULL,             -- position in the original members[] array
  member        TEXT NOT NULL,
  instrument    TEXT NOT NULL DEFAULT '',
  relation      SMALLINT NOT NULL DEFAULT 2,
  PRIMARY KEY (submission_id, ordinal)
);

-- Direct port of the audit log store from PR 16. Same event shape, now
-- queryable (WHERE event='submission_accepted' AND at > now() - '7 days').
CREATE TABLE submission_audit (
  id            BIGSERIAL PRIMARY KEY,
  event         TEXT NOT NULL,                 -- 'submission_accepted' | 'submission_deleted'
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  submission_id UUID,
  ip            TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  draft         JSONB
);

CREATE INDEX submission_audit_at_idx ON submission_audit (at DESC);
CREATE INDEX submission_audit_submission_idx ON submission_audit (submission_id);
```

Notes:

- **Atomic writes**: `INSERT INTO submissions ...` is a single row-level transaction. No more read-modify-write race. Two concurrent submissions cannot collide.
- **Cascading delete**: DELETE from `submissions` automatically removes rows in `submission_members`. No manual cleanup, no orphans.
- **Fast queries**: the `country, state, city` composite index makes "show me bands from Seattle" a sub-millisecond lookup even at 100k rows.
- **Raw JSON as fallback**: the `raw` column stores the whole original draft. If we add a field to the draft next month, existing rows still round-trip through `applyDraftToMaster()` without a schema migration first.

---

## The migration itself — six steps

### 1. Provision the DB and get the connection string

- Netlify UI → Site settings → Extensions → "Netlify DB" → enable.
- Netlify auto-injects `NETLIFY_DATABASE_URL` (Postgres connection string) into every function invocation as an env var.
- Locally, run `netlify dev` and the same env var is proxied through so functions get real DB access without hardcoded credentials.

### 2. Add a schema-migration script

`scripts/db-migrate.mjs` — idempotent, safe to re-run:

```js
import { neon } from '@netlify/neon';
const sql = neon();

await sql`CREATE TABLE IF NOT EXISTS submissions ( ... )`;
await sql`CREATE INDEX IF NOT EXISTS ... `;
// etc.
```

Run once against production and once against preview.

### 3. Backfill from the current Blobs store

`scripts/db-backfill.mjs`:

1. `GET /.netlify/functions/bands` — pulls the current submissions array.
2. For each draft, `INSERT INTO submissions ... ON CONFLICT (id) DO NOTHING` — idempotent, so re-running is safe.
3. For each draft's `members[]`, `INSERT INTO submission_members ...`.
4. Optionally `GET /.netlify/functions/bands?audit=1` and backfill the audit table too.

Run against production with the current Blobs data intact. Nothing switches over yet.

### 4. Dual-write cutover (safest possible transition)

For one deploy — probably a week — the function writes to **both** Blobs and DB, but still reads from Blobs. This is the "in case the DB migration is broken, we can revert instantly without data loss" phase:

```js
// POST handler, transitional
await store.setJSON(BLOB_KEY, [...submissions, draft]);   // existing path
try { await sql`INSERT INTO submissions ...`; }           // new path, best-effort
catch (err) { console.error('DB dual-write failed', err); }
```

Verify daily during this window: does the audit log row count in DB match the delta in Blobs? If yes, the DB writes are working.

### 5. Cut reads over to DB

Change the GET handler to read from Postgres:

```js
const rows = await sql`
  SELECT s.*, coalesce(json_agg(json_build_object(
    'member', m.member, 'instrument', m.instrument, 'relation', m.relation
  ) ORDER BY m.ordinal), '[]'::json) AS members
  FROM submissions s
  LEFT JOIN submission_members m ON m.submission_id = s.id
  WHERE NOT s.hidden
  GROUP BY s.id
  ORDER BY s.saved_at DESC
`;
return jsonResponse({ submissions: rows.map(rowToDraft) });
```

Client-side `applyDraftToMaster()` is unchanged because `rowToDraft()` reconstructs the exact draft shape from the row + member array.

Test: run `scripts/test-audit-log.mjs` against the preview URL — it exercises the full POST/GET/DELETE cycle end-to-end.

### 6. Drop the dual-write and archive the Blobs stores

Once we've been on DB-only for a week with no incidents:

- Remove the Blobs write path from `bands.mjs`.
- **Do not delete the Blobs stores yet** — export both to a JSON snapshot in the repo (`docs/archive/blobs-snapshot-YYYYMMDD.json`) as a permanent backup, then let the stores age out.
- Ship the moderation UI: with a real DB, `hidden BOOLEAN` lets us soft-delete spam without losing the audit trail.

---

## What we get on the other side

- **No more race condition on concurrent writes.** The single biggest limitation of the current design goes away.
- **Server-side filtering.** "All bands in Seattle" becomes a WHERE clause; the client doesn't have to fetch every submission just to filter.
- **Real moderation.** Soft-delete via `hidden = TRUE`, keep the row for the audit trail, hide it from the public read.
- **Cheap analytics.** `SELECT country, count(*) FROM submissions GROUP BY 1` — instant answer to "which countries are our users from?" Meaningful for the "GLOBAL" goal.
- **Preview branches get their own DB branch automatically.** Netlify DB integrates with deploy previews so each PR gets an isolated copy of the schema. No more "did that test POST hit production?" worries.

---

## What we do NOT get, and why that's fine

- **No auth system.** The admin token stays as-is for DELETE + audit view; adding user accounts would be a separate project.
- **No realtime.** Frontend still polls on load. If we want live updates ("someone just added a band, refresh the graph"), we'd bolt on Netlify Edge Functions + SSE later.
- **No file uploads.** Band photos / logos aren't in this schema. That's a Netlify Blobs use case that continues after DB migrates — blobs are still good at binary storage, they're just not good at read-modify-write of a shared JSON array.

---

## Rough effort estimate

- **Schema + migration script**: 2–3 hours (mostly writing the mapping between draft shape and row shape).
- **Dual-write phase**: 1 hour to add, then a week of just watching.
- **Read cutover**: 2 hours (the `rowToDraft` reconstruction + updated tests).
- **Verification + cleanup**: 1 hour.
- **Total developer-time: ~1 day of focused work**, spread over ~1.5 weeks of calendar time to leave a monitoring window.

The audit log added in PR 16 is what makes the "watching" phase meaningful. Without it we'd be flying blind during dual-write.

---

## When to pull the trigger

Any one of these is enough:

1. **Confirmed lost write** — the audit log records a `submission_accepted` for an id that's missing from the submissions blob. Root cause is the race condition.
2. **Blob size > 5 MB** — read latency starts to bite, function execution time gets closer to the 10s timeout.
3. **Sustained > 5 submissions/minute** — the collision probability crosses the "eventually will happen" threshold.
4. **We want a scene page** — e.g. `bandmembers.netlify.app/scene/seattle-wa` needs server-side filtering, which Blobs can't do.

Whichever comes first.
