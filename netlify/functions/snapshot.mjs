// netlify/functions/snapshot.mjs
//
// POST /api/snapshot — capture today's growth metrics into daily_snapshots.
// Guarded by ADMIN_TOKEN. Accepts optional Meta follower counts in the body;
// Neon counts (bands, members, users, follows) are always captured live.
//
// Body (all optional):
//   { ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, fb_group_members,
//     game_players, game_retention_pct, game_weekly_players,
//     game_repeat_players, game_completion_pct, game_share_taps,
//     ga_active_users, ga_new_users, ga_avg_engagement_seconds, ga_events,
//     notes }
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

    // Live graph counts from Neon — used unless the body provides
    // explicit values (backfill from the manual spreadsheet).
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

    // Backfill override: explicit body values win over live counts.
    const nodeCount = num(body.node_count) ?? (bandCount + memberCount);
    const finalUserCount = num(body.user_count) ?? userCount;
    const finalFollowsCount = num(body.follows_count) ?? followsCount;
    const finalBandsAdded = num(body.bands_added) ?? bandsAdded;

    const today = typeof body.snapshot_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.snapshot_date)
      ? body.snapshot_date
      : new Date().toISOString().slice(0, 10);

    await sql`
      insert into daily_snapshots
        (snapshot_date, node_count, user_count, follows_count, bands_added,
         ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, fb_group_members,
         game_players, game_retention_pct, game_weekly_players,
         game_repeat_players, game_completion_pct, game_share_taps,
         ga_active_users, ga_new_users, ga_avg_engagement_seconds, ga_events,
         notes)
      values (
        ${today}::date,
        ${nodeCount},
        ${finalUserCount},
        ${finalFollowsCount},
        ${finalBandsAdded},
        ${num(body.ig_sixdegrees)},
        ${num(body.ig_vimana17)},
        ${num(body.fb_sixdegrees)},
        ${num(body.fb_aaron)},
        ${num(body.fb_group_members)},
        ${num(body.game_players)},
        ${num(body.game_retention_pct)},
        ${num(body.game_weekly_players)},
        ${num(body.game_repeat_players)},
        ${num(body.game_completion_pct)},
        ${num(body.game_share_taps)},
        ${num(body.ga_active_users)},
        ${num(body.ga_new_users)},
        ${num(body.ga_avg_engagement_seconds)},
        ${num(body.ga_events)},
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
        fb_group_members = coalesce(excluded.fb_group_members, daily_snapshots.fb_group_members),
        game_players = coalesce(excluded.game_players, daily_snapshots.game_players),
        game_retention_pct = coalesce(excluded.game_retention_pct, daily_snapshots.game_retention_pct),
        game_weekly_players = coalesce(excluded.game_weekly_players, daily_snapshots.game_weekly_players),
        game_repeat_players = coalesce(excluded.game_repeat_players, daily_snapshots.game_repeat_players),
        game_completion_pct = coalesce(excluded.game_completion_pct, daily_snapshots.game_completion_pct),
        game_share_taps = coalesce(excluded.game_share_taps, daily_snapshots.game_share_taps),
        ga_active_users = coalesce(excluded.ga_active_users, daily_snapshots.ga_active_users),
        ga_new_users = coalesce(excluded.ga_new_users, daily_snapshots.ga_new_users),
        ga_avg_engagement_seconds = coalesce(excluded.ga_avg_engagement_seconds, daily_snapshots.ga_avg_engagement_seconds),
        ga_events = coalesce(excluded.ga_events, daily_snapshots.ga_events),
        notes = coalesce(excluded.notes, daily_snapshots.notes)
    `;

    return ok({
      snapshot_date: today,
      node_count: nodeCount,
      bands: bandCount,
      members: memberCount,
      users: finalUserCount,
      follows: finalFollowsCount,
      bands_added: finalBandsAdded,
      ga_active_users: num(body.ga_active_users),
      ga_new_users: num(body.ga_new_users),
      ga_avg_engagement_seconds: num(body.ga_avg_engagement_seconds),
      ga_events: num(body.ga_events),
    });
  } catch (err) {
    console.error('snapshot failed', err);
    return serverError('snapshot failed', {
      message: err && err.message ? String(err.message) : 'unknown',
    });
  }
};

export const config = { path: '/api/snapshot' };
