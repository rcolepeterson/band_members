// Endpoint-level tests for the structured head-to-head match API:
//   POST /api/game-match          (create)
//   GET  /api/game-match?token=   (fetch state)
//   POST /api/game-match/play     (defend a serve)
//   POST /api/game-match/serve    (start your serve)
//   GET  /api/game-matches        (my quiet status list)
//
// Same strategy as tests/game-challenge.test.mjs: with NETLIFY_DATABASE_URL
// unset the handlers short-circuit with 503, which verifies the
// auth/validation/response layer without standing up Postgres. The live-DB
// state machine (round scoring, alternation, match end) is verified manually
// against a deploy, same as the other endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import create, { validMatchFormat, targetWins, matchState } from '../netlify/functions/game_match.mjs';
import play from '../netlify/functions/game_match_play.mjs';
import serve from '../netlify/functions/game_match_serve.mjs';
import list from '../netlify/functions/game_matches.mjs';

function req(method, url, headers = {}, body) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request(url, init);
}

const MATCH_URL = 'https://example.test/api/game-match';
const PLAY_URL = 'https://example.test/api/game-match/play';
const SERVE_URL = 'https://example.test/api/game-match/serve';
const LIST_URL = 'https://example.test/api/game-matches';

// Temporarily unset DB URL so handlers return 503 (the "no DB" path).
function withoutDb(fn) {
  return async () => {
    const before = process.env[DB_URL_ENV];
    delete process.env[DB_URL_ENV];
    try {
      await fn();
    } finally {
      if (before !== undefined) process.env[DB_URL_ENV] = before;
    }
  };
}

// --- method checks -----------------------------------------------------------

test('create rejects PUT with 405', async () => {
  const r = await create(req('PUT', MATCH_URL, {}, {}));
  assert.equal(r.status, 405);
});

test('fetch without token is 400', async () => {
  const r = await create(req('GET', MATCH_URL));
  assert.ok(r.status === 400 || r.status === 503, `expected 400 or 503, got ${r.status}`);
});

test('play rejects GET with 405', async () => {
  const r = await play(req('GET', PLAY_URL));
  assert.equal(r.status, 405);
});

test('serve rejects GET with 405', async () => {
  const r = await serve(req('GET', SERVE_URL));
  assert.equal(r.status, 405);
});

test('list rejects POST with 405', async () => {
  const r = await list(req('POST', LIST_URL, {}, {}));
  assert.equal(r.status, 405);
});

// --- 503 when the database is not configured ---------------------------------

test('create returns 503 when DB URL missing', withoutDb(async () => {
  const r = await create(req('POST', MATCH_URL, { authorization: 'Bearer x' }, { format: 'best5', band_a: 'Metallica' }));
  assert.equal(r.status, 503);
}));

test('fetch returns 503 when DB URL missing', withoutDb(async () => {
  const r = await create(req('GET', `${MATCH_URL}?token=abc`));
  assert.equal(r.status, 503);
}));

test('play returns 503 when DB URL missing', withoutDb(async () => {
  const r = await play(req('POST', PLAY_URL, { authorization: 'Bearer x' }, { token: 'abc', band_b: 'Megadeth', hops: 4 }));
  assert.equal(r.status, 503);
}));

test('serve returns 503 when DB URL missing', withoutDb(async () => {
  const r = await serve(req('POST', SERVE_URL, { authorization: 'Bearer x' }, { token: 'abc', band_a: 'Metallica' }));
  assert.equal(r.status, 503);
}));

test('list returns 503 when DB URL missing', withoutDb(async () => {
  const r = await list(req('GET', LIST_URL, { authorization: 'Bearer x' }));
  assert.equal(r.status, 503);
}));

// --- auth: 401 without a bearer token ----------------------------------------

test('create is not anonymous', async () => {
  const r = await create(req('POST', MATCH_URL, {}, { format: 'best5', band_a: 'Metallica' }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('play is not anonymous', async () => {
  const r = await play(req('POST', PLAY_URL, {}, { token: 'abc', band_b: 'Megadeth', hops: 4 }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('serve is not anonymous', async () => {
  const r = await serve(req('POST', SERVE_URL, {}, { token: 'abc', band_a: 'Metallica' }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('list is not anonymous', async () => {
  const r = await list(req('GET', LIST_URL));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

// --- validMatchFormat / targetWins unit tests ---------------------------------

test('validMatchFormat accepts the five formats', () => {
  for (const f of ['best3', 'best5', 'best7', 'timed', 'open']) {
    assert.equal(validMatchFormat(f), f);
  }
});

test('validMatchFormat rejects junk', () => {
  assert.equal(validMatchFormat('best9'), null);
  assert.equal(validMatchFormat(''), null);
  assert.equal(validMatchFormat(null), null);
  assert.equal(validMatchFormat(5), null);
  assert.equal(validMatchFormat('BEST5'), null);
});

test('targetWins maps best-of formats to round targets', () => {
  assert.equal(targetWins('best3'), 2);
  assert.equal(targetWins('best5'), 3);
  assert.equal(targetWins('best7'), 4);
  assert.equal(targetWins('timed'), 0);
  assert.equal(targetWins('open'), 0);
});

// --- matchState unit tests ----------------------------------------------------

function fakeRow(over = {}) {
  return {
    token: 'tok',
    format: 'best5',
    status: 'active',
    challenger_id: 'c1',
    invitee_id: 'i1',
    challenger_round_wins: 1,
    invitee_round_wins: 0,
    current_round: 2,
    pending_server_id: 'i1',
    pending_band_a: null,
    plays: [{ round: 1, server_id: 'c1', band_a: 'A', band_b: 'B', hops: 4 }],
    ends_at: null,
    ...over,
  };
}

test('matchState reports a pending serve', () => {
  const s = matchState(fakeRow(), 'rawker1', 'rawker2');
  assert.equal(s.pending.kind, 'serve');
  assert.equal(s.pending.server_id, 'i1');
  assert.equal(s.pending.band_a, null);
  assert.equal(s.winner_id, null);
});

test('matchState reports a pending defend', () => {
  const s = matchState(fakeRow({ pending_band_a: 'Metallica', pending_server_id: 'c1' }), 'rawker1', 'rawker2');
  assert.equal(s.pending.kind, 'defend');
  assert.equal(s.pending.band_a, 'Metallica');
});

test('matchState reports the winner when complete', () => {
  const s = matchState(fakeRow({
    status: 'complete', challenger_round_wins: 3, invitee_round_wins: 1,
    pending_server_id: null,
  }), 'rawker1', 'rawker2');
  assert.equal(s.pending, null);
  assert.equal(s.winner_id, 'c1');
});

test('matchState passes plays through', () => {
  const s = matchState(fakeRow(), 'rawker1', 'rawker2');
  assert.equal(s.plays.length, 1);
  assert.equal(s.plays[0].hops, 4);
});
