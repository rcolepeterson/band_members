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
    return badRequest('request body must be JSON with { email, name }');
  }

  const email = normalizeEmail(body.email);
  const name = normalizeName(body.name);

  if (!isPlausibleEmail(email)) {
    return badRequest('email is required and must be a valid address', { field: 'email' });
  }
  if (!name) {
    return badRequest('name is required', { field: 'name' });
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
      select id, email, name, token, bands_added, bands_edited, created_at
      from users
      where lower(email) = lower(${email})
      limit 1
    `;

    let user;
    let created;
    if (existing[0]) {
      // Returning user. Update name if changed; token stays the same.
      const current = existing[0];
      if (current.name !== name) {
        const updated = await sql`
          update users set name = ${name}, updated_at = now()
          where id = ${current.id}
          returning id, email, name, token, bands_added, bands_edited, created_at
        `;
        user = updated[0];
      } else {
        user = current;
      }
      created = false;
    } else {
      const token = generateToken();
      const inserted = await sql`
        insert into users (email, name, token)
        values (${email}, ${name}, ${token})
        returning id, email, name, token, bands_added, bands_edited, created_at
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
