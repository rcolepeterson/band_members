// GET /api/og?anchor=Mudhoney — the picture a platform shows when someone pastes a link.
//
// WHY THIS EXISTS
//
// Sharing an image file is the weaker half of sharing. Facebook and Instagram drop the
// URL when a file is attached, so a recipient often gets a picture with no way to reach
// the graph, and the sharer has to download and attach it by hand. Pasting a LINK is
// what people actually do — and a link unfurls into whatever og:image says.
//
// The site already had og:image, but pointing at a single static file, so every share of
// every band advertised the same picture. This endpoint draws the shared view instead.
//
// WHY IT LOOKS LIKE THE SITE
//
// The layout is not reimplemented. getNeighborhood() and radialLayout() are the exact
// functions the browser uses, imported from scripts/neighborhood-helpers.mjs, at the same
// two-degree budget. So the card is the same constellation the recipient will land on
// rather than a different drawing of the same data.
//
// WHY pureimage
//
// A crawler needs a real raster — Facebook does not accept SVG for og:image. Every
// obvious rasteriser (sharp, node-canvas, resvg) is a native binary, and this runs in a
// bundled serverless function. pureimage is pure JavaScript: it loaded a font in 19ms and
// encoded a 1200x630 PNG in under 200ms in testing, with nothing to compile.
//
// WHY IT NEVER RETURNS AN ERROR
//
// A 500 here is a broken preview on somebody's Facebook post, which is worse than a
// generic one. Every failure path redirects to the static og-image.png, so a share always
// unfurls into something.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import * as PImage from 'pureimage';

import { getSql, isDbConfigured } from './_db.mjs';
import {
  buildAdjacency,
  getNeighborhood,
  radialLayout,
  resolveAnchor,
  normalizeAnchorKey,
  NEIGHBORHOOD_BUDGET,
} from '../../scripts/neighborhood-helpers.mjs';

// 1200x630 is the link-preview shape every platform crops to. The downloadable share
// image is square because it is posted as a picture in a feed; this one is a card.
const WIDTH = 1200;
const HEIGHT = 630;

const COLORS = {
  background: '#070b10',
  edge: 'rgba(161,204,228,0.34)',
  band: '#8fe8f6',
  member: '#c9b6f0',
  anchor: '#ffc978',
  label: '#dbe6f2',
  anchorLabel: '#ffd79a',
  wordmark: '#e9eef6',
  footer: '#cfe6f5',
  strip: '#0a1016',
};

// Fonts are read from disk at runtime rather than bundled, because esbuild inlines
// JavaScript and not binaries. netlify.toml ships them with the function via
// included_files; the candidate list below is belt and braces, because the working
// directory of a bundled function is not something to bet a launch on.
const FONT_FAMILY = 'OgSans';
const FONT_CANDIDATES = [
  'vendor/fonts/og/Lato-Medium.ttf',
  './vendor/fonts/og/Lato-Medium.ttf',
  join(process.cwd(), 'vendor/fonts/og/Lato-Medium.ttf'),
  '/var/task/vendor/fonts/og/Lato-Medium.ttf',
];

let fontReady = false;
function ensureFont() {
  if (fontReady) return true;
  const found = FONT_CANDIDATES.find(path => {
    try { return existsSync(path); } catch (_) { return false; }
  });
  if (!found) {
    console.error('og: no font found; tried', FONT_CANDIDATES);
    return false;
  }
  // registerFont wants a path. Copying into /tmp keeps pureimage away from a
  // read-only bundle layout, and /tmp survives between warm invocations.
  const scratch = join(tmpdir(), 'rbft-og-font.ttf');
  try {
    if (!existsSync(scratch)) writeFileSync(scratch, readFileSync(found));
    PImage.registerFont(scratch, FONT_FAMILY).loadSync();
    fontReady = true;
    return true;
  } catch (error) {
    console.error('og: font failed to load', error && error.message);
    return false;
  }
}

// The whole graph, cached for the life of a warm container. Every card needs the full
// node and link set to walk outward from its anchor, and re-reading 3,800 memberships per
// crawler hit would be the most expensive part of the request by far.
let graphCache = null;
const GRAPH_TTL_MS = 5 * 60 * 1000;

