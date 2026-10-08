// GET /invite/<token> — the link-preview card for a head-to-head challenge.
//
// WHY THIS EXISTS
//
// The "Copy invite link" URL used to be /game/?invite=<token>, whose og: tags
// are the static game-page ones ("Six Degrees — the game"). Pasted into a
// text thread it unfurled as a generic webpage share — nothing said
// "challenge." Aaron's bug report, with screenshot, 2026-10-01.
//
// So invites now share /invite/<token> (a netlify.toml rewrite into this
// function). We look the token up and serve crawler tags that read like a
// challenge —
//   "rawker4821 challenged you to a Six Degrees showdown"
//   "Metallica vs ? — pick a band and try to stump them."
// — then hand humans off to the real invite landing at /game/?invite=.
// The token is a 256-bit unguessable secret and the landing is public by
// design (game_challenge.mjs header), so showing the handle + band pick here
// reveals nothing the link itself doesn't.
//
// WHY IT NEVER RETURNS AN ERROR PAGE
//
// A 500 here is a broken preview in somebody's text thread, which is worse
// than a generic one. Every failure path (bad token, expired challenge, DB
// down, rate budget spent) still serves a valid card — just with generic
// "challenge" copy. Same doctrine as og_image.mjs.

import { getSql, isDbConfigured, methodNotAllowed } from './_db.mjs';
import { clientIp, consume } from './_rate_limit.mjs';
import { getChallengeDetail } from './game_challenge.mjs';

const SITE = 'https://sixdegreesofrock.com';
const IMAGE = `${SITE}/og-image.png?v=2`;

export function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Challenge band refs are graph node ids, and the graph now keys bands by
// database UUID. The browser resolves those against its loaded graph; this
// card has no graph, so without a lookup the preview read
// "a8c8d9e2-… vs ?" instead of "Sweet Water vs ?". Name-shaped refs (older
// challenges) pass through untouched.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidRef(ref) {
  return typeof ref === 'string' && UUID_RE.test(ref);
}

// Fail-soft: a lookup miss or DB hiccup leaves the ref as-is, and
// inviteCardCopy never prints a bare UUID (see displayBand).
export async function resolveBandNames(sql, refs) {
  const ids = [...new Set(refs.filter(isUuidRef))];
  const names = new Map();
  if (!ids.length) return names;
  try {
    const rows = await sql`select id, name from bands where id = any(${ids}::uuid[])`;
    for (const r of rows || []) names.set(String(r.id).toLowerCase(), r.name);
  } catch (_) {
    // generic band label stands
  }
  return names;
}

// A UUID that didn't resolve reads worse than a placeholder.
function displayBand(ref) {
  if (!ref || isUuidRef(ref)) return 'a band';
  return ref;
}

// Pure copy builder — unit-tested without a DB.
// detail: { state: 'open'|'answered'|'expired'|'unknown', challenger, invitee, band_a, band_b }
export function inviteCardCopy(detail) {
  const d = detail || {};
  if (d.state === 'open') {
    return {
      title: `${d.challenger || 'Someone'} challenged you to a Six Degrees showdown`,
      description: `${displayBand(d.band_a)} vs ? \u2014 pick a band and try to stump them.`,
    };
  }
  if (d.state === 'answered') {
    const vs = d.invitee ? `${d.challenger} vs ${d.invitee}` : `${d.challenger || 'Someone'}`;
    return {
      title: `${vs} \u2014 Six Degrees showdown`,
      description: `${displayBand(d.band_a)} vs ${displayBand(d.band_b)} \u2014 see how the chain played out.`,
    };
  }
  if (d.state === 'expired') {
    return {
      title: 'This Six Degrees challenge has ended',
      description: 'The invite expired \u2014 start a fresh showdown.',
    };
  }
  return {
    title: 'Six Degrees of Rock \u2014 head-to-head challenge',
    description: 'Someone shared a game challenge. This invite didn\u2019t check out \u2014 start your own showdown.',
  };
}

export function inviteCardHtml({ token, title, description }) {
  const safeToken = escapeHtml(token);
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const target = `/game/?invite=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Six Degrees of Rock" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDesc}" />
<meta property="og:url" content="${SITE}/invite/${safeToken}" />
<meta property="og:image" content="${IMAGE}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDesc}" />
<meta name="twitter:image" content="${IMAGE}" />
<meta http-equiv="refresh" content="0;url=${target}" />
</head>
<body>
<p><a href="${target}">Continue to the challenge</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
}

function cardResponse(token, detail) {
  const copy = inviteCardCopy(detail);
  return new Response(inviteCardHtml({ token, ...copy }), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cache: the same pretty URL can flip from "open" to
      // "answered" to "expired" over its life.
      'cache-control': 'no-store',
    },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  const url = new URL(req.url);

  // Primary carrier is the ?token= the netlify.toml rewrite appends;
  // fall back to the last path segment for direct /invite/<token> hits.
  let token = String(url.searchParams.get('token') || '');
  if (!token) {
    const segs = url.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    token = last === 'invite' ? '' : last;
  }
  token = token.slice(0, 128);

  let detail = { state: 'unknown' };
  if (token && isDbConfigured()) {
    const sql = getSql();
    // Light IP budget — crawlers fetch once per share, humans once per tap.
    // Budget spent still serves the generic card, never a 429: a broken
    // preview is worse than a generic one.
    let budgeted = true;
    try {
      const b = await consume({
        sql,
        bucket: `game-invite-card:ip:${clientIp(req)}`,
        limit: 120,
        windowSeconds: 3600,
      });
      budgeted = b.allowed;
    } catch (_) {
      budgeted = true; // fail open to the lookup
    }
    if (budgeted) {
      try {
        const { error, row } = await getChallengeDetail(sql, token);
        if (row) {
          const names = await resolveBandNames(sql, [row.band_a, row.band_b]);
          const nameOf = (ref) => (ref && names.get(String(ref).toLowerCase())) || ref;
          detail =
            row.status === 'answered'
              ? {
                  state: 'answered',
                  challenger: row.challenger_handle || 'Someone',
                  invitee: row.invitee_handle || null,
                  band_a: nameOf(row.band_a),
                  band_b: nameOf(row.band_b),
                }
              : {
                  state: 'open',
                  challenger: row.challenger_handle || 'Someone',
                  band_a: nameOf(row.band_a),
                };
        } else if (error && error.status === 410) {
          detail = { state: 'expired' };
        }
      } catch (_) {
        // generic card stands
      }
    }
  }
  return cardResponse(token, detail);
};

export const config = { path: '/api/game-invite-card' };
