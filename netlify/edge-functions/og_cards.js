// Puts a shared 6* Card Game result into its link preview (mirror of og_rawkle.js).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the result rides in the link: /cards?s=1&r=<code> (see
// parseCardsResultCode in scripts/cards-result.mjs). This rewrites the /cards
// page's preview tags for that one link: the title is the result, the image is
// /api/cards-card for the same code, and og:url is the link itself so the
// platform doesn't fold it back into the generic /cards preview.
//
// Same rules as og_rawkle.js: a visit without ?r= is passed through untouched,
// only HTML is rewritten, and nothing from the URL reaches the page unchecked
// (the code must parse, and anything embedded in an attribute is escaped — a
// hand-crafted code could otherwise break out of an og: attribute).
import { parseCardsResultCode, cardsResultTitle } from '../../scripts/cards-result.mjs';

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One shared helper so a tag is only ever rewritten when it is actually found.
// A silent miss would leave the old picture in place — which is why the /cards
// page carries baseline og: tags for this to rewrite.
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
  const result = parseCardsResultCode(code);
  if (!result) return;

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const origin = `${url.protocol}//${url.host}`;
  const title = cardsResultTitle(result);
  const description = "It's Uno with bands. Match by shared members instead of colors.";
  const imageUrl = escapeAttr(`${origin}/api/cards-card?r=${code}`);
  const shareUrl = escapeAttr(`${origin}/cards?s=1&r=${code}`);

  let html = await response.text();
  html = replaceMeta(html, 'property', 'og:title', escapeAttr(title));
  html = replaceMeta(html, 'name', 'twitter:title', escapeAttr(title));
  html = replaceMeta(html, 'property', 'og:description', escapeAttr(description));
  html = replaceMeta(html, 'name', 'twitter:description', escapeAttr(description));
  html = replaceMeta(html, 'property', 'og:image', imageUrl);
  html = replaceMeta(html, 'name', 'twitter:image', imageUrl);
  html = replaceMeta(html, 'property', 'og:url', shareUrl);
  html = replaceMeta(html, 'property', 'og:image:alt', escapeAttr(`${title} — closing band ${result.closing}`));

  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(html, { status: response.status, headers });
};

export const config = { path: ['/cards', '/cards/'] };
