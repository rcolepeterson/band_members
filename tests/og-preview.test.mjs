// Tests for dynamic link previews: the /api/og card image and the edge function that
// points a shared URL at it.
//
// WHY THIS FILE EXISTS AT ALL
//
// A link preview is the one part of the product nobody on the team ever sees while
// working on it. It is rendered on Facebook's servers, cached there, and shown to
// strangers. If it regresses, the failure is silent: the site still works, shares still
// go out, and the picture is just wrong or missing forever. So the properties below are
// checked here rather than trusted to a glance at a deploy.
//
// What this locks in:
//
//   1. The card draws for real production-shaped data and comes back as a valid PNG.
//   2. No label is printed across another label or across another node's dot, with a
//      real margin -- not merely non-overlapping, because two boxes can share an edge and
//      look wrong while passing an overlap test. That exact mistake shipped in the first
//      draft of the poster work.
//   3. The anchor is always named, even when it is a hub with no clear space, because an
//      unnamed subject makes the whole preview pointless.
//   4. Every failure path returns null so the handler can fall back to the static image.
//      A broken preview is worse than a generic one.
//   5. The edge function escapes the anchor name before writing it into an HTML
//      attribute, and leaves ordinary visits completely untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderOgCard, trimForCard } from '../netlify/functions/og_image.mjs';
import ogTags from '../netlify/edge-functions/og_tags.js';
import { buildAdjacency } from '../scripts/neighborhood-helpers.mjs';

// A small graph shaped like the real one: bands joined to members, one hub.
function makeGraph() {
  const nodes = [
    { id: 'Mudhoney', type: 'band' },
    { id: 'Green River', type: 'band' },
    { id: 'Bloodloss', type: 'band' },
    { id: 'Mark Arm', type: 'person' },
    { id: 'Steve Turner', type: 'person' },
    { id: 'Dan Peters', type: 'person' },
    { id: 'Guy Maddison', type: 'person' },
  ];
  const links = [
    { source: 'Mudhoney', target: 'Mark Arm' },
    { source: 'Mudhoney', target: 'Steve Turner' },
    { source: 'Mudhoney', target: 'Dan Peters' },
    { source: 'Mudhoney', target: 'Guy Maddison' },
    { source: 'Green River', target: 'Mark Arm' },
    { source: 'Green River', target: 'Steve Turner' },
    { source: 'Bloodloss', target: 'Guy Maddison' },
  ];
  return { nodes, links };
}

// A deliberately crowded star: one band, many members, all one hop out. This is the
// shape that broke label placement, so it is the shape worth testing.
function makeHub(memberCount = 60) {
  const nodes = [{ id: 'Hub Band', type: 'band' }];
  const links = [];
  for (let i = 0; i < memberCount; i += 1) {
    const name = `Member Number ${i} Longname`;
    nodes.push({ id: name, type: 'person' });
    links.push({ source: 'Hub Band', target: name });
  }
  return { nodes, links };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const boxesTouch = (a, b, margin) =>
  a.x - margin < b.x + b.w && a.x + a.w + margin > b.x
  && a.y - margin < b.y + b.h && a.y + a.h + margin > b.y;

test('the card renders a valid PNG for a normal neighborhood', async () => {
  const graph = makeGraph();
  const stats = {};
  const png = await renderOgCard({ graph, search: '?anchor=Mudhoney', stats });

  assert.ok(png && png.length > 1000, 'expected a PNG of some substance');
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC, 'expected PNG magic bytes');
  assert.equal(stats.anchor, 'Mudhoney');
  assert.ok(stats.nodes >= 5, `expected the neighborhood to be drawn, got ${stats.nodes}`);
});

test('no label is printed across another label', async () => {
  for (const graph of [makeGraph(), makeHub()]) {
    const stats = {};
    await renderOgCard({ graph, search: `?anchor=${encodeURIComponent(graph.nodes[0].id)}`, stats });
    // The anchor is drawn on a background plate, so its overlap is deliberate and
    // legible. Every other label had to find genuinely clear space.
    const labels = stats.boxes.filter(b => !b.anchor);
    const clashes = [];
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        // Margin 3, not 0: adjacent boxes do not overlap but do look wrong.
        if (boxesTouch(labels[i], labels[j], 3)) clashes.push(`${labels[i].text} / ${labels[j].text}`);
      }
    }
    assert.deepEqual(clashes, [], `labels collided: ${clashes.slice(0, 4).join(', ')}`);
  }
});