async function loadGraph() {
  if (graphCache && Date.now() - graphCache.at < GRAPH_TTL_MS) return graphCache.graph;
  const sql = getSql();
  const [bands, members, memberships] = await Promise.all([
    sql`select id, name, genre, city, state from bands`,
    sql`select id, name, instrument1, city, state from band_members`,
    sql`select band_id, member_id from memberships`,
  ]);
  const bandName = new Map(bands.map(b => [String(b.id), b.name]));
  const memberName = new Map(members.map(m => [String(m.id), m.name]));
  const nodes = [
    ...bands.map(b => ({ id: b.name, type: 'band', genre: b.genre, city: b.city, state: b.state })),
    ...members.map(m => ({ id: m.name, type: 'person', instrument: m.instrument1, city: m.city, state: m.state })),
  ].filter(n => n.id);
  const links = [];
  memberships.forEach(row => {
    const band = bandName.get(String(row.band_id));
    const member = memberName.get(String(row.member_id));
    if (band && member) links.push({ source: band, target: member });
  });
  const graph = { nodes, links };
  graphCache = { at: Date.now(), graph };
  return graph;
}

// Keeps the anchor plus the most-connected of its neighbours, nearest ring first, and
// only the edges that run between survivors. Degree is the tiebreak because it is the
// best cheap proxy for "a name someone might recognise".
const CARD_MAX_NODES = 26;

export function trimForCard(view, anchorId, adjacency) {
  if (!view || view.nodes.length <= CARD_MAX_NODES) return view;
  const degreeOf = id => (adjacency && adjacency.get(id) ? adjacency.get(id).size : 0);
  const hopOf = id => (view.depths && view.depths.has(id) ? view.depths.get(id) : 99);
  const keep = new Set(
    [...view.nodes]
      .sort((a, b) => {
        if (a.id === anchorId) return -1;
        if (b.id === anchorId) return 1;
        return hopOf(a.id) - hopOf(b.id) || degreeOf(b.id) - degreeOf(a.id);
      })
      .slice(0, CARD_MAX_NODES)
      .map(n => n.id)
  );
  const endpoint = side => (typeof side === 'object' ? side.id : side);
  return {
    ...view,
    nodes: view.nodes.filter(n => keep.has(n.id)),
    links: view.links.filter(l => keep.has(endpoint(l.source)) && keep.has(endpoint(l.target))),
    shownOf: view.nodes.length,
  };
}

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: {
      location: '/og-image.png',
      // Never cache the fallback: the next request should get a real card once whatever
      // went wrong is fixed, rather than a CDN serving the generic one for a day.
      'cache-control': 'no-store',
    },
  });

/**
 * Draws the card and returns a PNG Buffer, or null if the view cannot be drawn.
 *
 * Split out from the handler and exported so it can be exercised against the real
 * production fixture without a database or a deploy. The handler's only extra job is
 * fetching the graph and turning null into a redirect.
 */
