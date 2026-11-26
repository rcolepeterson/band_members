#!/usr/bin/env node
// Apply the verified genre layer (merge/merged_bands.jsonl) to the
// band_genre_data table through POST /api/genre-graph/apply.
//
// Same family as apply-enrichments.mjs: DRY RUN IS THE DEFAULT. Nothing is
// written without --apply, explicitly. The review surface comes first:
//
//   1. node scripts/apply-genre-data.mjs --input <merged_bands.jsonl>
//      -> writes genre-apply-payload.json (the exact rows that would be
//         sent) and prints a review summary. READ THE SUMMARY (and the
//         payload, spot-checking bands you know) before going further.
//   2. node scripts/apply-genre-data.mjs --input <...> --dry-run \
//        --url https://sixdegreesofrock.com
//      -> POSTs batches with dry_run:true; the endpoint diffs against the
//         live table and writes nothing. Read the diff.
//   3. ... --apply --url ...  -> writes. Idempotent: re-running is safe.
//
// Auth: ADMIN_TOKEN from the environment (the same token as /api/migrate),
// sent as the x-admin-token header. Never printed.
//
// The endpoint writes ONLY to band_genre_data. bands.genre and
// bands.years_active are never touched (additive-merge lock). Rows whose
// band_id has no matching band are reported as missing_band, never
// written — e.g. the one-word Sweetwater merge row carries a synthetic
// UUID until the member-graph add lands; apply that first, re-key the
// merge row to the real UUID, then re-run this script.
//
// Usage:
//   node scripts/apply-genre-data.mjs --input <merged_bands.jsonl>
//     [--payload <out.json>] [--url <site-base>] [--dry-run | --apply]
//     [--batch 500] [--limit N]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Map one merge record to the band_genre_data column shape the apply
// endpoint accepts. The FULL merge record rides along as provenance —
// nothing is flattened away (locked provenance rule).
export function mergeRecordToGenreRow(r) {
  const pg = r.primary_genre || null;
  const fa = r.first_album || null;
  const fo = r.formation || null;
  return {
    band_id: r.band_id,
    primary_genre: pg?.value ?? null,
    genre_tier: pg?.tier ?? null,
    genre_sources: pg?.sources ?? [],
    genre_agreement: pg?.agreement_count ?? null,
    fringe_genres: r.fringe_genres ?? [],
    first_album_year: fa?.year ?? null,
    first_album_title: fa?.title ?? null,
    first_album_source: fa?.source ?? null,
    first_album_tier: fa?.tier ?? null,
    formation_year: fo?.begin_year ?? null,
    end_year: fo?.end_year ?? null,
    has_conflict: Array.isArray(r.conflicts) && r.conflicts.length > 0,
    provenance: r,
  };
}

// Review summary over the mapped rows — the numbers Aaron reads before
// any dry run. Debut year = first album, formation fallback (read-time
// rule, mirrored here only for counting).
export function summarizeRows(rows) {
  const s = {
    total: rows.length,
    withGenre: 0, noGenre: 0,
    tiers: {},
    withFirstAlbum: 0, formationOnly: 0, noYear: 0,
    withConflict: 0,
    debutMin: null, debutMax: null,
  };
  for (const r of rows) {
    if (r.primary_genre) {
      s.withGenre++;
      if (r.genre_tier) s.tiers[r.genre_tier] = (s.tiers[r.genre_tier] || 0) + 1;
    } else s.noGenre++;
    const debut = r.first_album_year ?? r.formation_year;
    if (r.first_album_year != null) s.withFirstAlbum++;
    else if (r.formation_year != null) s.formationOnly++;
    else s.noYear++;
    if (debut != null) {
      if (s.debutMin === null || debut < s.debutMin) s.debutMin = debut;
      if (s.debutMax === null || debut > s.debutMax) s.debutMax = debut;
    }
    if (r.has_conflict) s.withConflict++;
  }
  return s;
}

