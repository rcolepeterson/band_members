// Fixed-window rate limiting, counted in Postgres.
//
// WHY THIS EXISTS
//
// Every write endpoint correctly requires a bearer token, but a token costs one
// HTTP request: /api/signup takes an email, does not verify it, and hands back a
// working credential. So the price of becoming a writer on this site was a ten-line
// script. Four things follow from that, and the fourth is the one that does lasting
// damage:
//
//   1. the graph is the product, and it can be filled with junk
//   2. every write is a metered Function invocation plus Neon queries
//   3. Neon has connection limits; enough concurrent writes and real visitors error
//   4. verify_band makes OUR server call MusicBrainz, which asks for 1 req/sec.
//      Abuse of our endpoint is abuse of theirs, from our IP, and they can block us
//      -- so somebody else's misbehaviour costs us verification for everyone.
//
// WHY POSTGRES AND NOT NETLIFY BLOBS
//
// A counter has to be correct when two requests arrive at once. The upsert below is
// a single atomic statement, so concurrent callers cannot both read 9 and both write
// 10. Blobs would need read-then-write, which loses exactly the race that matters.
// Postgres is already a hard dependency of every one of these endpoints anyway.
//
// WHY FIXED WINDOW
//
// A sliding window is more accurate at the boundary -- a caller can spend a full
// budget at the end of one window and again at the start of the next, so the real
// worst case is 2x the limit over a short span. That is an acceptable trade for one
// indexed statement per request and no per-request row growth. The limits below are
// set with the 2x in mind.
import { getSql } from './_db.mjs';

// Netlify sets x-nf-client-connection-ip from the connection itself, so a caller
// cannot forge it. x-forwarded-for CAN be forged -- anyone may send that header --
// which is why it is only a fallback, and only its first entry. Trusting the client's
// own x-forwarded-for would let an abuser bypass every per-IP limit here by changing
// one header, i.e. it would be worse than no limit, because it would look like one.
export function clientIp(req) {
  const direct = req.headers?.get?.('x-nf-client-connection-ip');
  if (direct && direct.trim()) return direct.trim();
  const forwarded = req.headers?.get?.('x-forwarded-for') || '';
  const first = String(forwarded).split(',')[0].trim();
  return first || 'unknown';
}

const COUNT_SQL = (db, key, windowSeconds) => db`
  insert into rate_limits (bucket, hits, window_start)
  values (${key}, 1, now())
  on conflict (bucket) do update set
    hits = case
      when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}::double precision)
      then 1 else rate_limits.hits + 1 end,
    window_start = case
      when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}::double precision)
      then now() else rate_limits.window_start end
  returning hits, window_start
`;

// Postgres reports a missing table as SQLSTATE 42P01. Matched on the code first and
// the message only as a fallback, because the message is localised and the code is not.
const isMissingTable = (error) => {
  if (!error) return false;
  if (error.code === '42P01') return true;
  const message = String(error.message || '').toLowerCase();
  return message.includes('rate_limits') && message.includes('does not exist');
};

/**
 * Counts one hit against `bucket` and reports whether it is over `limit`.
 *
 * Returns { allowed, count, limit, retryAfterSeconds }. Never throws: a limiter that
 * takes the site down when the database hiccups is worse than the abuse it prevents,
 * so a failure here FAILS OPEN and logs. That is a deliberate choice -- the threat is
 * junk data and a metered bill, not disclosure, and locking out every legitimate
 * visitor during a Neon blip would be the larger outage.
 *
 * It also creates its own table if that table is missing. The alternative is the worst
 * outcome available: rate_limits is created by migrate.mjs, which is behind an admin
 * token and has to be run by hand, so a deploy that forgets it would leave every
 * limiter failing open and the site believing it was protected while it was not.
 * Silent absence of a safety feature is worse than not having shipped it.
 */
export async function consume({ sql, bucket, limit, windowSeconds }) {
  const key = String(bucket);
  try {
    const db = sql || getSql();
    // One statement, so it is atomic. The CASE arms restart the window in the same
    // breath as the increment; doing it as read-then-write would let two callers
    // each decide the window had expired and each reset the count to 1.
    let rows;
    try {
      rows = await COUNT_SQL(db, key, windowSeconds);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // First request after a deploy where the migration has not been run.
      // `if not exists` makes this safe to race with itself and with migrate.mjs.
      console.warn('rate_limits was missing; creating it and retrying once');
      await db`
        create table if not exists rate_limits (
          bucket text primary key,
          hits integer not null default 0,
          window_start timestamptz not null default now()
        )
      `;
      rows = await COUNT_SQL(db, key, windowSeconds);
    }
    const hits = Number(rows?.[0]?.hits ?? 0);
    const started = rows?.[0]?.window_start ? new Date(rows[0].window_start).getTime() : Date.now();
    const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
    return {
      allowed: hits <= limit,
      count: hits,
      limit,
      retryAfterSeconds: Math.max(1, windowSeconds - elapsed),
    };
  } catch (error) {
    console.error('rate limit check failed; allowing the request', {
      bucket: key,
      message: error && error.message ? String(error.message) : 'unknown',
    });
    return { allowed: true, count: 0, limit, retryAfterSeconds: 0, degraded: true };
  }
}

// 429 with Retry-After, so a well-behaved client knows when to come back rather than
// retrying immediately and spending the budget it does not have.
export function tooManyRequests(message, retryAfterSeconds = 60) {
  return new Response(
    JSON.stringify({ ok: false, error: message, retry_after_seconds: retryAfterSeconds }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
      },
    }
  );
}

// Limits live here so they are reviewable in one place, and are overridable by env so
// a real data-entry session does not need a deploy to get unblocked.
//
// Chosen to be well clear of honest use. Aaron adding bands for an hour, or a whole
// household behind one NAT address signing in, must never see a 429; a script trying
// to mint a thousand accounts must see one quickly.
const num = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

export const LIMITS = {
  // Two buckets on one endpoint. The generous one covers the whole email-first flow
  // (a lookup, then possibly a create, plus retries and typos). The tight one counts
  // only accounts actually CREATED, which is the expensive, abusable half.
  signupAttempts: { limit: num('RL_SIGNUP_ATTEMPTS', 30), windowSeconds: 3600 },
  signupCreations: { limit: num('RL_SIGNUP_CREATIONS', 5), windowSeconds: 3600 },
  // Per token, not per IP: these all require a credential, so the credential is the
  // fairer subject. One office behind one address should not share a budget.
  bandCreate: { limit: num('RL_BAND_CREATE', 30), windowSeconds: 3600 },
  bandEdit: { limit: num('RL_BAND_EDIT', 120), windowSeconds: 3600 },
  // Also protects MusicBrainz from us. Deliberately the tightest write limit.
  verifyBand: { limit: num('RL_VERIFY_BAND', 30), windowSeconds: 3600 },
  contribution: { limit: num('RL_CONTRIBUTION', 120), windowSeconds: 3600 },
};