export async function renderOgCard({ graph, search = '', host = 'bandmembers.netlify.app', stats = null } = {}) {
  if (!ensureFont()) return null;
  if (!graph || !graph.nodes || !graph.nodes.length) return null;
  {
    const url = { search, host };

    const adjacency = buildAdjacency(graph.nodes, graph.links);
    const resolved = resolveAnchor({
      search: url.search,
      nodes: graph.nodes,
      links: graph.links,
      adjacency,
    });
    if (!resolved.anchorId) return null;

    // The same budget the browser opens with, so the card shows what the recipient
    // will actually see: the anchor, its bands, and the people in them.
    const full = getNeighborhood({
      nodes: graph.nodes,
      links: graph.links,
      anchorId: resolved.anchorId,
      adjacency,
      maxHops: NEIGHBORHOOD_BUDGET.MAX_HOPS,
      maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
    });

    // A card is a taste of the graph, not the graph. The site opens with up to 60 nodes,
    // which is right on a screen you can pan and hover, and wrong at 1200x630 seen in a
    // feed: labelling 60 names in that space is not possible, so half the dots would end
    // up nameless and the picture would read as broken rather than dense. Drawing fewer
    // and labelling nearly all of them is the more inviting picture, and the subtitle
    // states the full count so the number is never overstated.
    const view = trimForCard(full, resolved.anchorId, adjacency);
    const positions = radialLayout({
      nodes: view.nodes,
      links: view.links,
      anchorId: resolved.anchorId,
      depths: view.depths,
      adjacency: buildAdjacency(view.nodes, view.links),
    });
    if (!positions.size) return null;

    // --- project the layout into the card --------------------------------------
    // Fit the actual extent rather than assuming one: a two-degree neighbourhood of a
    // four-band musician and of a twelve-band hub are wildly different sizes, and a
    // fixed scale would either crop the second or lose the first in the middle.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    positions.forEach(({ x, y }) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    // Generous right margin: labels are drawn to the right of their node, so fitting
    // the nodes alone would push the longest names off the edge.
    const box = { left: 96, right: WIDTH - 210, top: 146, bottom: HEIGHT - 96 };
    const scale = Math.min((box.right - box.left) / spanX, (box.bottom - box.top) / spanY);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const at = ({ x, y }) => ({ x: cx + (x - midX) * scale, y: cy + (y - midY) * scale });

    const img = PImage.make(WIDTH, HEIGHT);
    const ctx = img.getContext('2d');
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // edges first, so nodes sit on top of them
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1.4;
    view.links.forEach(link => {
      const a = positions.get(typeof link.source === 'object' ? link.source.id : link.source);
      const b = positions.get(typeof link.target === 'object' ? link.target.id : link.target);
      if (!a || !b) return;
      const p = at(a);
      const q = at(b);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    });

    if (stats) {
      stats.anchor = resolved.anchorId;
      stats.nodes = view.nodes.length;
      stats.edges = view.links.length;
      stats.unlabeled = [];
      stats.boxes = [];
    }
    const anchorKey = normalizeAnchorKey(resolved.anchorId);
    const byId = new Map(view.nodes.map(n => [n.id, n]));
    const degreeOf = id => (adjacency.get(id) ? adjacency.get(id).size : 0);
    // Nearest first so any name that has to go is an outer one; then most-connected
    // first, because on a hub every neighbour is one hop away and the tie has to break
    // somehow. Breaking it on degree means the recognisable names survive — on Pigface
    // that is the difference between labelling Trent Reznor and labelling whoever
    // happened to be first in the query result.
    const ordered = [...positions.entries()].sort((a, b) =>
      (a[1].hop || 0) - (b[1].hop || 0) || degreeOf(b[0]) - degreeOf(a[0]));

    // pureimage has no label-collision logic, so keep a simple occupied-box list and
    // skip any name that would print across one already placed. An overlapping pile of
    // names reads worse than a few bare dots.
    // Seeded with every node's own circle, not just with labels. Without this a name
    // prints straight through somebody else's dot: on the Pigface card, eleven labels
    // had a node sitting in the middle of the text. A dot is drawn first and cannot move,
    // so it is an obstacle like any other.
    const placed = [];
    positions.forEach((point, id) => {
      const node = byId.get(id);
      const isAnchor = normalizeAnchorKey(id) === anchorKey;
      const r = isAnchor ? 10 : (node && node.type === 'band' ? 7 : 5.5);
      const p = at(point);
      // `owner` so a node does not block its own name: every label sits right against its
      // dot by design, and without this exemption the first placement would always be
      // rejected and every name would jump to a worse position.
      placed.push({ owner: id, x: p.x - r - 2, y: p.y - r - 2, w: r * 2 + 4, h: r * 2 + 4 });
    });
    if (stats) stats.nodeBoxes = placed.map(b => ({ ...b }));

    const collides = (box, self) => placed.some(r =>
      r.owner !== self
      && box.x < r.x + r.w && box.x + box.w > r.x && box.y < r.y + r.h && box.y + box.h > r.y);

    // The first version of this let "Jenn Czeisler" and "The Protocol" print against each
    // other. I first assumed measureText was under-reporting, but measuring actual lit
    // pixels says it is accurate to about 1% (worst case 1.007 over a spread of real band
    // and member names at every size used here). The real cause was that nothing reserved
    // any space BETWEEN two labels: touching boxes do not overlap, so the check passed and
    // the card still looked wrong.
    //
    // So the gap is the fix and LABEL_PAD is only slack for glyphs this sample missed.
    //
    // CLEARANCE is that gap, applied as an explicit margin on all four sides of every
    // candidate box rather than as a side effect of the label's offset from its dot. Made
    // explicit because the earlier implicit version left labels legally clear and visibly
    // touching on the crowded hubs, in a way an overlap check by definition cannot see.
    const LABEL_PAD = 1.04;
    const CLEARANCE = 6;
    const LABEL_GAP = 8;
    const inflate = box => ({
      x: box.x - CLEARANCE,
      y: box.y - CLEARANCE,
      w: box.w + CLEARANCE * 2,
      h: box.h + CLEARANCE * 2,
    });
    const measure = (text, size) => {
      let width;
      try { width = PImage.measureText(ctx, text).width; } catch (_) { width = text.length * size * 0.58; }
      if (!Number.isFinite(width) || width <= 0) width = text.length * size * 0.58;
      return width * LABEL_PAD;
    };

    ordered.forEach(([id, point]) => {
      const node = byId.get(id);
      const isAnchor = normalizeAnchorKey(id) === anchorKey;
      const p = at(point);
      const radius = isAnchor ? 10 : (node && node.type === 'band' ? 7 : 5.5);
      ctx.fillStyle = isAnchor ? COLORS.anchor : (node && node.type === 'band' ? COLORS.band : COLORS.member);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      const text = String(id);
      // Long anchor names step down a little. "Mark Knopfler's Guitar Heroes" at 19pt is
      // wider than a third of the card and leaves nowhere clean to sit.
      let size = isAnchor ? (text.length > 22 ? 16 : 19) : 15;
      ctx.font = `${size}pt ${FONT_FAMILY}`;
      const width = measure(text, size);
      const height = size * 1.5;

      // Eight placements before giving up. Sigma only ever writes to the right, so a
      // crowded neighbourhood loses names it does not have to: there is usually free
      // space on the other side of the dot, under it, or diagonally off it. Right first so
      // the common case still matches what the site does, then left, then straight
      // above/below, then the diagonals as a last resort — a diagonal label is slightly
      // harder to associate with its dot, so it is worth trying only once the easy
      // positions are taken.
      //
      // Measured, going from four positions to eight: a synthetic 60-member star with
      // uniformly long names went from 27% of its drawn dots nameless to 19%, and a sweep
      // of the 18 busiest anchors in the real data went from 14.6% to 11.3%.
      const offset = radius + LABEL_GAP;
      const mid = p.y + size * 0.36;
      const below = p.y + radius + size + 4;
      const above = p.y - radius - 6;
      const candidates = [
        { x: p.x + offset, y: mid },
        { x: p.x - offset - width, y: mid },
        { x: p.x - width / 2, y: below },
        { x: p.x - width / 2, y: above },
        { x: p.x + offset * 0.7, y: below },
        { x: p.x - offset * 0.7 - width, y: below },
        { x: p.x + offset * 0.7, y: above },
        { x: p.x - offset * 0.7 - width, y: above },
      ];

      const inFrame = c => c.x >= 16 && c.x + width <= WIDTH - 16
        && c.y - size >= 132 && c.y <= HEIGHT - 74;
      const boxAt = c => ({ x: c.x, y: c.y - size, w: width, h: height });
      let spot = candidates.find(c => inFrame(c) && !collides(inflate(boxAt(c)), id));
      // The anchor is what the card is about. If its name cannot find a clear spot it is
      // still drawn — an unnamed subject would make the whole preview pointless. It is
      // placed first, so in practice there is nothing yet to clash with.
      if (!spot && isAnchor) spot = candidates.find(inFrame) || candidates[0];
      if (!spot) { if (stats) stats.unlabeled.push(text); return; }

      placed.push(boxAt(spot));

      // Every label sits on a plate, not just the anchor's.
      //
      // Labels are kept clear of other labels and of every dot, but NOT of edges, and on a
      // hub the edges radiate through the whole card -- so on the live Nine Inch Nails card
      // a line ran straight through "Richard Patrick", "Pino Palladino" and "Martin
      // Atkins". Requiring labels to dodge edges as well would have dropped most of the
      // names on exactly the crowded cards that need them, since on a starburst every
      // direction has a line in it.
      //
      // A plate is the better trade: the line stops at the text instead of crossing it, and
      // no name is lost.
      //
      // Opaque, not translucent. A first attempt at 78% still let 22% of the line through,
      // which on a thin pale edge was perfectly visible -- the fix looked like no fix at
      // all. The graph area is a single flat colour, so an opaque plate in that exact
      // colour is itself invisible: it reads as the line passing behind the name.
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(spot.x - 5, spot.y - size - 2, width + 10, height + 2);

      ctx.fillStyle = isAnchor ? COLORS.anchorLabel : COLORS.label;
      ctx.fillText(text, spot.x, spot.y);
      if (stats) stats.boxes.push({ text, anchor: isAnchor, x: spot.x, y: spot.y - size, w: width, h: height });
    });

    // --- wordmark and footer ---------------------------------------------------
    ctx.fillStyle = COLORS.wordmark;
    ctx.font = `26pt ${FONT_FAMILY}`;
    ctx.fillText('SIX DEGREES OF ROCK', 90, 74);

    const kind = byId.get(resolved.anchorId);
    const descriptor = kind && kind.type === 'band' ? 'band' : 'musician';
    ctx.fillStyle = 'rgba(184,202,220,0.92)';
    ctx.font = `15pt ${FONT_FAMILY}`;
    // Say the real number. If the card is a trimmed view, the subtitle admits it rather
    // than quietly presenting 26 as the whole neighbourhood.
    const total = view.shownOf || view.nodes.length;
    const shown = view.nodes.length;
    const count = shown < total
      ? `${shown} of ${total} connections`
      : `${total} connection${total === 1 ? '' : 's'}`;
    ctx.fillText(
      `${resolved.anchorId} — ${count}, ${NEIGHBORHOOD_BUDGET.MAX_HOPS} degrees out from this ${descriptor}`,
      90,
      112
    );

    const stripTop = HEIGHT - 62;
    ctx.fillStyle = COLORS.strip;
    ctx.fillRect(0, stripTop, WIDTH, 62);
    ctx.fillStyle = COLORS.footer;
    ctx.font = `16pt ${FONT_FAMILY}`;
    // A person reads this strip; a browser never follows it. encodeURIComponent would
    // print "Aaron%20McRae", so spaces become the '+' form a query string also accepts
    // and the rest is left alone.
    const prettyAnchor = String(resolved.anchorId).replace(/\s+/g, '+');
    ctx.fillText(`${url.host}/?anchor=${prettyAnchor}`, 90, stripTop + 39);

    // A real PassThrough rather than a hand-rolled sink. pureimage writes to the stream
    // and resolves on its 'finish' event, so a fake that merely collects chunks leaves
    // the promise pending forever — the process then exits silently with no output,
    // which is exactly what happened on the first run.
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await PImage.encodePNGToStream(img, sink);
    const png = Buffer.concat(chunks);
    if (!png.length) return null;

    return png;
  }
}

export default async (req) => {
  try {
    if (!isDbConfigured()) return fallback();
    const url = new URL(req.url);
    const graph = await loadGraph();
    const png = await renderOgCard({ graph, search: url.search, host: url.host });
    if (!png || !png.length) return fallback();

    return new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        // Crawlers re-fetch, and several will hit the same URL at once when a link is
        // posted. s-maxage lets Netlify's CDN answer those from the edge; the graph
        // changes rarely enough that a day of staleness is invisible, and
        // stale-while-revalidate means nobody waits for the refresh.
        'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (error) {
    console.error('og: falling back to the static card', error && error.message);
    return fallback();
  }
};

export const config = { path: '/api/og' };
