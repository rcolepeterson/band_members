// POST /api/admin-thankyou-blast — one-time retroactive contributor thank-you.
// (Aaron, 2026-10-19)
//
// Sends the contributor thank-you email to everyone who has added or edited
// a band (from the contributions log), including Aaron, Paul, and Cole.
// This is a ONE-TIME blast so existing contributors can see the new feature.
//
// Query params:
//   ?dry_run=1 — returns the recipient list without sending anything.
//
// Guarded by ADMIN_TOKEN. Never throws — returns { ok, sent, recipients }.
import { getSql, isDbConfigured } from './_db.mjs';
import { sendContributorThankYou } from './_notify.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const expected = process.env.ADMIN_TOKEN;
  const provided = req.headers.get(ADMIN_TOKEN_HEADER) || '';
  if (!expected || provided !== expected) {
    return Response.json({ ok: false, error: 'invalid admin token' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === '1';

  try {
    if (!isDbConfigured()) {
      return Response.json({ ok: false, error: 'database not configured' }, { status: 500 });
    }
    const sql = getSql();

    // Distinct contributors from the append-only contributions log,
    // joined to users for email/name. Excludes placeholder/test emails.
    const contributors = await sql`
      select distinct u.id, u.email, u.name,
             count(c.id)::int as contribution_count,
             max(c.created_at) as last_contribution
      from contributions c
      join users u on u.id = c.user_id
      where u.email is not null
        and u.email not like '%@example.com'
        and u.email not like '%@test.com'
      group by u.id, u.email, u.name
      order by last_contribution desc
    `;

    if (dryRun) {
      return Response.json({
        ok: true,
        dry_run: true,
        count: contributors.length,
        recipients: contributors.map((c) => ({
          email: c.email,
          name: c.name,
          contributions: c.contribution_count,
          last_active: c.last_contribution,
        })),
      });
    }

    // Send to each contributor. The 24h cooldown in sendContributorThankYou
    // prevents duplicates if they contribute again soon.
    let sent = 0;
    const results = [];
    for (const c of contributors) {
      const result = await sendContributorThankYou(sql, {
        contributorId: c.id,
        contributorEmail: c.email,
        contributorName: c.name,
        bandName: 'the rock universe',
        action: 'added',
      });
      if (result.sent) sent++;
      results.push({ email: c.email, sent: !!result.sent, skipped: result.skipped });
    }

    return Response.json({ ok: true, sent, total: contributors.length, results });
  } catch (err) {
    console.error('thankyou-blast failed', err && err.message);
    return Response.json({ ok: false, error: 'blast failed' }, { status: 500 });
  }
};

export const config = { path: '/api/admin-thankyou-blast' };
