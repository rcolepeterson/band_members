// Rate limiting: the counter, the client-IP resolution, and the 429.
//
// The counting SQL is exercised against a REAL Postgres (pglite, in-process) rather
// than a mock. A mock would have happily accepted invalid SQL and told me the limiter
// worked -- and the one thing a limiter must actually do is be correct when two
// requests arrive at once, which only a real engine can demonstrate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import { clientIp, consume, tooManyRequests, LIMITS } from '../netlify/functions/_rate_limit.mjs';

// --- a Neon-shaped tagged template over pglite -------------------------------
// The Neon driver is used as sql`...${value}...` and returns an array of rows. This
// adapter gives pglite the same shape so the module under test is unmodified.
async function makeSql() {
  const db = new PGlite();
  await db.exec(`
    create table if not exists rate_limits (
      bucket text primary key,
      hits integer not null default 0,
      window_start timestamptz not null default now()
    );
  `);
  const sql = async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
    const res = await db.query(text, values);
    return res.rows;
  };
  sql.db = db;
  return sql;
}

const req = (headers = {}) => ({ headers: new Headers(headers) });

// --- client IP ---------------------------------------------------------------

test('the client IP comes from the header the platform sets, not one the caller sends', () => {
  // This is the whole security of every per-IP limit. Netlify sets
  // x-nf-client-connection-ip from the connection, so it cannot be forged.
  // x-forwarded-for CAN be sent by anyone. Preferring the forgeable one would let an
  // abuser bypass the limit by changing a header -- worse than having no limit,
  // because it would look like one.
  assert.equal(
    clientIp(req({ 'x-nf-client-connection-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' })),
    '203.0.113.7'
  );
});

test('x-forwarded-for is only a fallback, and only its first entry', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1, 10.0.0.2' })), '198.51.100.4');
  assert.equal(clientIp(req({})), 'unknown');
  // An empty platform header must not win over a usable fallback.
  assert.equal(clientIp(req({ 'x-nf-client-connection-ip': '   ', 'x-forwarded-for': '198.51.100.4' })), '198.51.100.4');
});

// --- the counter -------------------------------------------------------------

test('the SQL runs on a real Postgres and counts up', async () => {
  const sql = await makeSql();
  const args = { sql, bucket: 'test:ip:1.2.3.4', limit: 3, windowSeconds: 3600 };
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await consume(args);
    seen.push([r.count, r.allowed]);
  }
  assert.deepEqual(seen, [[1, true], [2, true], [3, true], [4, false], [5, false]],
    'the limit is inclusive: the Nth request is allowed, the N+1th is not');
});

test('separate buckets do not share a budget', async () => {
  const sql = await makeSql();
  for (let i = 0; i < 4; i += 1) await consume({ sql, bucket: 'a', limit: 3, windowSeconds: 3600 });
  const other = await consume({ sql, bucket: 'b', limit: 3, windowSeconds: 3600 });
  assert.equal(other.count, 1);
  assert.equal(other.allowed, true);
});

test('concurrent requests cannot both claim the same slot', async () => {
  // The reason this is one atomic upsert and not read-then-write. Twenty callers at
  // once must produce exactly twenty distinct counts, not twenty reads of the same
  // number. A mock could never show this.
  const sql = await makeSql();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => consume({ sql, bucket: 'race', limit: 5, windowSeconds: 3600 }))
  );
  const counts = results.map(r => r.count).sort((a, b) => a - b);
  assert.deepEqual(counts, Array.from({ length: 20 }, (_, i) => i + 1),
    'every concurrent caller should get its own number');
  assert.equal(results.filter(r => r.allowed).length, 5, 'exactly the limit should be allowed');
});

