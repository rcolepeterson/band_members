// Endpoint + unit tests for player handles ("battle names") and the
// open-challenge claiming flow:
//
//   GET/POST /api/me/handle          (pick/change your battle name)
//   POST /api/game-challenge         (create; auto-assigns a handle, fail-soft)
//   POST /api/game-challenge/accept  (atomic claim; loser gets 409+claimed_by)
//   POST /api/game-match/play        (defend-join; atomic claim on first defend)
//
// Same strategy as tests/game-challenge.test.mjs: with NETLIFY_DATABASE_URL
// unset the handlers short-circuit with 503, which verifies the
// auth/validation/response layer without standing up Postgres. The pure
// helpers (validHandle, suggestHandle, roleOf) are unit-tested directly, and
// the single-claim SQL guards are pinned by exact-source assertions — two
// defenders racing an open feed-shared link must never both win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DB_URL_ENV, roleOf } from '../netlify/functions/_db.mjs';
import meHandle, { validHandle, suggestHandle } from '../netlify/functions/me_handle.mjs';
import { matchState } from '../netlify/functions/game_match.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

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

const HANDLE_URL = 'https://example.test/api/me/handle';

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

// --- handle validation -------------------------------------------------------

test('validHandle accepts 3-20 letters, numbers, underscores', () => {
  assert.equal(validHandle('abc'), 'abc');
  assert.equal(validHandle('rawker4821'), 'rawker4821');
  assert.equal(validHandle('A_B_C'), 'A_B_C');
  assert.equal(validHandle('a'.repeat(20)), 'a'.repeat(20));
  // Surrounding whitespace is trimmed, not rejected.
  assert.equal(validHandle('  rawker  '), 'rawker');
});

test('validHandle rejects bad input', () => {
  assert.equal(validHandle('ab'), null); // too short
  assert.equal(validHandle('a'.repeat(21)), null); // too long
  assert.equal(validHandle('has space'), null);
  assert.equal(validHandle('has-dash'), null);
  assert.equal(validHandle('dot.name'), null);
  assert.equal(validHandle(''), null);
  assert.equal(validHandle(null), null);
  assert.equal(validHandle(undefined), null);
  assert.equal(validHandle(12345), null);
});

test('suggestHandle builds a usable stem from an email', () => {
  assert.equal(suggestHandle('Foo.Bar+1@Example.com'), 'foobar1');
  assert.equal(suggestHandle('a@b.co'), 'a');
  assert.equal(suggestHandle('!!!@x.com'), 'rawker'); // nothing usable
  assert.equal(suggestHandle(''), 'rawker');
  // Capped at 12 chars so random digits still fit in 20.
  assert.equal(suggestHandle('averylonglocalpart12345@x.com'), 'averylongloc');
});

// --- viewer role -------------------------------------------------------------

test('roleOf maps every viewer to challenger / invitee / spectator', () => {
  assert.equal(roleOf('u1', 'u1', null), 'challenger');
  assert.equal(roleOf('u2', 'u1', 'u2'), 'invitee');
  assert.equal(roleOf('u3', 'u1', 'u2'), 'spectator');
  assert.equal(roleOf(null, 'u1', null), 'spectator'); // signed out
  assert.equal(roleOf(undefined, 'u1', 'u2'), 'spectator');
  // Unclaimed link: nobody is the invitee yet, so the holder is a spectator.
  assert.equal(roleOf('u2', 'u1', null), 'spectator');
});

test('both public GET handlers compute you_are via roleOf', () => {
  for (const p of ['netlify/functions/game_challenge.mjs', 'netlify/functions/game_match.mjs']) {
    const s = src(p);
    assert.ok(
      s.includes('you_are = roleOf(viewer && viewer.id, row.challenger_id, row.invitee_id)'),
      `${p} must route its you_are through roleOf so the tested logic is the shipped logic`
    );
  }
});

// --- matchState carries handles (privacy: no real names on the wire) --------