test('no label is printed across another node', async () => {
  for (const graph of [makeGraph(), makeHub()]) {
    const stats = {};
    await renderOgCard({ graph, search: `?anchor=${encodeURIComponent(graph.nodes[0].id)}`, stats });
    const labels = stats.boxes.filter(b => !b.anchor);
    const clashes = [];
    labels.forEach(label => {
      stats.nodeBoxes.forEach(node => {
        // A node never blocks its own name -- labels sit against their dot by design.
        if (node.owner === label.text) return;
        if (boxesTouch(label, node, 2)) clashes.push(`${label.text} over ${node.owner}`);
      });
    });
    assert.deepEqual(clashes, [], `labels crossed nodes: ${clashes.slice(0, 4).join(', ')}`);
  }
});

test('the anchor is always named, even on a crowded hub', async () => {
  for (const [graph, anchor] of [[makeGraph(), 'Mudhoney'], [makeHub(), 'Hub Band']]) {
    const stats = {};
    await renderOgCard({ graph, search: `?anchor=${encodeURIComponent(anchor)}`, stats });
    const named = stats.boxes.find(b => b.anchor);
    assert.ok(named, `the anchor ${anchor} was drawn without its name`);
    assert.equal(named.text, anchor);
    assert.ok(!stats.unlabeled.includes(anchor), 'the anchor must never be dropped');
  }
});

test('most names survive on a crowded hub', async () => {
  const stats = {};
  await renderOgCard({ graph: makeHub(), search: '?anchor=Hub+Band', stats });
  // The point of trimming the card is that what IS drawn is readable. If more than a
  // quarter of the drawn dots are nameless, the trim is no longer doing its job and the
  // card has drifted back toward a field of anonymous dots.
  const drawn = stats.nodes;
  const missing = stats.unlabeled.length;
  assert.ok(
    missing / drawn <= 0.25,
    `${missing} of ${drawn} nodes went unlabeled -- the card is too crowded to read`
  );
});

test('a hub is trimmed to a readable size and reports the real total', () => {
  const graph = makeHub(60);
  const adjacency = buildAdjacency(graph.nodes, graph.links);
  const view = {
    nodes: graph.nodes,
    links: graph.links,
    depths: new Map(graph.nodes.map(n => [n.id, n.id === 'Hub Band' ? 0 : 1])),
  };
  const trimmed = trimForCard(view, 'Hub Band', adjacency);

  assert.ok(trimmed.nodes.length < graph.nodes.length, 'expected the hub to be trimmed');
  assert.equal(trimmed.shownOf, graph.nodes.length, 'the full count must be preserved for the subtitle');
  assert.ok(trimmed.nodes.some(n => n.id === 'Hub Band'), 'the anchor must survive the trim');
  // Every remaining edge must join two remaining nodes, or the card would draw a line
  // to a dot that is not there.
  const ids = new Set(trimmed.nodes.map(n => n.id));
  trimmed.links.forEach(link => {
    const a = typeof link.source === 'object' ? link.source.id : link.source;
    const b = typeof link.target === 'object' ? link.target.id : link.target;
    assert.ok(ids.has(a) && ids.has(b), `dangling edge ${a} -> ${b}`);
  });
});

test('a small neighborhood is left alone by the trim', () => {
  const graph = makeGraph();
  const view = { nodes: graph.nodes, links: graph.links, depths: new Map() };
  const same = trimForCard(view, 'Mudhoney', buildAdjacency(graph.nodes, graph.links));
  assert.equal(same.nodes.length, graph.nodes.length);
});

test('every unusable input yields null so the handler can fall back', async () => {
  const cases = [
    ['no arguments', undefined],
    ['empty graph', { graph: { nodes: [], links: [] }, search: '?anchor=x' }],
    ['null graph', { graph: null, search: '?anchor=x' }],
  ];
  for (const [label, args] of cases) {
    const result = await renderOgCard(args);
    assert.equal(result, null, `${label} should return null, not throw or draw`);
  }
});

test('an unknown anchor still draws a card rather than failing', async () => {
  // resolveAnchor falls back to the default anchor, which is the right behaviour: a
  // stale or mistyped link should still unfurl into something inviting.
  const png = await renderOgCard({
    graph: makeGraph(),
    search: '?anchor=Nobody+By+That+Name',
  });
  assert.ok(png && png.length > 1000, 'expected a fallback card, not null');
});

// --- the edge function -------------------------------------------------------

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function ctxFor(html = HTML) {
  return {
    next: async () => new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        etag: '"cafe"',
        'content-length': String(html.length),
      },
    }),
  };
}

