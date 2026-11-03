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
//     rawkle_players, rawkle_retention_pct, rawkle_weekly_players,
//     rawkle_repeat_players, rawkle_completion_pct, rawkle_share_taps,
//     cards_plays, cards_shares, cards_wins,
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

    // Snapshot date: explicit body date wins, else UTC today.
    const hasExplicitDate = typeof body.snapshot_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.snapshot_date);
    const today = hasExplicitDate
      ? body.snapshot_date
      : new Date().toISOString().slice(0, 10);

    // Bands added on the snapshot date (for the "new bands" metric).
    // Explicit dates (midnight PT capture, backfills) count bands created
    // on that PT day; the legacy no-date path keeps counting the current
    // UTC day, exactly as before.
    let bandsAdded = 0;
    try {
      if (hasExplicitDate) {
        const [{ count }] = await sql`
          select count(*)::int as count from bands
          where (created_at at time zone 'America/Los_Angeles')::date = ${today}::date
        `;
        bandsAdded = count;
      } else {
        const [{ count }] = await sql`
          select count(*)::int as count from bands
          where created_at >= current_date
        `;
        bandsAdded = count;
      }
    } catch { /* created_at may not exist */ }

    // Backfill override: explicit body values win over live counts.
    const nodeCount = num(body.node_count) ?? (bandCount + memberCount);
    const finalUserCount = num(body.user_count) ?? userCount;
    const finalFollowsCount = num(body.follows_count) ?? followsCount;
    const finalBandsAdded = num(body.bands_added) ?? bandsAdded;


    await sql`
      insert into daily_snapshots
        (snapshot_date, node_count, user_count, follows_count, bands_added,
         ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, fb_group_members,
         game_players, game_retention_pct, game_weekly_players,
         game_repeat_players, game_completion_pct, game_share_taps,
         rawkle_players, rawkle_retention_pct, rawkle_weekly_players,
         rawkle_repeat_players, rawkle_completion_pct, rawkle_share_taps,
         cards_plays, cards_shares, cards_wins,
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
        ${num(body.rawkle_players)},
        ${num(body.rawkle_retention_pct)},
        ${num(body.rawkle_weekly_players)},
        ${num(body.rawkle_repeat_players)},
        ${num(body.rawkle_completion_pct)},
        ${num(body.rawkle_share_taps)},
        ${num(body.cards_plays)},
        ${num(body.cards_shares)},
        ${num(body.cards_wins)},
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
        rawkle_players = coalesce(excluded.rawkle_players, daily_snapshots.rawkle_players),
        rawkle_retention_pct = coalesce(excluded.rawkle_retention_pct, daily_snapshots.rawkle_retention_pct),
        rawkle_weekly_players = coalesce(excluded.rawkle_weekly_players, daily_snapshots.rawkle_weekly_players),
        rawkle_repeat_players = coalesce(excluded.rawkle_repeat_players, daily_snapshots.rawkle_repeat_players),
        rawkle_completion_pct = coalesce(excluded.rawkle_completion_pct, daily_snapshots.rawkle_completion_pct),
        rawkle_share_taps = coalesce(excluded.rawkle_share_taps, daily_snapshots.rawkle_share_taps),
        cards_plays = coalesce(excluded.cards_plays, daily_snapshots.cards_plays),
        cards_shares = coalesce(excluded.cards_shares, daily_snapshots.cards_shares),
        cards_wins = coalesce(excluded.cards_wins, daily_snapshots.cards_wins),
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
