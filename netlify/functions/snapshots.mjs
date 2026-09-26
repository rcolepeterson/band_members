// netlify/functions/snapshots.mjs
//
// GET /api/snapshots — serve the daily_snapshots time series for the
// growth dashboard on the ops board. Public read (numbers only, no PII).
// Optional ?since=YYYY-MM-DD to limit the range.
import { neon } from '@netlify/neon';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  try {
    const sql = neon();
    const url = new URL(req.url);
    const since = url.searchParams.get('since');

    let rows;
    if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
      rows = await sql`
        select snapshot_date, node_count, user_count, follows_count, bands_added,
               ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, notes
        from daily_snapshots
        where snapshot_date >= ${since}::date
        order by snapshot_date asc
      `;
    } else {
      rows = await sql`
        select snapshot_date, node_count, user_count, follows_count, bands_added,
               ig_sixdegrees, ig_vimana17, fb_sixdegrees, fb_aaron, notes
        from daily_snapshots
        order by snapshot_date asc
      `;
    }
    return Response.json({ ok: true, snapshots: rows });
  } catch (err) {
    console.error('snapshots failed', err);
    return Response.json(
      { ok: false, error: 'could not load snapshots' },
      { status: 500 }
    );
  }
};

export const config = { path: '/api/snapshots' };
