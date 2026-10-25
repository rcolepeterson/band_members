// Puts a shared Rawkle result into its link preview (mirror of og_daily.js).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the result rides in the link: /rawkle?s=1&r=<code> (see
// rawkleResultCode in scripts/rawkle-result.mjs). This rewrites the /rawkle
// page's preview tags for that one link: the title is the score, the image is
// /api/rawkle-card for the same code, and og:url is the link itself so the
// platform doesn't fold it back into the generic /rawkle preview.
//
// Same rules as og_daily.js: a visit without ?r= is passed through untouched,
// only HTML is rewritten, and nothing from the URL reaches the page unchecked
// (the code must parse, so it is digits, an optional x, dots, and the
// letters g, b, a only).
import { parseRawkleResultCode, rawkleResultTitle } from '../../scripts/rawkle-result.mjs';

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
  const result = parseRawkleResultCode(code);
  if (!result) return;

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const origin = `${url.protocol}//${url.host}`;
  const title = rawkleResultTitle(result);
  const description = 'Guess the band. One famous band a day, six tries. Can you beat it?';
  const imageUrl = `${origin}/api/rawkle-card?r=${code}`;
  const shareUrl = `${origin}/rawkle?s=1&amp;r=${code}`;

  let html = await response.text();
  html = replaceMeta(html, 'property', 'og:title', title);
  html = replaceMeta(html, 'name', 'twitter:title', title);
  html = replaceMeta(html, 'property', 'og:description', description);
  html = replaceMeta(html, 'name', 'twitter:description', description);
  html = replaceMeta(html, 'property', 'og:image', imageUrl);
  html = replaceMeta(html, 'name', 'twitter:image', imageUrl);
  html = replaceMeta(html, 'property', 'og:url', shareUrl);
  html = replaceMeta(html, 'property', 'og:image:alt', `${title}: one tile per letter`);

  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(html, { status: response.status, headers });
};

export const config = { path: ['/rawkle', '/rawkle/'] };