test('the window restarts once it has passed', async () => {
  const sql = await makeSql();
  const args = { sql, bucket: 'window', limit: 2, windowSeconds: 60 };
  await consume(args);
  await consume(args);
  const blocked = await consume(args);
  assert.equal(blocked.allowed, false);
  // Age the window rather than sleeping a minute.
  await sql`update rate_limits set window_start = now() - interval '2 minutes' where bucket = ${'window'}`;
  const after = await consume(args);
  assert.equal(after.count, 1, 'a fresh window starts the count over');
  assert.equal(after.allowed, true);
});

test('retry-after shrinks as the window is spent', async () => {
  const sql = await makeSql();
  const args = { sql, bucket: 'retry', limit: 1, windowSeconds: 600 };
  await consume(args);
  await sql`update rate_limits set window_start = now() - interval '500 seconds' where bucket = ${'retry'}`;
  const r = await consume(args);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSeconds <= 100 && r.retryAfterSeconds >= 90,
    `expected roughly 100s left, got ${r.retryAfterSeconds}`);
});

test('a database failure fails OPEN, and says so', async () => {
  // Deliberate: the threat here is junk data and a metered bill, not disclosure. A
  // limiter that turns a Neon blip into a total outage is worse than the abuse it
  // prevents.
  const broken = async () => { throw new Error('connection refused'); };
  const r = await consume({ sql: broken, bucket: 'x', limit: 1, windowSeconds: 60 });
  assert.equal(r.allowed, true);
  assert.equal(r.degraded, true);
});

// --- the response ------------------------------------------------------------

test('the refusal is a 429 carrying Retry-After', async () => {
  const res = tooManyRequests('slow down', 42);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '42');
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a 429 must never be cached');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'slow down');
  assert.equal(body.retry_after_seconds, 42);
});

test('retry-after is always a usable whole number of seconds', () => {
  assert.equal(tooManyRequests('x', 0).headers.get('retry-after'), '1');
  assert.equal(tooManyRequests('x', 1.2).headers.get('retry-after'), '2');
});

// --- the limits themselves ---------------------------------------------------

test('creating accounts is capped far tighter than attempting to sign in', () => {
  // Someone mistyping their address a dozen times is not creating a dozen accounts
  // and must not be treated as though they were.
  assert.ok(LIMITS.signupCreations.limit < LIMITS.signupAttempts.limit);
});

test('verification is the tightest write limit, because it spends MusicBrainz', () => {
  // verify_band makes OUR server call MusicBrainz, which asks for 1 req/sec. Abuse of
  // our endpoint is abuse of theirs, from our IP, and they can block us.
  assert.ok(LIMITS.verifyBand.limit <= LIMITS.bandCreate.limit);
  assert.ok(LIMITS.verifyBand.limit <= LIMITS.bandEdit.limit);
});

test('every limit is a positive number over a real window', () => {
  for (const [name, cfg] of Object.entries(LIMITS)) {
    assert.ok(Number.isInteger(cfg.limit) && cfg.limit > 0, `${name} limit`);
    assert.ok(Number.isInteger(cfg.windowSeconds) && cfg.windowSeconds > 0, `${name} window`);
  }
});

// --- wiring ------------------------------------------------------------------

test('every token-guarded write endpoint is limited, after its token check', async () => {
  const cases = {
    'bands_create.mjs': 'band-create',
    'bands_edit.mjs': 'band-edit',
    'bands_edit_members.mjs': 'band-edit',
    'edit-person.mjs': 'band-edit',
    'contributions.mjs': 'contribution',
    'verify_band.mjs': 'verify-band',
  };
  for (const [file, prefix] of Object.entries(cases)) {
    const src = readFileSync(new URL(`../netlify/functions/${file}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ consume, tooManyRequests, LIMITS as RATE_LIMITS \}/, `${file} import`);
    // Keyed on the user id: rotating a token must not grant a fresh budget, and the
    // counter table must never hold a live secret.
    assert.ok(src.includes(`\`${prefix}:user:\${user.id}\``), `${file} should bucket by user id`);
    assert.ok(!src.includes(':user:${token}'), `${file} must not key a bucket on the token itself`);
    // Order matters: the limit must come AFTER the invalid-token rejection, or an
    // attacker could spend a real user's allowance without a valid credential.
    const guard = src.indexOf('invalid or revoked token');
    const limit = src.indexOf('consume({');
    assert.ok(guard > 0 && limit > guard, `${file}: the limit must sit after the token check`);
  }
});

