// Retry/backoff for the MusicBrainz client.
//
// WHY THIS EXISTS
//
// MusicBrainz answers a busy moment with 503 and a JSON body reading "The
// MusicBrainz web server is currently busy. Please try again later." From a
// datacenter IP this is not rare: preparing batch 7, roughly two requests in
// three came back 503, and several in a row on the same URL was routine.
//
// Before the retry existed, the first 503 threw and killed the whole run —
// twenty minutes and several hundred lookups in, with the operator left to
// rerun from the top. The first version of the retry allowed four attempts,
// which was still not enough: one seed person (Robert Plant) burned five
// straight 503s and was silently dropped from the batch.
//
// The properties below are what keep a long run survivable, and none of them
// are visible from the pipeline's output when they regress — the run just
// quietly returns fewer bands than it should.
import test from 'node:test';
import assert from 'node:assert/strict';

import { retryDelayMs, MUSICBRAINZ_HEADERS } from '../scripts/musicbrainz.mjs';

test('backoff grows between attempts', () => {
  // Compared on floors rather than exact values, because the delay is jittered.
  const first = retryDelayMs(0);
  const third = retryDelayMs(2);
  assert.ok(first >= 1500, `Expected the first delay to respect the base, got ${first}`);
  assert.ok(third > first, `Expected backoff to grow: attempt 3 (${third}) vs attempt 1 (${first})`);
});

test('backoff never drops below MusicBrainz\'s courtesy rate', () => {
  // MB asks for no more than one request a second. A jittered delay that could
  // round down under that turns a retry storm into a rate-limit violation.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (let i = 0; i < 25; i += 1) {
      assert.ok(
        retryDelayMs(attempt) >= 1000,
        `Attempt ${attempt} produced ${retryDelayMs(attempt)}ms, under MB's 1 req/sec limit`
      );
    }
  }
});

test('backoff is capped so a dead service fails the run instead of hanging it', () => {
  for (const attempt of [8, 12, 40]) {
    assert.ok(
      retryDelayMs(attempt) <= 30000,
      `Attempt ${attempt} produced ${retryDelayMs(attempt)}ms — an unbounded wait hangs the batch`
    );
  }
});

test('a Retry-After header wins over our own guess', () => {
  // When MB says when it will be ready, guessing something shorter is how you
  // earn a block rather than a retry.
  assert.equal(retryDelayMs(0, '9'), 9000);
  assert.equal(retryDelayMs(3, '2'), 2000);
});

test('an absurd Retry-After is still capped', () => {
  assert.ok(retryDelayMs(0, '3600') <= 30000, 'A one-hour Retry-After must not stall the batch.');
});

test('a non-numeric Retry-After falls back to backoff rather than NaN', () => {
  const delay = retryDelayMs(1, 'Wed, 21 Oct 2026 07:28:00 GMT');
  assert.ok(Number.isFinite(delay) && delay >= 1000, `Expected a usable delay, got ${delay}`);
});

test('jitter actually varies, so retries do not resynchronise', () => {
  // Every retry in a run is otherwise scheduled on the same grid: requests that
  // get 503'd together come back together and get 503'd together again.
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) seen.add(retryDelayMs(2));
  assert.ok(seen.size > 1, 'Expected jittered delays, got a single constant value.');
});

test('the User-Agent identifies the current site and a contact', () => {
  // MB throttles per User-Agent as well as per IP, and their policy asks for an
  // application name, a version and a contact. The UA also outlived the rename:
  // it still said RockBandFamilyTree.
  const ua = MUSICBRAINZ_HEADERS['User-Agent'];
  assert.match(ua, /SixDegreesOfRock\/\d/, 'Expected an app name and version.');
  assert.match(ua, /sixdegreesofrock\.com/, 'Expected the current site, not the retired name.');
  assert.match(ua, /@/, 'Expected a contact address, per MusicBrainz policy.');
  assert.ok(
    !/RockBandFamilyTree|RBFT/i.test(ua),
    'The retired project name should not survive in the User-Agent.'
  );
});
