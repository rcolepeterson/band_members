// Puts a shared Fantasy Band Game result into its link preview (mirror of og_rawkle.js).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the result rides in the link: /fantasy?s=1&r=<code> (see
// fantasyResultCode in scripts/fantasy-result.mjs). This rewrites the
// /fantasy page's preview tags for that one link: the title is the score,
// the image is /api/fantasy-card for the same code, and og:url is the link
// itself so the platform doesn't fold it back into the generic /fantasy
// preview.
//
// Same rules as og_rawkle.js: a visit without ?r= is passed through untouched,
// only HTML is rewritten, and nothing from the URL reaches the page unchecked
// (the code must parse, so it is a date, a score, a w/x, and five UUIDs only).
import { parseFantasyResultCode, fantasyResultTitle } from '../../scripts/fantasy-result.mjs';

function replaceMeta(html, attr, name, value) {
  const pattern = new RegExp(
    `(<meta\\s+${attr}=["']${name}["']\\s+content=["'])([^"']*)(["'])`,
    'i'
  );
  return html.replace(pattern, (match, head, _old, tail) => `${head}${value}${tail}`);
}

export default async (request, context) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get('r') || '').trim();
  if (!code) return;
  const result = parseFantasyResultCode(code);
  if (!result) return;

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const origin = `${url.protocol}//${url.host}`;
  const title = fantasyResultTitle(result);
  const description = 'Draft five musicians under a $100 salary cap and beat the Gold line of 69. Can you build the winning band?';
  const imageUrl = `${origin}/api/fantasy-card?r=${code}`;
  const shareUrl = `${origin}/fantasy?s=1&amp;r=${code}`;

  let html = await response.text();
  html = replaceMeta(html, 'property', 'og:title', title);
  html = replaceMeta(html, 'name', 'twitter:title', title);
  html = replaceMeta(html, 'property', 'og:description', description);
  html = replaceMeta(html, 'name', 'twitter:description', description);
  html = replaceMeta(html, 'property', 'og:image', imageUrl);
  html = replaceMeta(html, 'name', 'twitter:image', imageUrl);
  html = replaceMeta(html, 'property', 'og:url', shareUrl);
  html = replaceMeta(html, 'property', 'og:image:alt', title);

  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(html, { status: response.status, headers });
};

export const config = { path: ['/fantasy', '/fantasy/'] };
