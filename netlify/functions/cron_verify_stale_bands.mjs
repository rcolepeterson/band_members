// Scheduled function: daily sweep that keeps the `verifications` table
// warm for bands nobody has happened to open (and trigger an on-demand
// check for) recently, so the silver-star badge coverage grows over time
// even for bands with low foot traffic in the UI.
//
// Netlify scheduled functions (v2 syntax): the `config.schedule` export
// below is a standard cron expression, evaluated in UTC by Netlify's
// scheduler. "0 10 * * *" is 10am UTC daily = 3am Pacific during PDT
// (UTC-7) and 2am Pacific during PST (UTC-8). We deliberately do not try
// to chase the DST boundary with two cron entries — this is a background
// maintenance job with no user-visible deadline, so a one-hour seasonal
// drift is an accepted tradeoff for a single simple schedule expression.
//
// Important Netlify constraint: scheduled functions "can't be invoked
// directly with a URL" per Netlify's scheduled-functions docs — a
// `config.schedule` export takes over this file's routing entirely, so
// there is no way to also expose an HTTP-reachable path from the same
// file. That's why the manual on-demand trigger described in the PR spec
// lives in its own file, cron_verify_stale_bands_trigger.mjs, which
// imports and calls `runBatch` (exported below) so both entry points run
// identical selection/verification logic and can't drift apart.
//
// Batch size: N=10 bands per run. MusicBrainz asks for 1 req/sec
// (MUSICBRAINZ_SLEEP_MS below, matching verify_band.mjs); each band makes
// one Wikipedia call (no meaningful delay) plus one MusicBrainz call
// preceded by the 1s sleep. That's roughly 1-2s of *sleep* per band, plus
// actual network latency for two HTTP calls. Netlify's default scheduled-
// function execution budget is 26s, so 10 bands x ~2s = ~20s of sleep
// leaves only ~6s of slack for real network latency across 20 external
// requests, which is tight. We chose N=10 (not a higher number) precisely
// because the task's own budget math flagged 20 as unsafe; if this proves
// too tight in production, lowering N further is a one-line change below,
// not a redesign.
//
// Selection query: a band is "stale" when it has never been verified, or
// when its verification is either older than 24h or predates the band's
// last edit (bands.updated_at bumped by the existing trigger) — the exact
// same two invalidation conditions verify_band.mjs already applies to its
// own cache-hit check, just expressed as a WHERE clause instead of
// per-row JS so Postgres can pick out only the stale rows instead of the
// function fetching everything and filtering in memory.
//
// Errors: a failure fetching/scoring one band is logged and skipped so a
// single bad band (unreachable name, MB/Wiki both down that moment, etc.)
// never aborts the rest of the batch. This mirrors the "skip on error, log
// and continue" instruction in the PR description, and is a deliberate
// departure from verify_band.mjs's on-demand endpoint, which is allowed to
// fail loudly for a single band since a human is waiting on that call.

import {
  getSql,
  isDbConfigured,
  ok,
  dbUnavailable,
  serverError,
} from './_db.mjs';
import { fetchMusicBrainz, fetchWikipedia, scoreVerification } from './_verify_helpers.mjs';

