// Player handles — the battle name shown on challenges and matches instead
// of the real name (privacy: a feed-shared invite shouldn't leak legal names).
//
// GET  /api/me/handle — { ok: true, handle } (auth; handle is null until set)
// POST /api/me/handle — set or change your handle (auth). body: { handle }
//   -> { ok: true, handle }
//
// Validation: 3-20 chars, letters/numbers/underscores only. Uniqueness is
// case-insensitive ("Rawker" and "rawker" collide). A handle is auto-assigned
// on first challenge/match creation via ensureHandle below — this endpoint
// is for picking your own or changing it later. Auto-assign never overwrites
// an existing choice.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  conflict,
  serverError,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';

// Printable handle, 3-20 chars, [A-Za-z0-9_]. Returns the cleaned handle or
// null. Case is preserved for display; uniqueness is case-insensitive.
export function validHandle(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (clean.length < 3 || clean.length > 20) return null;
  if (!/^[A-Za-z0-9_]+$/.test(clean)) return null;
  return clean;
}

// Suggest a handle stem from an email address: the local-part sanitized to
// [a-z0-9_], lowercased, capped at 12 chars so random digits still fit.
export function suggestHandle(email) {
  const local = String(email || '').split('@')[0] || '';
  const clean = local.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 12);
  return clean || 'rawker';
}

// Auto-assign a handle for a user that doesn't have one. Never overwrites an
// existing choice. The UPDATE's `where handle is null` makes concurrent calls
// safe: exactly one wins, the loser reads the winner's value. The unique
// index is the backstop against two users landing on the same candidate.
export async function ensureHandle(sql, user) {
  if (user.handle) return user.handle;
  let stem = suggestHandle(user.email);
  if (stem.length < 3) stem = `rawker${stem}`;
  stem = stem.slice(0, 12);
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? stem : `${stem}${Math.floor(100 + Math.random() * 900)}`;
    try {
      const rows = await sql`
        update users set handle = ${candidate}
         where id = ${user.id} and handle is null
        returning handle`;
      if (rows && rows[0] && rows[0].handle) return rows[0].handle;
      const cur = await sql`select handle from users where id = ${user.id} limit 1`;
      if (cur && cur[0] && cur[0].handle) return cur[0].handle;
      return null;
    } catch (err) {
      // 23505 = unique violation on the handle index: try the next candidate.
      if (!err || err.code !== '23505') throw err;
    }
  }
  const fallback = `rawker${Math.floor(100000 + Math.random() * 900000)}`;
  await sql`update users set handle = ${fallback} where id = ${user.id} and handle is null`;
  return fallback;
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to manage your handle');

  if (req.method === 'GET') {
    return ok({ handle: me.handle || null });
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return badRequest('expected a JSON body');
  }
  const handle = validHandle(body && body.handle);
  if (!handle) return badRequest('pick a handle: 3-20 letters, numbers, or underscores');

  try {
    const rows = await sql`update users set handle = ${handle} where id = ${me.id} returning handle`;
    return ok({ handle: rows[0].handle });
  } catch (err) {
    if (err && err.code === '23505') return conflict('that handle is taken — try another');
    console.error('me-handle: update failed', err && err.message);
    return serverError('could not save your handle');
  }
};

export const config = { path: '/api/me/handle' };
