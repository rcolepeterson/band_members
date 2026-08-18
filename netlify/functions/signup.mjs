// POST /api/signup — create or re-authenticate a user by email.
//
// Design decisions:
//
// 1. No password. The email itself is the identity. Rationale: this is a
//    hobby community graph app, not a bank. Making people invent yet another
//    password creates friction with essentially no security upside — anyone
//    who can read the user's email can eventually reset any password anyway.
//    See discussion in projects.band_members.persistence_and_user_stats.
//
// 2. Email-verification not enforced (per user's decision on 2026-07-15).
//    We trust the entered address for now. If someone abuses it we can add a
//    magic-link verification step without changing the schema.
//
// 3. Re-signup returns the existing token. If someone comes back to a fresh
//    device and enters the same email + name, they get their existing user
//    row and existing token back. This is intentional: the token acts as a
//    lightweight "cross-device login" mechanism where the credential IS the
//    email. If they entered a different name we update it (people change
//    displayed names).
//
// 4. Response includes token in the body. The client stores it in
//    localStorage. This is a plain bearer token so the client can attach it
//    to subsequent /api/contributions and /api/me calls.
//
// 5. Two request shapes on one endpoint:
//      { intent: 'signin', email }  -> look up only; never creates. Answers
//                                      { found: true, user } or { found: false }.
//      { email, name, city, ... }   -> the insert-or-return described above.
//    This exists so a returning visitor can be recognised by email alone rather
//    than retyping a profile the row already holds.
//
// Rate limiting: none at this layer. Netlify's platform-level rate limits
// apply. If we see abuse we'll add per-IP throttling in a separate PR.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  generateToken,
  normalizeEmail,
  normalizeName,
  normalizeCity,
  normalizeState,
  normalizeCountry,
  normalizeInstrument,
  isPlausibleEmail,
} from './_db.mjs';

// Parse JSON body defensively — Netlify Functions v2 gives us the Request
// object directly, but callers may send malformed JSON. Rather than 500 on a
// SyntaxError, return a clean 400.
async function parseJsonBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const body = await parseJsonBody(req);
  if (!body || typeof body !== 'object') {
    return badRequest(
      'request body must be JSON with { email, name, city, state, country, instrument }'
    );
  }

  const email      = normalizeEmail(body.email);

  // Email-first sign-in.
  //
  // A returning visitor should not have to retype the four profile fields just
  // to be recognised -- the row is keyed on email and nothing else is needed to
  // find it. With { intent: 'signin' } this looks the email up and either signs
  // them in or reports that there is no account yet, WITHOUT creating one. The
  // client then reveals the profile fields for a genuine sign-up.
  //
  // An explicit intent rather than inferring from absent fields: inference would
  // make a malformed sign-up (dropped field, bad client state) silently behave
  // like a sign-in, and "no account found" is a very different answer from
  // "you forgot to fill in your city".
  //
  // "No account yet" is an ANSWER, not an error, so it comes back 200 with
  // found:false. A 404 would land in the console as a failure on the happy path
  // of every new visitor.
  if (body.intent === 'signin') {
    if (!isPlausibleEmail(email)) {
      return badRequest('email is required and must be a valid address', { field: 'email' });
    }
    try {
      const sql = getSql();
      const rows = await sql`
        select id, email, name, token, bands_added, bands_edited, created_at,
               city, state, country, instrument
        from users
        where lower(email) = lower(${email})
        limit 1
      `;
      if (!rows[0]) return ok({ found: false, created: false, user: null });
      const user = rows[0];
      return ok({
        found: true,
        created: false,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          token: user.token,
          bands_added: user.bands_added,
          bands_edited: user.bands_edited,
          created_at: user.created_at,
          city: user.city,
          state: user.state,
          country: user.country,
          instrument: user.instrument,
        },
      });
    } catch (err) {
      console.error('sign-in lookup failed', err);
      return serverError('sign-in failed', {
        message: err && err.message ? String(err.message) : 'unknown',
      });
    }
  }

  const name       = normalizeName(body.name);
  const city       = normalizeCity(body.city);
  const state      = normalizeState(body.state);
  const country    = normalizeCountry(body.country);
  const instrument = normalizeInstrument(body.instrument);

  if (!isPlausibleEmail(email)) {
    return badRequest('email is required and must be a valid address', { field: 'email' });
  }
  if (!name) {
    return badRequest('name is required', { field: 'name' });
  }

  // Profile fields are required at signup as of PR signup-profile-fields
  // (product decision 2026-07-19). We validate presence, but keep the columns
  // themselves nullable in the DB so pre-existing users don't need a backfill.
  //
  // `instrument` accepts free-text — people who don't play an instrument are
  // expected to type something like 'Music listener' or 'Music connoisseur'.
  // The client shows that hint in its placeholder; the server just enforces
  // non-empty.
  if (!city) {
    return badRequest('city is required', { field: 'city' });
  }
  if (!state) {
    return badRequest('state or region is required', { field: 'state' });
  }
  if (!country) {
    return badRequest('country is required', { field: 'country' });
  }
  if (!instrument) {
    return badRequest(
      'instrument is required (enter "Music listener" or "Music connoisseur" if you don\'t play)',
      { field: 'instrument' }
    );
  }

  const sql = getSql();

  try {
    // Insert-or-return semantics:
    //   1. Try to insert. If email is new -> new row, new token.
    //   2. If email exists -> UPDATE name (in case the user changed it) and
    //      return the existing row (including existing token).
    //
    // We do this as two statements for clarity. A single upsert with
    // ON CONFLICT DO UPDATE RETURNING would work, but the behavior we want
    // (preserve the existing token on conflict) is easier to read as an
    // explicit branch.
    const existing = await sql`
      select id, email, name, token, bands_added, bands_edited, created_at,
             city, state, country, instrument
      from users
      where lower(email) = lower(${email})
      limit 1
    `;

    let user;
    let created;
    if (existing[0]) {
      // Returning user. Update profile fields when they've changed; token
      // stays the same. We always write all four profile fields (plus name)
      // so people can correct typos or move cities on their next signup.
      // This is the same "re-signup keeps the token" contract described in
      // the file-level comments above — we just carry more mutable state now.
      const current = existing[0];
      const changed =
        current.name       !== name       ||
        current.city       !== city       ||
        current.state      !== state      ||
        current.country    !== country    ||
        current.instrument !== instrument;
      if (changed) {
        const updated = await sql`
          update users set
            name       = ${name},
            city       = ${city},
            state      = ${state},
            country    = ${country},
            instrument = ${instrument},
            updated_at = now()
          where id = ${current.id}
          returning id, email, name, token, bands_added, bands_edited, created_at,
                    city, state, country, instrument
        `;
        user = updated[0];
      } else {
        user = current;
      }
      created = false;
    } else {
      const token = generateToken();
      const inserted = await sql`
        insert into users (email, name, token, city, state, country, instrument)
        values (${email}, ${name}, ${token}, ${city}, ${state}, ${country}, ${instrument})
        returning id, email, name, token, bands_added, bands_edited, created_at,
                  city, state, country, instrument
      `;
      user = inserted[0];
      created = true;
    }

    // Response shape: expose everything the client needs to render the
    // signed-in UI, plus the token. Do NOT expose other users' data anywhere.
    return ok({
      created,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        token: user.token,
        bands_added: user.bands_added,
        bands_edited: user.bands_edited,
        created_at: user.created_at,
        city: user.city,
        state: user.state,
        country: user.country,
        instrument: user.instrument,
      },
    });
  } catch (err) {
    console.error('signup failed', err);
    return serverError('signup failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/signup' };
