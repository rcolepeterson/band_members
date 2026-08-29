// Years active and per-membership tenure must survive the pipeline.
//
// WHY THIS EXISTS
//
// The MusicBrainz payload the ingestion already fetches — and already pays the
// rate limit for — carries a life-span for the band and a begin/end for every
// individual membership. The pipeline read those only as a yes/no confidence
// signal (hasBeginYear) and then threw the actual values away, so nothing ever
// reached the database.
//
// Measured against production on 2026-08-29: 495 of 499 bands had no
// years_active, all 2,757 musicians were missing theirs, and all 3,813
// memberships had a null tenure. That is why a node card reads "YEARS ACTIVE —"
// and why every membership chip shows a bare name with no dates beside it.
//
// This is a data-plumbing property: it fails silently. The pipeline still runs,
// the bands still import, and the only symptom is empty columns nobody notices
// until they look at a card. Hence tests rather than trust.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { formatTenure } from '../scripts/pipeline-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const INGEST = readFileSync(join(REPO, 'scripts', 'ingest-batch.mjs'), 'utf8');
const SEED_ENDPOINT = readFileSync(join(REPO, 'netlify', 'functions', 'seed_bands.mjs'), 'utf8');

// -----------------------------------------------------------------------
// The proposed-rows schema carries the columns at all.
// -----------------------------------------------------------------------

test('the proposed-rows CSV schema includes Years Active and Tenure', () => {
  const block = INGEST.slice(INGEST.indexOf('const SEED_HEADERS = ['), INGEST.indexOf('];', INGEST.indexOf('const SEED_HEADERS = [')));
  assert.ok(block.includes("'Years Active'"), 'Expected a Years Active column in the proposed-rows schema.');
  assert.ok(block.includes("'Tenure'"), 'Expected a Tenure column in the proposed-rows schema.');
});

test('the band life-span and the membership dates are read from the MB payload', () => {
  // Two distinct facts, and conflating them is the easy mistake: the band's
  // life-span is when the BAND existed; tenure is when THIS musician was in it.
  assert.match(
    INGEST,
    /const yearsActive = formatTenure\(\{\s*begin: self\.begin/,
    'Expected the band years to come from the MB life-span.'
  );
  assert.match(
    INGEST,
    /Tenure: formatTenure\(rel\)/,
    'Expected per-membership tenure to come from the relation, not the band life-span.'
  );
});

// -----------------------------------------------------------------------
// The columns match what the write path actually reads.
// -----------------------------------------------------------------------

test('the seed endpoint reads the exact header spellings the pipeline emits', () => {
  // A column named something the endpoint does not recognise is silently
  // dropped, which looks identical to not collecting it at all.
  assert.ok(
    SEED_ENDPOINT.includes("row['Years Active']"),
    "Expected seed_bands.mjs to read row['Years Active']."
  );
  assert.ok(
    SEED_ENDPOINT.includes('row.tenure || row.Tenure'),
    'Expected seed_bands.mjs to read row.Tenure.'
  );
});

test('the write path fills empty columns and cannot overwrite entered data', () => {
  // coalesce(nullif(...)) is what makes a bulk backfill safe to run against a
  // live table: a human-entered value always wins over MusicBrainz.
  assert.match(
    SEED_ENDPOINT,
    /years_active = coalesce\(nullif\(bands\.years_active, ''\), excluded\.years_active\)/,
    'Expected the band years backfill to preserve existing values.'
  );
});

// -----------------------------------------------------------------------
// Enrichment proposes years for bands already in the graph.
// -----------------------------------------------------------------------

test('the enrichment pass proposes years_active for an existing band', () => {
  // The function's own header comment claimed this for a long time while the
  // code only ever proposed city, country and genre.
  const start = INGEST.indexOf('function proposeEnrichments');
  const body = start >= 0 ? INGEST.slice(start, start + 4000) : INGEST;
  assert.ok(
    body.includes("field: 'years_active'"),
    'Expected an years_active enrichment proposal.'
  );
  assert.ok(
    body.includes("!row['Years Active']"),
    'Expected the proposal to be gated on the column being empty, so it never overwrites.'
  );
});

// -----------------------------------------------------------------------
// The formatting itself, which is what a visitor actually reads.
// -----------------------------------------------------------------------

test('an ended band reads as a closed range and a live one as present', () => {
  // The distinction matters: a band with no end date recorded is not the same
  // thing as a band still playing, and MB says which via `ended`.
  assert.equal(formatTenure({ begin: '1969', end: '1980', ended: true }), '1969-1980');
  assert.equal(formatTenure({ begin: '1973-01-01', end: '', ended: false }), '1973-present');
  assert.equal(formatTenure({ begin: '1973', end: '', ended: true }), '1973');
});

test('a single-year membership is not rendered as a range', () => {
  assert.equal(formatTenure({ begin: '1991', end: '1991', ended: true }), '1991');
});

test('missing dates produce an empty string, not a half-range', () => {
  // An empty value leaves the column blank so the backfill can fill it later;
  // a half-formed "1969-" would look like real data and block that.
  assert.equal(formatTenure({}), '');
  assert.equal(formatTenure({ begin: '', end: '', ended: false }), '');
});
