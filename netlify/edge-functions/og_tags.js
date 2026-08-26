// Rewrites the link-preview meta tags for a shared graph view.
//
// WHY AN EDGE FUNCTION AND NOT JAVASCRIPT
//
// The tags a platform reads are read by a crawler, and crawlers do not run scripts.
// Setting og:image from the page's own code would work for nobody: Facebook, iMessage,
// Slack, WhatsApp and X all fetch the HTML and parse it as text. So the substitution has
// to happen before the HTML leaves the server, which on a static site means at the edge.
//
// WHY IT USUALLY DOES NOTHING
//
// This runs in front of the site's only HTML page, so it is on the critical path of every
// visit. Requests without an anchor parameter are passed straight through untouched and
// never even read the body — a plain visit to the bare origin costs a function invocation
// and nothing else. Only a shared link, which by definition carries ?anchor=, is rewritten.
//
// WHY THE NAME IS ESCAPED
//
// The anchor comes from the URL, and it is being written into an HTML attribute. Escaping
// it is not optional: without it, a crafted link would inject markup into the page for
// every crawler and browser that followed it. The name is also length-capped and stripped
// of control characters, and the picture itself is drawn from a name resolved against the
// real database, so a made-up anchor cannot produce a made-up graph.
const ANCHOR_PARAMS = ['node', 'band', 'member', 'person', 'anchor'];
const MAX_NAME = 64;

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One shared helper so a tag is only ever rewritten when it is actually found. A silent
// miss would leave the old picture in place, which is the current behaviour anyway — far
// better than emitting a broken tag or an empty content attribute.
function replaceMeta(html, attr, name, value) {
  const pattern = new RegExp(
    `(<meta\\s+${attr}=["']${name}["']\\s+content=["'])([^"']*)(["'])`,
    'i'
  );
  return html.replace(pattern, (match, head, _old, tail) => `${head}${value}${tail}`);
}

export default async (request, context) => {
  const url = new URL(request.url);

  let raw = null;
  for (const key of ANCHOR_PARAMS) {
    const found = url.searchParams.get(key);
    if (found && found.trim()) { raw = found.trim(); break; }
  }
  // No anchor means an ordinary visit. Hand it back without touching the body.
  if (!raw) return;

  const response = await context.next();

  // Only ever rewrite HTML. The path config should guarantee this, but a content-type
  // check costs nothing and keeps a stray match from corrupting an asset.
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_NAME);
  if (!name) return response;

  const safeName = escapeAttr(name);
  const origin = `${url.protocol}//${url.host}`;
  const shareUrl = escapeAttr(`${origin}/?anchor=${encodeURIComponent(name)}`);
  const imageUrl = escapeAttr(`${origin}/api/og?anchor=${encodeURIComponent(name)}`);
  const title = `${safeName} &mdash; Six Degrees of Rock`;
  const description = `See who ${safeName} played with, and how far the connections reach.`;

  let html = await response.text();
  html = replaceMeta(html, 'property', 'og:image', imageUrl);
  html = replaceMeta(html, 'name', 'twitter:image', imageUrl);
  html = replaceMeta(html, 'property', 'og:url', shareUrl);
  html = replaceMeta(html, 'property', 'og:title', title);
  html = replaceMeta(html, 'name', 'twitter:title', title);
  html = replaceMeta(html, 'property', 'og:description', description);
  html = replaceMeta(html, 'name', 'twitter:description', description);
  html = replaceMeta(html, 'property', 'og:image:alt', `The ${safeName} neighbourhood in Six Degrees of Rock`);

  const headers = new Headers(response.headers);
  // The body now depends on the query string, so it must not be cached as if it were the
  // generic page. Netlify keys its edge cache on the full URL, but any intermediate cache
  // between here and the crawler would happily reuse one anchor's HTML for another.
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.delete('content-length');
  headers.delete('etag');

  return new Response(html, { status: response.status, headers });
};

export const config = { path: '/' };
