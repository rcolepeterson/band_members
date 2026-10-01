// Endpoint-level tests for the remote head-to-head challenge API:
//   POST /api/game-challenge          (create)
//   GET  /api/game-challenge?token=   (fetch state)
//   POST /api/game-challenge/accept   (answer)
//   GET  /api/game-challenges         (my quiet status list)
//
// Same strategy as tests/api-endpoints.test.mjs: call the exported default
// handler with a mock Request. With NETLIFY_DATABASE_URL unset the handlers
// short-circuit with 503, which lets us verify the auth/validation/response
// layer without standing up Postgres. The live-DB success path is verified
// manually against a deploy (same as the other endpoints).
import test from 'node:test';
import assert from 'node:assert/strict';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import create, {
  validBandRef,
  getChallengeDetail,
  challengeIsExpired,
  CHALLENGE_EXPIRY_DAYS,
} from '../netlify/functions/game_challenge.mjs';
import accept, { acceptChallenge } from '../netlify/functions/game_challenge_accept.mjs';
import list, { listChallenges } from '../netlify/functions/game_challenges.mjs';

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

const CHALLENGE_URL = 'https://example.test/api/game-challenge';
const ACCEPT_URL = 'https://example.test/api/game-challenge/accept';
const LIST_URL = 'https://example.test/api/game-challenges';

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
  const r = await create(req('PUT', CHALLENGE_URL, {}, {}));
  assert.equal(r.status, 405);
});

test('fetch without token is 400', async () => {
  const r = await create(req('GET', CHALLENGE_URL));
  assert.ok(r.status === 400 || r.status === 503, `expected 400 or 503, got ${r.status}`);
});

test('accept rejects GET with 405', async () => {
  const r = await accept(req('GET', ACCEPT_URL));
  assert.equal(r.status, 405);
});

test('list rejects POST with 405', async () => {
  const r = await list(req('POST', LIST_URL, {}, {}));
  assert.equal(r.status, 405);
});

// --- 503 when the database is not configured ---------------------------------

test('create returns 503 when DB URL missing', withoutDb(async () => {
  const r = await create(req('POST', CHALLENGE_URL, { authorization: 'Bearer x' }, { band_a: 'Metallica' }));
  assert.equal(r.status, 503);
}));

test('fetch returns 503 when DB URL missing', withoutDb(async () => {
  const r = await create(req('GET', `${CHALLENGE_URL}?token=abc`));
  assert.equal(r.status, 503);
}));

test('accept returns 503 when DB URL missing', withoutDb(async () => {
  const r = await accept(req('POST', ACCEPT_URL, { authorization: 'Bearer x' }, { token: 'abc', band_b: 'Megadeth' }));
  assert.equal(r.status, 503);
}));

test('list returns 503 when DB URL missing', withoutDb(async () => {
  const r = await list(req('GET', LIST_URL, { authorization: 'Bearer x' }));
  assert.equal(r.status, 503);
}));

// --- auth: 401 without a bearer token ----------------------------------------
// NOTE: these run WITH the ambient env (DB may or may not be configured).
// findUserByToken with a garbage token returns null either way (no DB ->
// getSql() is null... actually without DB the handler 503s first). To keep
// this deterministic we assert 401-or-503: 401 when a DB is present, 503
// when it isn't. The point is: no anonymous challenge creation.