export function parseArgs(argv) {
  const args = {
    input: null, payload: 'genre-apply-payload.json', url: null,
    apply: false, batch: 500, limit: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--payload') args.payload = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--batch') args.batch = Number(argv[++i]) || 500;
    else if (a === '--limit') args.limit = Number(argv[++i]) || null;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE =
  'Usage: node scripts/apply-genre-data.mjs --input <merged_bands.jsonl>\n' +
  '  [--payload <out.json>] [--url <site-base>] [--dry-run | --apply]\n' +
  '  [--batch 500] [--limit N]\n\n' +
  'Dry run is the DEFAULT. Nothing is written without --apply.\n' +
  'Without --url, only the review payload file is written.';

// POST one batch to the apply endpoint; returns the parsed JSON body.
export async function postBatch(fetchImpl, baseUrl, token, rows, dryRun) {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/genre-graph/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ dry_run: dryRun, rows }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    throw new Error(`apply endpoint returned ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

export async function run(argv, { fetchImpl = fetch, log = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.input) {
    log(USAGE);
    return { ok: false, reason: 'usage' };
  }

  const lines = readFileSync(args.input, 'utf8').split('\n').filter((l) => l.trim());
  let rows = lines.map((l) => mergeRecordToGenreRow(JSON.parse(l)));
  if (args.limit) rows = rows.slice(0, args.limit);

  const s = summarizeRows(rows);
  log(`Input:       ${args.input} (${s.total} bands)`);
  log(`With genre:  ${s.withGenre}  (tiers: ${Object.entries(s.tiers).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
  log(`No genre:    ${s.noGenre}`);
  log(`First album: ${s.withFirstAlbum}  ·  formation-only: ${s.formationOnly}  ·  no year: ${s.noYear}`);
  log(`Debut range: ${s.debutMin ?? '—'}–${s.debutMax ?? '—'}  ·  with conflicts: ${s.withConflict}`);
  log(`Mode:        ${args.apply ? 'APPLY (writes)' : 'dry run (no writes)'}`);

  writeFileSync(args.payload, JSON.stringify({ generated_from: args.input, rows }, null, 1));
  log(`Payload:     ${args.payload} written for review`);

  if (!args.url) {
    log('\nNo --url given: payload only. Review it, then re-run with --url <site> --dry-run.');
    return { ok: true, mode: 'payload-only', summary: s };
  }

  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    log('\nADMIN_TOKEN env var is not set — cannot call the apply endpoint. Payload only.');
    return { ok: false, reason: 'no-token', summary: s };
  }

  const totals = { inserts: 0, updates: 0, unchanged: 0, missing: 0, written: 0 };
  const missing = [];
  for (let i = 0; i < rows.length; i += args.batch) {
    const batch = rows.slice(i, i + args.batch);
    const body = await postBatch(fetchImpl, args.url, token, batch, !args.apply);
    totals.inserts += body.inserts || 0;
    totals.updates += body.updates || 0;
    totals.unchanged += body.unchanged || 0;
    totals.written += body.written || 0;
    if (Array.isArray(body.missing_band)) missing.push(...body.missing_band);
    log(`Batch ${Math.floor(i / args.batch) + 1}: ${batch.length} rows -> ` +
      `${body.inserts} inserts, ${body.updates} updates, ${body.unchanged} unchanged` +
      `${body.missing_band?.length ? `, ${body.missing_band.length} missing band` : ''}`);
  }
  totals.missing = missing.length;
  log(`\nTotals: ${totals.inserts} inserts, ${totals.updates} updates, ${totals.unchanged} unchanged, ${totals.missing} missing band` +
    (args.apply ? `, ${totals.written} written` : ''));
  if (missing.length) {
    log('Missing-band rows (no matching band in the DB — reported, never written):');
    for (const id of missing.slice(0, 20)) log(`  ${id}`);
    if (missing.length > 20) log(`  …and ${missing.length - 20} more`);
  }
  if (!args.apply) log('\nDry run. Re-run with --apply to write.');
  return { ok: true, mode: args.apply ? 'apply' : 'dry-run', summary: s, totals, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