const MUSICBRAINZ_SLEEP_MS = 1000; // MB's documented 1 req/sec courtesy limit
export const BATCH_SIZE = 10; // see header comment for the Netlify time-budget math; exported for tests

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildSources(mbArtist, wikiPage) {
  const musicbrainz = mbArtist
    ? { mbid: mbArtist.id, url: `https://musicbrainz.org/artist/${mbArtist.id}` }
    : null;
  const wikipedia = wikiPage && wikiPage.content_urls && wikiPage.content_urls.desktop
    ? { title: wikiPage.title, url: wikiPage.content_urls.desktop.page }
    : (wikiPage ? { title: wikiPage.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent((wikiPage.title || '').replace(/\s+/g, '_'))}` } : null);
  return { musicbrainz, wikipedia };
}

// Select up to `limit` stale/unverified bands. Exported so tests can call
// it directly against a mocked `sql` without going through the HTTP
// handler. A band qualifies when:
//   - it has no row in `verifications` at all (left join is null), OR
//   - its verification is older than 24h, OR
//   - its verification predates the band's last edit (bands.updated_at)
// Ordered oldest-verified-first (nulls first) so bands that have NEVER
// been checked are prioritized over ones merely due for a refresh.
export async function selectStaleBands(sql, limit) {
  return sql`
    select b.id, b.name, b.city, b.country, b.genre, b.years_active, v.verified_at
    from bands b
    left join verifications v on v.band_id = b.id
    where v.verified_at is null
       or v.verified_at < now() - interval '24 hours'
       or v.verified_at < b.updated_at
    order by v.verified_at asc nulls first
    limit ${limit}
  `;
}

// Verify a single band and upsert the result. Shared by the scheduled
// handler and the manual-trigger path so both exercise identical logic —
// no drift between "what runs at 3am" and "what the admin can trigger for
// testing". Returns { ok: true } or { ok: false, error } and never throws;
// callers loop over a batch and must not have one bad band abort the rest.
export async function verifyOneBand(sql, band) {
  try {
    const wikiResult = await fetchWikipedia(band.name);
    await sleep(MUSICBRAINZ_SLEEP_MS);
    const mbResult = await fetchMusicBrainz(band.name, { country: band.country });

    if (!mbResult.ok && !wikiResult.ok) {
      return { ok: false, error: 'both MusicBrainz and Wikipedia lookups failed' };
    }

    const mbArtist = mbResult.ok ? mbResult.artist : null;
    const wikiPage = wikiResult.ok ? wikiResult.page : null;

    const { overall_score, breakdown } = scoreVerification(band, mbArtist, wikiPage);
    const sources = buildSources(mbArtist, wikiPage);

    await sql`
      insert into verifications (band_id, verified_at, overall_score, breakdown, musicbrainz_mbid, musicbrainz_url, wikipedia_title, wikipedia_url)
      values (
        ${band.id}, now(), ${overall_score}, ${JSON.stringify(breakdown)}::jsonb,
        ${sources.musicbrainz ? sources.musicbrainz.mbid : null},
        ${sources.musicbrainz ? sources.musicbrainz.url : null},
        ${sources.wikipedia ? sources.wikipedia.title : null},
        ${sources.wikipedia ? sources.wikipedia.url : null}
      )
      on conflict (band_id) do update set
        verified_at = excluded.verified_at,
        overall_score = excluded.overall_score,
        breakdown = excluded.breakdown,
        musicbrainz_mbid = excluded.musicbrainz_mbid,
        musicbrainz_url = excluded.musicbrainz_url,
        wikipedia_title = excluded.wikipedia_title,
        wikipedia_url = excluded.wikipedia_url
    `;

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : 'unknown error' };
  }
}

// Runs the batch: pick up to BATCH_SIZE stale bands, verify each in turn
// (sequentially — MusicBrainz's rate limit is global, not per-band, so
// parallelizing would just trip 429s), and return a summary. Shared by
// both this file's scheduled `export default` handler and the manual
// POST trigger in cron_verify_stale_bands_trigger.mjs — exported so that
// second file (and tests) can call it directly.
export async function runBatch(sql, batchSize = BATCH_SIZE) {
  const candidates = await selectStaleBands(sql, batchSize);

  let succeeded = 0;
  let failed = 0;
  for (const band of candidates) {
    console.log(`[cron:verify] checking band_id=${band.id} name="${band.name}"`);
    const result = await verifyOneBand(sql, band);
    if (result.ok) {
      succeeded += 1;
      console.log(`[cron:verify] ok band_id=${band.id}`);
    } else {
      failed += 1;
      console.error(`[cron:verify] failed band_id=${band.id}: ${result.error}`);
    }
  }

  // A second, cheap count so the summary tells the caller how much stale
  // backlog remains after this run — useful for deciding whether N needs
  // to go up, without a separate query round trip from the caller. Capped
  // at a generous 500 (the app's whole-dataset scale) rather than
  // unbounded, so this stays a cheap indicative count, not a full scan.
  const remaining = await selectStaleBands(sql, 500);
  const nextStaleCount = remaining.length;

  return {
    processed: candidates.length,
    succeeded,
    failed,
    next_stale_count: nextStaleCount,
  };
}

// Scheduled entry point. Netlify invokes this on the cron below with no
// meaningful request body/auth context, so — unlike the manual trigger —
// there is no admin-token check here; the schedule itself is the access
// control (only Netlify's own scheduler can invoke a `config.schedule`
// function this way; it is not reachable as a public HTTP route).
export default async (req) => {
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();

  try {
    // Sweep spent rate-limit rows while we are already here on a schedule.
    //
    // The counter table holds one row per distinct caller, reused across windows, so
    // it grows with the number of people who have ever visited rather than with
    // traffic -- slowly, but without bound. A day is comfortably longer than the
    // longest window (an hour), so nothing still being counted is removed.
    //
    // Deliberately not fatal: this is housekeeping, and losing it must not cost us
    // the verification batch that is the actual job of this cron.
    let sweptRateLimits = null;
    try {
      const swept = await sql`
        delete from rate_limits where window_start < now() - interval '1 day' returning bucket
      `;
      sweptRateLimits = swept.length;
      if (sweptRateLimits) console.log(`[cron:verify] swept ${sweptRateLimits} spent rate-limit rows`);
    } catch (sweepErr) {
      console.warn('[cron:verify] rate-limit sweep failed; continuing with the batch', sweepErr);
    }

    const summary = await runBatch(sql);
    console.log(`[cron:verify] batch complete: processed=${summary.processed} succeeded=${summary.succeeded} failed=${summary.failed} next_stale_count=${summary.next_stale_count}`);
    return ok({ ...summary, swept_rate_limits: sweptRateLimits });
  } catch (err) {
    console.error('[cron:verify] batch failed entirely', err);
    return serverError('cron batch failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

// Netlify Functions v2 scheduled-function syntax. 10am UTC daily; see the
// header comment for the DST tradeoff.
export const config = { schedule: '0 10 * * *' };