test('create is not anonymous', async () => {
  const r = await create(req('POST', CHALLENGE_URL, {}, { band_a: 'Metallica' }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('accept is not anonymous', async () => {
  const r = await accept(req('POST', ACCEPT_URL, {}, { token: 'abc', band_b: 'Megadeth' }));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

test('list is not anonymous', async () => {
  const r = await list(req('GET', LIST_URL));
  assert.ok(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
});

// (covered above by 'fetch without token is 400')

// --- validBandRef unit tests ---------------------------------------------------

test('validBandRef passes normal band refs through', () => {
  assert.equal(validBandRef('Metallica'), 'Metallica');
  assert.equal(validBandRef('  Hüsker Dü  '), 'Hüsker Dü');
});

test('validBandRef rejects empty / non-string / overlong', () => {
  assert.equal(validBandRef(''), null);
  assert.equal(validBandRef('   '), null);
  assert.equal(validBandRef(null), null);
  assert.equal(validBandRef(42), null);
  assert.equal(validBandRef('x'.repeat(161)), null);
  assert.equal(validBandRef('x'.repeat(160)), 'x'.repeat(160));
});

test('validBandRef strips control characters', () => {
  assert.equal(validBandRef('a\u0001b'), 'ab');
});

// --- challenge expiry ----------------------------------------------------------
// Unanswered challenges expire after CHALLENGE_EXPIRY_DAYS (5): they quietly
// leave the active list. Answered challenges never expire.
//
// The DB-touching cores are exported (listChallenges, acceptChallenge,
// getChallengeDetail) and take a sql tag, so Neon's tagged template is faked
// here: canned rows matched on query text, no DB, no network. For the list
// queries the fake plays the expiry predicate the way Postgres would
// (open + older than the window -> excluded), and the query text is asserted
// to carry the predicate so the emulation can't silently drift from the
// real SQL.

const DAY_MS = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

// Minimal fake for the neon sql`` tagged template. Handlers are
// [substring, rows-or-fn] pairs matched against the joined query text.
function fakeSql(handlers) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    for (const [match, result] of handlers) {
      if (text.includes(match)) {
        return Promise.resolve(typeof result === 'function' ? result(values, calls) : result);
      }
    }
    throw new Error('unexpected query: ' + text.slice(0, 160));
  };
  sql.calls = calls;
  return sql;
}

test('CHALLENGE_EXPIRY_DAYS is 5', () => {
  assert.equal(CHALLENGE_EXPIRY_DAYS, 5);
});

test('challengeIsExpired: open challenges age out', () => {
  assert.equal(challengeIsExpired('open', daysAgo(6)), true);
  assert.equal(challengeIsExpired('open', new Date(Date.now() - 6 * DAY_MS)), true);
  assert.equal(challengeIsExpired('open', daysAgo(4)), false);
  assert.equal(challengeIsExpired('open', new Date().toISOString()), false);
});

test('challengeIsExpired: answered challenges never expire', () => {
  assert.equal(challengeIsExpired('answered', daysAgo(6)), false);
  assert.equal(challengeIsExpired('answered', daysAgo(90)), false);
});

test('challengeIsExpired: bad dates fail open (never expire)', () => {
  assert.equal(challengeIsExpired('open', null), false);
  assert.equal(challengeIsExpired('open', undefined), false);
  assert.equal(challengeIsExpired('open', 'not-a-date'), false);
});

// The fake plays Postgres for the list filter: open + older than the window
// is excluded, everything else passes through.
function listFake(rows) {
  return fakeSql([
    ['from game_challenges', () => {
      const cutoff = Date.now() - CHALLENGE_EXPIRY_DAYS * DAY_MS;
      return rows.filter((r) => r.status !== 'open' || Date.parse(r.created_at) > cutoff);
    }],
  ]);
}

const EXPIRY_ROWS = [
  { token: 'tok-old-open', status: 'open', band_a: 'Metallica', band_b: null, created_at: daysAgo(6), answered_at: null, invitee_handle: null },
  { token: 'tok-fresh-open', status: 'open', band_a: 'Slayer', band_b: null, created_at: daysAgo(4), answered_at: null, invitee_handle: null },
  { token: 'tok-old-answered', status: 'answered', band_a: 'Megadeth', band_b: 'Anthrax', created_at: daysAgo(30), answered_at: daysAgo(29), invitee_handle: 'opp1' },
];

function expiryPredicateIn(calls) {
  const queries = calls.filter((c) => c.text.includes('from game_challenges'));
  assert.ok(queries.length > 0, 'expected list queries to run');
  for (const q of queries) {
    assert.ok(q.text.includes("c.status <> 'open'"), 'predicate keeps non-open rows regardless of age');
    assert.ok(q.text.includes('c.created_at > now()'), 'predicate filters open rows by age');
    assert.ok(q.values.includes(CHALLENGE_EXPIRY_DAYS), 'predicate uses the expiry window constant');
  }
}

test('a 6-day-old open challenge is hidden from the list', async () => {
  const sql = listFake(EXPIRY_ROWS);
  const { sent } = await listChallenges(sql, 'user-1');
  expiryPredicateIn(sql.calls);
  const tokens = sent.map((r) => r.token);
  assert.ok(!tokens.includes('tok-old-open'), `6-day-old open challenge leaked: ${tokens}`);
});

test('a 4-day-old open challenge still shows in the list', async () => {
  const sql = listFake(EXPIRY_ROWS);
  const { sent } = await listChallenges(sql, 'user-1');
  const tokens = sent.map((r) => r.token);
  assert.ok(tokens.includes('tok-fresh-open'), `4-day-old open challenge missing: ${tokens}`);
});

test('answered challenges are never filtered by age', async () => {
  const sql = listFake(EXPIRY_ROWS);
  const { sent } = await listChallenges(sql, 'user-1');
  const tokens = sent.map((r) => r.token);
  assert.ok(tokens.includes('tok-old-answered'), `30-day-old answered challenge missing: ${tokens}`);
});

function acceptFake(challengeRow) {
  return fakeSql([
    ['update game_challenges', [{ id: challengeRow.id }]],
    ['select handle from users', [{ handle: 'challenger1' }]],
    ['where token =', [challengeRow]],
  ]);
}

const ACCEPT_ME = { id: 'user-1', handle: 'tester1' };

test('accepting a 6-day-old open challenge fails', async () => {
  const row = { id: 'c-old', challenger_id: 'user-2', band_a: 'Metallica', status: 'open', created_at: daysAgo(6) };
  const r = await acceptChallenge(acceptFake(row), ACCEPT_ME, { token: 'tok-old', bandB: 'Megadeth' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'this challenge expired');
});

test('accepting a fresh open challenge still works', async () => {
  const row = { id: 'c-fresh', challenger_id: 'user-2', band_a: 'Metallica', status: 'open', created_at: daysAgo(1) };
  const r = await acceptChallenge(acceptFake(row), ACCEPT_ME, { token: 'tok-fresh', bandB: 'Megadeth' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).band_b, 'Megadeth');
});

function detailFake(row) {
  return fakeSql([['where c.token =', row ? [row] : []]]);
}

test('single view returns 410 for an expired open challenge', async () => {
  const { error, row } = await getChallengeDetail(
    detailFake({ token: 't', status: 'open', band_a: 'Metallica', created_at: daysAgo(6) }),
    't',
  );
  assert.equal(row, undefined);
  assert.equal(error.status, 410);
  assert.equal((await error.json()).error, 'this challenge expired');
});

test('single view still shows a fresh open challenge', async () => {
  const { error, row } = await getChallengeDetail(
    detailFake({ token: 't', status: 'open', band_a: 'Metallica', created_at: daysAgo(1) }),
    't',
  );
  assert.equal(error, undefined);
  assert.equal(row.token, 't');
});

test('single view still shows an old answered challenge', async () => {
  const { error, row } = await getChallengeDetail(
    detailFake({ token: 't', status: 'answered', band_a: 'Metallica', band_b: 'Megadeth', created_at: daysAgo(30) }),
    't',
  );
  assert.equal(error, undefined);
  assert.equal(row.status, 'answered');
});