test('matchState exposes handles, never real names as opponent labels', () => {
  const row = {
    token: 't', format: 'best3', status: 'open', current_round: 1,
    challenger_round_wins: 0, invitee_round_wins: 0, plays: [],
    challenger_id: 'u1', invitee_id: null,
    pending_server_id: 'u1', pending_band_a: 'x', pending_kind: 'defend',
  };
  const state = matchState(row, 'rawker1', null);
  assert.equal(state.challenger_handle, 'rawker1');
  assert.equal(state.invitee_handle, null);
  assert.ok(!('challenger_name' in state), 'no real-name fields on the wire');
  assert.ok(!('invitee_name' in state), 'no real-name fields on the wire');
});

// --- uniqueness: case-insensitive unique index + 23505 -> 409 --------------

test('migrate creates a case-insensitive unique index on users.handle', () => {
  const s = src('netlify/functions/migrate.mjs');
  assert.ok(s.includes('alter table users add column if not exists handle text'), 'handle column');
  assert.ok(s.includes('users_handle_lower_idx'), 'index name');
  assert.ok(s.includes('on users (lower(handle))'), 'case-insensitive expression');
  assert.ok(s.includes('where handle is not null'), 'nulls stay allowed');
});

test('POST /api/me/handle maps a taken handle (23505) to 409', () => {
  const s = src('netlify/functions/me_handle.mjs');
  assert.ok(s.includes("err.code === '23505'"), 'detects the unique-violation');
  assert.ok(s.includes("return conflict('that handle is taken"), 'answers 409');
});

// --- atomic claim: exactly one defender wins an open link --------------------
// Two tappers racing a feed-shared link must not both claim it. The guard is
// the WHERE on the UPDATE itself (status='open' AND invitee_id IS NULL): the
// loser sees zero rows and gets 409 with the winner's handle.

test('challenge accept claims atomically, loser gets 409 with claimed_by', () => {
  const s = src('netlify/functions/game_challenge_accept.mjs');
  assert.ok(s.includes('returning id'), 'update returns the claimed row');
  assert.ok(s.includes("and status = 'open'"), 'guard: still open');
  assert.ok(s.includes('and invitee_id is null'), 'guard: not yet claimed');
  assert.ok(
    s.includes("return conflict('this challenge was just claimed', { claimed_by: claimerHandle })"),
    'loser gets 409 carrying the winner\'s handle'
  );
  assert.ok(s.includes('select u.handle as claimer_handle'), 're-reads the winner for the 409 body');
});

test('the 409 helper is imported wherever the atomic claim uses it', () => {
  for (const p of [
    'netlify/functions/game_challenge_accept.mjs',
    'netlify/functions/game_match_play.mjs',
  ]) {
    const s = src(p);
    assert.ok(
      /import\s*{[^}]*\bconflict\b[^}]*}\s*from\s*'\.\/_db\.mjs'/.test(s),
      `${p} calls conflict() so it must import it (else the 409 path throws ReferenceError)`
    );
  }
});

test('match defend-join claims atomically on first defend', () => {
  const s = src('netlify/functions/game_match_play.mjs');
  assert.ok(s.includes("and status = 'open'"), 'join guard: still open');
  assert.ok(s.includes('and invitee_id is null'), 'join guard: not yet claimed');
  assert.ok(
    s.includes("return conflict('this match was just claimed', { claimed_by: claimedBy })"),
    'second defender gets 409 with the claimer\'s handle'
  );
});

// --- no-DB wiring ------------------------------------------------------------

test('me/handle rejects PUT with 405', async () => {
  const r = await meHandle(req('PUT', HANDLE_URL, {}, {}));
  assert.equal(r.status, 405);
});

test('me/handle short-circuits to 503 without a database', withoutDb(async () => {
  const get = await meHandle(req('GET', HANDLE_URL));
  assert.equal(get.status, 503);
  const post = await meHandle(req('POST', HANDLE_URL, {}, { handle: 'rawker1' }));
  assert.equal(post.status, 503);
}));
