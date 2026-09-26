// /api/members/:id/follow — the "Follow" action on member cards.
//
//   GET    -> { following: bool }           (is the caller following?)
//   POST   -> { following: true }           (follow; idempotent)
//   DELETE -> { following: false }          (unfollow; idempotent)
//
// Mirrors follows.mjs (band follows). Member follows let users track a
// musician's career moves across bands — the thing band follows can't do.
// Feeds the same "touched" notification audience as band follows.
//
// Auth: bearer token required for all three methods. Anonymous callers get
// 401 before we touch the DB.
//
// A follow for a member id that isn't in the band_members table is a 404 —
// the client hides the button in that case.

import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  unauthorized,
  notFound,
  dbUnavailable,
  serverError,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
} from './_db.mjs';

function extractMemberId(req, context) {
  const fromContext = context && context.params && typeof context.params.id === 'string' ? context.params.id.trim() : '';
  if (fromContext) return fromContext;
  try {
    const pathname = new URL(req.url).pathname;
    const match = /\/api\/members\/([^/]+)\/follow\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

export default async (req, context) => {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    return methodNotAllowed();
  }

  const token = extractBearerToken(req);
  if (!token) return unauthorized('missing bearer token');

  const memberId = extractMemberId(req, context);
  if (!memberId) return badRequest('member id is required in the URL path', { field: 'id' });

  if (!isDbConfigured()) return dbUnavailable();

  const sql = getSql();

  try {
    const user = await findUserByToken(sql, token);
    if (!user) return unauthorized('invalid or revoked token');

    // Confirm the member exists (malformed id just won't match -> 404).
    let memberExists = false;
    try {
      const members = await sql`select id from band_members where id = ${memberId} limit 1`;
      memberExists = members.length > 0;
    } catch {
      memberExists = false;
    }
    if (!memberExists) return notFound('no member with that id');

    if (req.method === 'GET') {
      const rows = await sql`
        select 1 from member_follows where user_id = ${user.id} and member_id = ${memberId} limit 1
      `;
      return ok({ following: rows.length > 0 });
    }

    if (req.method === 'POST') {
      // Idempotent: following twice is still just following.
      await sql`
        insert into member_follows (user_id, member_id)
        values (${user.id}, ${memberId})
        on conflict (user_id, member_id) do nothing
      `;
      return ok({ following: true });
    }

    // DELETE — idempotent: unfollowing what you don't follow is a no-op.
    await sql`
      delete from member_follows where user_id = ${user.id} and member_id = ${memberId}
    `;
    return ok({ following: false });
  } catch (err) {
    console.error('member follows failed', err);
    return serverError('follow failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/members/:id/follow' };
