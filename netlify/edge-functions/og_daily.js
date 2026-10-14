// Puts a shared 6° result into its link preview (Cole, 2026-10-14: one-tap share).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the result rides in the link: /game/?s=1&r=<code> (see
// dailyResultCode in scripts/six-degrees-game.mjs). This rewrites the /game
// page's preview tags for that one link: the title is the score, the image is
// /api/daily-card for the same code, and og:url is the link itself so the
// platform doesn't fold it back into the generic /game preview.
//
// Same rules as og_tags.js: a visit without ?r= is passed through untouched,
// only HTML is rewritten, and nothing from the URL reaches the page unchecked
// (the code must parse, so it is digits and the letters x, o, s, d only).
import { parseDailyResultCode, dailyResultTitle } from '../../scripts/daily-result.mjs';

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
  const result = parseDailyResultCode(code);
  if (!result) return;

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const origin = `${url.protocol}//${url.host}`;
  const title = dailyResultTitle(result);
  const description = 'Connect two famous bands through the musicians they share. A new puzzle every day. Can you beat it?';
  const imageUrl = `${origin}/api/daily-card?r=${code}`;
  const shareUrl = `${origin}/game/?s=1&amp;r=${code}`;

  let html = await response.text();
  html = replaceMeta(html, 'property', 'og:title', title);
  html = replaceMeta(html, 'name', 'twitter:title', title);
  html = replaceMeta(html, 'property', 'og:description', description);
  html = replaceMeta(html, 'name', 'twitter:description', description);
  html = replaceMeta(html, 'property', 'og:image', imageUrl);
  html = replaceMeta(html, 'name', 'twitter:image', imageUrl);
  html = replaceMeta(html, 'property', 'og:url', shareUrl);
  html = replaceMeta(html, 'property', 'og:image:alt', `${title}: one star per move`);

  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(html, { status: response.status, headers });
};

export const config = { path: '/game/' };