test('signup is limited per IP, twice, and only counts creations on the tight bucket', () => {
  const src = readFileSync(new URL('../netlify/functions/signup.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('`signup:ip:${ip}`'), 'attempts bucket');
  assert.ok(src.includes('`signup-create:ip:${ip}`'), 'creations bucket');
  // The creations counter belongs on the insert branch only. If it sat above, a
  // returning visitor signing in would spend the new-account budget.
  const insertBranch = src.slice(src.indexOf('} else {'), src.indexOf('created = true;'));
  assert.ok(insertBranch.includes('signup-create:ip:'), 'the creations cap belongs on the insert path');
});

test('the cron sweeps spent counters without risking its real job', () => {
  const src = readFileSync(new URL('../netlify/functions/cron_verify_stale_bands.mjs', import.meta.url), 'utf8');
  assert.match(src, /delete from rate_limits where window_start < now\(\) - interval '1 day'/);
  // A day is comfortably longer than the longest window, so nothing still being
  // counted is deleted.
  const longest = Math.max(...Object.values(LIMITS).map(l => l.windowSeconds));
  assert.ok(longest < 86400, 'the sweep must not delete a window that is still live');
  // Housekeeping must not cost us the verification batch.
  const sweep = src.slice(src.indexOf('sweptRateLimits'), src.indexOf('const summary = await runBatch'));
  assert.match(sweep, /catch \(sweepErr\)/, 'the sweep should be non-fatal');
});

test('the counter table is created by the migration', () => {
  const src = readFileSync(new URL('../netlify/functions/migrate.mjs', import.meta.url), 'utf8');
  assert.match(src, /create table if not exists rate_limits/);
  assert.match(src, /bucket text primary key/);
  assert.match(src, /create index if not exists rate_limits_window_start_idx/);
});

// --- the deploy-order trap ---------------------------------------------------

test('a missing counter table is created rather than silently disabling the limits', async () => {
  // rate_limits is created by migrate.mjs, which sits behind an admin token and has
  // to be run by hand. A deploy that forgot it would leave every limiter failing open
  // while the site believed it was protected -- the worst available outcome, and
  // exactly the class of silent-absence bug that keeps biting this project.
  const db = new PGlite();
  const sql = async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
    return (await db.query(text, values)).rows;
  };
  // Deliberately do NOT create the table first.
  const first = await consume({ sql, bucket: 'cold:start', limit: 2, windowSeconds: 3600 });
  assert.equal(first.count, 1, 'the first call should have counted, not failed open');
  assert.notEqual(first.degraded, true, 'this must not be reported as a degraded pass');

  // And it must keep counting after healing itself.
  await consume({ sql, bucket: 'cold:start', limit: 2, windowSeconds: 3600 });
  const third = await consume({ sql, bucket: 'cold:start', limit: 2, windowSeconds: 3600 });
  assert.equal(third.allowed, false, 'the limit should apply normally once the table exists');

  const exists = await sql`select 1 from information_schema.tables where table_name = ${'rate_limits'}`;
  assert.equal(exists.length, 1, 'the table should now exist');
});

test('a real error is still not mistaken for a missing table', async () => {
  // The heal path must be narrow. If any failure triggered DDL and a retry, a genuine
  // outage would be retried into the ground and the fail-open path would never run.
  let calls = 0;
  const broken = async () => { calls += 1; throw new Error('connection refused'); };
  const r = await consume({ sql: broken, bucket: 'y', limit: 1, windowSeconds: 60 });
  assert.equal(r.allowed, true);
  assert.equal(r.degraded, true);
  assert.equal(calls, 1, 'a connection failure should not be retried as if the table were missing');
});
