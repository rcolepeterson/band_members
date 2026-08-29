// The verifier must not record a transport failure as a verdict about a band.
//
// WHY THIS EXISTS
//
// fetchMusicBrainz made exactly one attempt. MusicBrainz sheds load with 503 and
// a body reading "The MusicBrainz web server is currently busy." Measured while
// clearing a verification backlog, the identical query answered 503, 503, then
// 200 with AC/DC at relevance score 100 and tags rock / heavy metal.
//
// A band whose single attempt landed on a busy moment was therefore scored from
// Wikipedia alone: genre 0 ("no match found among MusicBrainz tags"), life-span
// partial, area unmatched. AC/DC was stored at 58. That number is not a
// judgement about AC/DC, it is a 503 written into the verifications table, and
// it sits there until something re-verifies the band.
//
// The countervailing constraint is real too: this runs in a scheduled function
// with roughly a 26-second budget for a ten-band batch, so retries have to be
// cheap and the batch has to be willing to stop.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchMusicBrainz,
  MB_RETRY_STATUSES,
  MB_RETRY_DELAYS_MS,
  MB_MAX_RETRIES,
} from '../netlify/functions/_verify_helpers.mjs';
import { BATCH_BUDGET_MS, RETRY_BUDGET_MS, BATCH_SIZE } from '../netlify/functions/cron_verify_stale_bands.mjs';

const BUSY_BODY = { error: 'The MusicBrainz web server is currently busy. Please try again later.' };

function response({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A fetch stub that replays a scripted sequence of responses and records calls.
function stubFetch(sequence) {
  const calls = [];
  return {
    calls,
    impl: async (url) => {
      calls.push(url);
      const next = sequence[Math.min(calls.length - 1, sequence.length - 1)];
      if (next instanceof Error) throw next;
      return response(next);
    },
  };
}

const ARTIST_PAYLOAD = {
  artists: [{ id: 'abc', name: 'AC/DC', score: 100, tags: [{ name: 'rock', count: 9 }], 'life-span': { begin: '1973-11' } }],
};

test('a 503 followed by a 200 yields the artist instead of a failure', () => {
  // The exact sequence observed against the live service.
  const { impl, calls } = stubFetch([
    { status: 503, body: BUSY_BODY },
    { status: 200, body: ARTIST_PAYLOAD },
  ]);
  return fetchMusicBrainz('AC/DC', { country: 'AUS', fetchImpl: impl }).then(result => {
    assert.equal(result.ok, true, `Expected success after a retry, got: ${result.error}`);
    assert.equal(result.artist.name, 'AC/DC');
    assert.equal(calls.length, 2, 'Expected exactly one retry, not more.');
  });
});

test('two consecutive 503s still recover on the third attempt', async () => {
  const { impl, calls } = stubFetch([
    { status: 503, body: BUSY_BODY },
    { status: 503, body: BUSY_BODY },
    { status: 200, body: ARTIST_PAYLOAD },
  ]);
  const result = await fetchMusicBrainz('AC/DC', { fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
});

test('a persistent outage gives up and reports it, rather than retrying forever', async () => {
  const { impl, calls } = stubFetch([{ status: 503, body: BUSY_BODY }]);
  const result = await fetchMusicBrainz('AC/DC', { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.match(result.error, /503/);
  assert.equal(calls.length, MB_MAX_RETRIES + 1, 'Expected a bounded number of attempts.');
});

test('a 404 is a real answer and is not retried', async () => {
  // Retrying a definitive response just burns the batch's time budget.
  const { impl, calls } = stubFetch([{ status: 404, body: {} }]);
  const result = await fetchMusicBrainz('No Such Band', { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, 'A 404 must not be retried.');
});

test('a network throw is retried, then reported', async () => {
  const { impl, calls } = stubFetch([new Error('ECONNRESET')]);
  const result = await fetchMusicBrainz('AC/DC', { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET|unreachable/);
  assert.equal(calls.length, MB_MAX_RETRIES + 1);
});

test('retries can be switched off by the caller', async () => {
  // runBatch passes retries: 0 once it is close to its time budget.
  const { impl, calls } = stubFetch([{ status: 503, body: BUSY_BODY }]);
  const result = await fetchMusicBrainz('AC/DC', { fetchImpl: impl, retries: 0 });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, 'retries: 0 must mean exactly one attempt.');
});

test('only transient statuses are treated as retryable', () => {
  for (const status of [429, 502, 503, 504]) {
    assert.ok(MB_RETRY_STATUSES.has(status), `${status} should be retryable.`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.ok(!MB_RETRY_STATUSES.has(status), `${status} should NOT be retryable.`);
  }
});

test('the retry cost fits inside the batch budget it has to share', () => {
  // The whole point of keeping the delays short: worst-case retry time for one
  // band must be a rounding error against the batch budget, not a threat to it.
  const worstCaseRetryMs = MB_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(
    worstCaseRetryMs <= 2000,
    `Retry budget for one band is ${worstCaseRetryMs}ms — too expensive inside a ${BATCH_BUDGET_MS}ms batch.`
  );
  assert.ok(RETRY_BUDGET_MS < BATCH_BUDGET_MS, 'Retries must stop before the batch does.');
  assert.ok(
    BATCH_BUDGET_MS + worstCaseRetryMs < 26000,
    'Batch budget plus one worst-case retry must stay inside the scheduled-function limit.'
  );
  assert.equal(BATCH_SIZE, 10, 'Batch size is load-bearing for this arithmetic.');
});
