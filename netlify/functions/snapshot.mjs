// netlify/functions/snapshot.mjs
//
// POST /api/snapshot — capture today's growth metrics into daily_snapshots.
// Guarded by ADMIN_TOKEN. Accepts optional Meta follower counts in the body;
// Neon counts (bands, members, users, follows) are always captured live.
//
// Body (all optional):
//   { ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, notes }
//
// The daily cron on Nova's VM fetches Meta counts via CLI and POSTs them here.
// Without Meta numbers, the row still captures graph/user growth.
import { getSql, isDbConfigured } from './_db.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

const ok = (data) => Response.json({ ok: true, ...data });
const unauthorized = (message) => Response.json({ ok: false, error: message }, { status: 401 });
const badRequest = (message) => Response.json({ ok: false, error: message }, { status: 400 });
const serverError = (message, detail) =>
  Response.json({ ok: false, error: message, detail }, { status: 500 });

function getClientIp(req) {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  return (forwarded.split(',')[0] || '').trim() || 'unknown';
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const expected = process.env.ADMIN_TOKEN;
  const provided = req.headers.get(ADMIN_TOKEN_HEADER) || '';
  if (!expected || provided !== expected) {
    console.warn('snapshot: unauthorized attempt from', getClientIp(req));
    return unauthorized('invalid admin token');
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — Meta counts are optional
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

  try {
    if (!isDbConfigured()) {
      return serverError('database not configured');
    }
    const sql = getSql();

    // Live graph counts from Neon.
    const [{ count: bandCount }] = await sql`select count(*)::int as count from bands`;
    const [{ count: memberCount }] = await sql`select count(*)::int as count from band_members`;
    const [{ count: userCount }] = await sql`select count(*)::int as count from users`;
    let followsCount = null;
    try {
      const [{ count }] = await sql`select count(*)::int as count from member_follows`;
      followsCount = count;
    } catch { /* table may not exist yet */ }

    // Bands added today (for the "new bands" metric).
    let bandsAdded = 0;
    try {
      const [{ count }] = await sql`
        select count(*)::int as count from bands
        where created_at >= current_date
      `;
      bandsAdded = count;
    } catch { /* created_at may not exist */ }

    const today = typeof body.snapshot_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.snapshot_date)
      ? body.snapshot_date
      : new Date().toISOString().slice(0, 10);

    await sql`
      insert into daily_snapshots
        (snapshot_date, node_count, user_count, follows_count, bands_added,
         ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, notes)
      values (
        ${today}::date,
        ${bandCount + memberCount},
        ${userCount},
        ${followsCount},
        ${bandsAdded},
        ${num(body.ig_sixdegrees)},
        ${num(body.ig_vimana17)},
        ${num(body.fb_sixdegrees)},
        ${num(body.fb_aaron)},
        ${typeof body.notes === 'string' ? body.notes.slice(0, 500) : null}
      )
      on conflict (snapshot_date) do update set
        node_count = excluded.node_count,
        user_count = excluded.user_count,
        follows_count = excluded.follows_count,
        bands_added = excluded.bands_added,
        ig_sixdegrees = coalesce(excluded.ig_sixdegrees, daily_snapshots.ig_sixdegrees),
        ig_vimana17 = coalesce(excluded.ig_vimana17, daily_snapshots.ig_vimana17),
        fb_sixdegrees = coalesce(excluded.fb_sixdegrees, daily_snapshots.fb_sixdegrees),
        fb_aaron = coalesce(excluded.fb_aaron, daily_snapshots.fb_aaron),
        notes = coalesce(excluded.notes, daily_snapshots.notes)
    `;

    return ok({
      snapshot_date: today,
      node_count: bandCount + memberCount,
      bands: bandCount,
      members: memberCount,
      users: userCount,
      follows: followsCount,
      bands_added: bandsAdded,
    });
  } catch (err) {
    console.error('snapshot failed', err);
    return serverError('snapshot failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/snapshot' };