const metaValues = (html) => {
  const head = html.slice(0, html.indexOf('</head>'));
  return [...head.matchAll(/<meta\s+(?:property|name)=["'][^"']*["']\s+content=(["'])((?:(?!\1)[\s\S])*)\1/gi)]
    .map(match => match[2]);
};

const metaValue = (html, attr, name) => {
  const found = html.match(new RegExp(`<meta\\s+${attr}=["']${name}["']\\s+content=["']([^"']*)["']`, 'i'));
  return found ? found[1] : null;
};

test('an ordinary visit is passed through untouched', async () => {
  const result = await ogTags(new Request('https://bandmembers.netlify.app/'), ctxFor());
  // Returning nothing tells Netlify to serve the origin response as-is. The body is
  // never even read, which is the point: this function sits in front of every visit.
  assert.equal(result, undefined);
});

test('a shared link points the preview at that view', async () => {
  const res = await ogTags(
    new Request('https://bandmembers.netlify.app/?anchor=Mudhoney'),
    ctxFor()
  );
  const html = await res.text();

  assert.equal(
    metaValue(html, 'property', 'og:image'),
    'https://bandmembers.netlify.app/api/og?anchor=Mudhoney'
  );
  assert.equal(
    metaValue(html, 'name', 'twitter:image'),
    'https://bandmembers.netlify.app/api/og?anchor=Mudhoney'
  );
  assert.equal(
    metaValue(html, 'property', 'og:url'),
    'https://bandmembers.netlify.app/?anchor=Mudhoney'
  );
  assert.match(metaValue(html, 'property', 'og:title'), /^Mudhoney /);
  assert.match(metaValue(html, 'name', 'twitter:title'), /^Mudhoney /);
});

test('the other anchor aliases work too', async () => {
  for (const key of ['node', 'band', 'member', 'person']) {
    const res = await ogTags(
      new Request(`https://bandmembers.netlify.app/?${key}=Nine+Inch+Nails`),
      ctxFor()
    );
    const html = await res.text();
    assert.match(
      metaValue(html, 'property', 'og:image'),
      /anchor=Nine%20Inch%20Nails$/,
      `?${key}= should drive the preview`
    );
  }
});

test('a crafted anchor cannot inject markup into the head', async () => {
  const payloads = [
    '"><script>alert(1)</script><meta x="',
    "' onload='x",
    '</title><img src=x onerror=alert(1)>',
    'Hall & Oates',
    '"><svg/onload=alert(1)>',
  ];
  for (const payload of payloads) {
    const res = await ogTags(
      new Request(`https://bandmembers.netlify.app/?anchor=${encodeURIComponent(payload)}`),
      ctxFor()
    );
    const html = await res.text();

    // The payload text may well appear -- escaped, it is harmless data. What must never
    // happen is a raw quote or angle bracket surviving INSIDE an attribute value, which
    // is what would close the attribute early and start new markup.
    const leaked = metaValues(html).filter(value => /[<>"']/.test(value));
    assert.deepEqual(
      leaked,
      [],
      `raw delimiter survived into a meta attribute: ${JSON.stringify(leaked[0])}`
    );

    // And the head must contain no more elements than it started with.
    const before = (HTML.slice(0, HTML.indexOf('</head>')).match(/<script/gi) || []).length;
    const after = (html.slice(0, html.indexOf('</head>')).match(/<script/gi) || []).length;
    assert.equal(after, before, 'a script tag appeared in the head');
  }
});

test('an over-long anchor is capped', async () => {
  const res = await ogTags(
    new Request(`https://bandmembers.netlify.app/?anchor=${'A'.repeat(500)}`),
    ctxFor()
  );
  const html = await res.text();
  const title = metaValue(html, 'property', 'og:title');
  assert.ok(title.length < 200, `expected a capped title, got ${title.length} characters`);
});

test('a blank anchor is treated as no anchor', async () => {
  const result = await ogTags(
    new Request('https://bandmembers.netlify.app/?anchor=%20%20'),
    ctxFor()
  );
  assert.equal(result, undefined, 'whitespace is not an anchor');
});

test('stale validators are dropped from a rewritten response', async () => {
  const res = await ogTags(
    new Request('https://bandmembers.netlify.app/?anchor=Mudhoney'),
    ctxFor()
  );
  // The body changed length and content, so the origin's Content-Length and ETag no
  // longer describe it. Leaving either would let a cache serve a truncated page or
  // answer a revalidation with the wrong body.
  assert.equal(res.headers.get('content-length'), null);
  assert.equal(res.headers.get('etag'), null);
  assert.match(res.headers.get('cache-control') || '', /must-revalidate/);
});

test('a non-HTML response is never rewritten', async () => {
  const ctx = {
    next: async () => new Response('binary-ish', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  };
  const res = await ogTags(new Request('https://bandmembers.netlify.app/?anchor=Mudhoney'), ctx);
  assert.equal(await res.text(), 'binary-ish');
});
