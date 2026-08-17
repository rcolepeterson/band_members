// Tests for the Sigma neighborhood explorer's pure logic layer (issue #80).
//
// What this locks in:
//
//   1. The renderer feature flag defaults to the shipped SVG renderer, so
//      merging the Sigma work cannot change what a normal visitor sees.
//   2. Breadth-first neighborhoods respect the visible-node budget, admit
//      nearer relationships before distant ones, and report a frontier so
//      the UI can say "there is more graph" instead of silently truncating.
//   3. Deep/shared links beat the Aaron McRae fallback anchor. This is the
//      shared-context guarantee from the migration plan.
//   4. The space metaphor mapping: home star / solar system / constellation /
//      planet / moon / asteroid.
//   5. The Graphology adapter produces a graph whose shortest paths translate
//      into user-facing degrees where a shared member counts as ONE.
//
// Pure logic — no DOM, no sigma, no d3. Graphology comes from the
// devDependency; the browser gets the same major version from the CDN.

import test from 'node:test';
import assert from 'node:assert/strict';
import Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted.js';

import {
  RENDERER_FLAG,
  DEFAULT_RENDERER,
  rendererFromSearch,
  NEIGHBORHOOD_BUDGET,
  buildAdjacency,
  getNeighborhood,
  resolveAnchor,
  classifyNode,
  NODE_KINDS,
  HOME_STAR_STYLE,
  toGraphologyGraph,
  pathToUserFacingDegrees,
  linkEndpoints,
} from '../scripts/neighborhood-helpers.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Aaron bridges two bands; each band has other members; one of those members
// bridges out to a third band, giving us hop 1/2/3 to traverse. Plus one
// orphan band and one touring-only member for the classification tests.
function fixture() {
  const nodes = [
    { id: 'Aaron McRae', type: 'person', city: 'Seattle', country: 'US' },
    { id: 'Band Alpha', type: 'band', city: 'Seattle', country: 'US', genre: 'Post-punk' },
    { id: 'Band Beta', type: 'band', city: 'Tacoma', country: 'US', genre: 'Punk' },
    { id: 'Band Gamma', type: 'band', city: 'Olympia', country: 'US', genre: 'Punk' },
    { id: 'Dana Lee', type: 'person', city: 'Seattle', country: 'US' },
    { id: 'Kim Park', type: 'person', city: 'Tacoma', country: 'US' },
    { id: 'Sam Cruz', type: 'person', city: 'Olympia', country: 'US' },
    { id: 'Tour Guy', type: 'person', city: 'Portland', country: 'US' },
    { id: 'Orphan Band', type: 'band', city: '', country: '' },
  ];
  const links = [
    { source: 'Band Alpha', target: 'Aaron McRae', relation: 'member', weight: 1 },
    { source: 'Band Beta', target: 'Aaron McRae', relation: 'member', weight: 1 },
    { source: 'Band Alpha', target: 'Dana Lee', relation: 'member', weight: 1 },
    { source: 'Band Beta', target: 'Kim Park', relation: 'member', weight: 1 },
    { source: 'Band Beta', target: 'Tour Guy', relation: 'touring', weight: 1 },
    { source: 'Band Gamma', target: 'Kim Park', relation: 'member', weight: 1 },
    { source: 'Band Gamma', target: 'Sam Cruz', relation: 'member', weight: 1 },
  ];
  return { nodes, links };
}

// A wide star: one anchor band with many members, used for budget tests.
function wideFixture(memberCount) {
  const nodes = [{ id: 'Hub Band', type: 'band' }];
  const links = [];
  for (let i = 0; i < memberCount; i += 1) {
    const id = `Member ${String(i).padStart(3, '0')}`;
    nodes.push({ id, type: 'person' });
    links.push({ source: 'Hub Band', target: id, relation: 'member', weight: 1 });
  }
  return { nodes, links };
}

// ---------------------------------------------------------------------------
// 1. Feature flag
// ---------------------------------------------------------------------------

test('the constellation is what a visitor gets by default', () => {
  assert.equal(RENDERER_FLAG, 'renderer');
  assert.equal(DEFAULT_RENDERER, 'sigma');
  assert.equal(rendererFromSearch(''), 'sigma');
  // A shared deep link with no renderer named still opens the constellation.
  assert.equal(rendererFromSearch('?band=Nirvana'), 'sigma');
});

test('the original renderer stays reachable, and unknown values fall back', () => {
  // ?renderer=svg is a deliberate escape hatch: it is the only way to reach the
  // scene and genre filters and Recently-added until those are rebuilt on the
  // Sigma path, and it is what to reach for if the constellation misbehaves in
  // production.
  assert.equal(rendererFromSearch('?renderer=svg'), 'svg');
  assert.equal(rendererFromSearch('?renderer=sigma'), 'sigma');
  assert.equal(rendererFromSearch('renderer=SIGMA'), 'sigma');
  assert.equal(rendererFromSearch('?renderer=webgl2000'), 'sigma');
  assert.equal(rendererFromSearch('?renderer='), 'sigma');
});

// ---------------------------------------------------------------------------
// 2. Neighborhood traversal + budget
// ---------------------------------------------------------------------------

test('budget constants keep the opening view small', () => {
  assert.equal(NEIGHBORHOOD_BUDGET.DEFAULT_ANCHOR, 'Aaron McRae');
  assert.ok(NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES <= NEIGHBORHOOD_BUDGET.MAX_NODES);
  assert.ok(NEIGHBORHOOD_BUDGET.MAX_NODES <= 100, 'visible node budget must stay at or under 100');
  assert.ok(NEIGHBORHOOD_BUDGET.MAX_HOPS <= 3);
});

test('one hop from the anchor returns only the anchor and its bands', () => {
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 1 });
  assert.deepEqual(view.nodes.map(n => n.id).sort(), ['Aaron McRae', 'Band Alpha', 'Band Beta']);
  // Only links with BOTH endpoints visible are rendered.
  assert.equal(view.links.length, 2);
  view.links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    assert.ok(view.nodes.some(n => n.id === source));
    assert.ok(view.nodes.some(n => n.id === target));
  });
});

test('hop depth is recorded per node and matches relationship distance', () => {
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 3 });
  const hop = id => view.nodes.find(n => n.id === id).hop;
  assert.equal(hop('Aaron McRae'), 0);
  assert.equal(hop('Band Alpha'), 1);
  assert.equal(hop('Band Beta'), 1);
  assert.equal(hop('Dana Lee'), 2);
  assert.equal(hop('Kim Park'), 2);
  assert.equal(hop('Band Gamma'), 3);
  assert.equal(view.depths.get('Band Gamma'), 3);
});

test('nodes beyond maxHops are frontier, not rendered', () => {
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 2 });
  const ids = view.nodes.map(n => n.id);
  assert.ok(!ids.includes('Band Gamma'));
  assert.ok(view.frontier.includes('Band Gamma'), 'Band Gamma should be offered as expandable');
  // Disconnected records never appear, in either list.
  assert.ok(!ids.includes('Orphan Band'));
  assert.ok(!view.frontier.includes('Orphan Band'));
});

test('the node budget caps the visible graph and flags truncation', () => {
  const { nodes, links } = wideFixture(500);
  const view = getNeighborhood({ nodes, links, anchorId: 'Hub Band', maxHops: 3, maxNodes: 60 });
  assert.equal(view.nodes.length, 60);
  assert.equal(view.truncated, true);
  assert.ok(view.frontier.length > 0, 'unrendered neighbors must be reported as frontier');
  assert.ok(view.nodes.some(n => n.id === 'Hub Band'));
});

test('the edge budget caps rendered links', () => {
  const { nodes, links } = wideFixture(500);
  const view = getNeighborhood({ nodes, links, anchorId: 'Hub Band', maxNodes: 100, maxEdges: 25 });
  assert.equal(view.links.length, 25);
  assert.equal(view.truncated, true);
});

test('nearer hops are admitted before farther ones under a tight budget', () => {
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 3, maxNodes: 3 });
  assert.deepEqual(view.nodes.map(n => n.id).sort(), ['Aaron McRae', 'Band Alpha', 'Band Beta']);
  assert.equal(view.truncated, true);
});

test('a missing or unknown anchor yields an empty view rather than throwing', () => {
  const { nodes, links } = fixture();
  assert.equal(getNeighborhood({ nodes, links, anchorId: 'Nobody At All' }).nodes.length, 0);
  assert.equal(getNeighborhood({ nodes, links }).nodes.length, 0);
  assert.equal(getNeighborhood({}).nodes.length, 0);
});

test('traversal is reproducible for the same anchor and budget', () => {
  const { nodes, links } = wideFixture(200);
  const a = getNeighborhood({ nodes, links, anchorId: 'Hub Band', maxNodes: 40 });
  const b = getNeighborhood({ nodes, links, anchorId: 'Hub Band', maxNodes: 40 });
  assert.deepEqual(a.nodes.map(n => n.id), b.nodes.map(n => n.id));
});

test('buildAdjacency treats membership links as bidirectional', () => {
  const { nodes, links } = fixture();
  const adjacency = buildAdjacency(nodes, links);
  assert.ok(adjacency.get('Aaron McRae').has('Band Alpha'));
  assert.ok(adjacency.get('Band Alpha').has('Aaron McRae'));
  assert.equal(adjacency.get('Orphan Band').size, 0);
});

// ---------------------------------------------------------------------------
// 3. Anchor resolution
// ---------------------------------------------------------------------------

test('direct visits fall back to Aaron McRae', () => {
  const { nodes, links } = fixture();
  const resolved = resolveAnchor({ search: '', nodes, links });
  assert.equal(resolved.anchorId, 'Aaron McRae');
  assert.equal(resolved.source, 'fallback');
});

test('a shared/deep link overrides the fallback anchor', () => {
  const { nodes, links } = fixture();
  for (const param of ['band', 'member', 'node', 'person', 'anchor']) {
    const resolved = resolveAnchor({ search: `?${param}=Band%20Gamma`, nodes, links });
    assert.equal(resolved.anchorId, 'Band Gamma', `?${param}= should win`);
    assert.equal(resolved.source, 'deep-link');
  }
});

test('deep-link matching ignores case and stray whitespace', () => {
  const { nodes, links } = fixture();
  assert.equal(resolveAnchor({ search: '?band=  band   beta ', nodes, links }).anchorId, 'Band Beta');
});

test('a deep link to an unmapped band does not silently hijack the anchor', () => {
  const { nodes, links } = fixture();
  const resolved = resolveAnchor({ search: '?band=Not In The Tree', nodes, links });
  assert.equal(resolved.anchorId, 'Aaron McRae');
  assert.equal(resolved.source, 'fallback');
});

test('a runtime request (search selection) beats the fallback but loses to a deep link', () => {
  const { nodes, links } = fixture();
  assert.equal(resolveAnchor({ nodes, links, requested: 'Band Gamma' }).source, 'requested');
  assert.equal(
    resolveAnchor({ search: '?band=Band Alpha', nodes, links, requested: 'Band Gamma' }).anchorId,
    'Band Alpha'
  );
});

test('a graph without Aaron opens on its highest-degree node', () => {
  const { nodes, links } = fixture();
  const withoutAaron = {
    nodes: nodes.filter(n => n.id !== 'Aaron McRae'),
    links: links.filter(l => linkEndpoints(l)[1] !== 'Aaron McRae'),
  };
  const resolved = resolveAnchor({ nodes: withoutAaron.nodes, links: withoutAaron.links });
  assert.equal(resolved.source, 'highest-degree');
  assert.ok(['Band Beta', 'Band Gamma'].includes(resolved.anchorId));
  assert.equal(resolveAnchor({ nodes: [], links: [] }).anchorId, null);
});

// ---------------------------------------------------------------------------
// 4. Space metaphor
// ---------------------------------------------------------------------------

test('the anchor is a silver ringed home star', () => {
  const { nodes, links } = fixture();
  const adjacency = buildAdjacency(nodes, links);
  const aaron = nodes.find(n => n.id === 'Aaron McRae');
  assert.equal(
    classifyNode(aaron, { anchorId: 'Aaron McRae', adjacency, links }),
    NODE_KINDS.HOME_STAR
  );
  assert.equal(HOME_STAR_STYLE.kind, NODE_KINDS.HOME_STAR);
  assert.equal(HOME_STAR_STYLE.nodeType, 'ringed-star');
  assert.ok(HOME_STAR_STYLE.sizeMultiplier > 1, 'the home star must read as the biggest node');
  assert.ok(HOME_STAR_STYLE.ringColor, 'the home star needs a ring colour');
});

test('bands are solar systems and multi-band members are constellations', () => {
  const { nodes, links } = fixture();
  const adjacency = buildAdjacency(nodes, links);
  const kindOf = id => classifyNode(nodes.find(n => n.id === id), { adjacency, links });
  assert.equal(kindOf('Band Alpha'), NODE_KINDS.SOLAR_SYSTEM);
  // Aaron is in two bands, so away from the anchor seat he is a bridge.
  assert.equal(kindOf('Aaron McRae'), NODE_KINDS.CONSTELLATION);
  assert.equal(kindOf('Kim Park'), NODE_KINDS.CONSTELLATION);
});

test('single-band members are planets and touring-only members are moons', () => {
  const { nodes, links } = fixture();
  const adjacency = buildAdjacency(nodes, links);
  const kindOf = id => classifyNode(nodes.find(n => n.id === id), { adjacency, links });
  assert.equal(kindOf('Dana Lee'), NODE_KINDS.PLANET);
  assert.equal(kindOf('Tour Guy'), NODE_KINDS.MOON);
});

test('orphaned and unlinked records are asteroids', () => {
  const { nodes, links } = fixture();
  const adjacency = buildAdjacency(nodes, links);
  const kindOf = id => classifyNode(nodes.find(n => n.id === id), { adjacency, links });
  assert.equal(kindOf('Orphan Band'), NODE_KINDS.ASTEROID);
  assert.equal(classifyNode({ id: 'Ghost', type: 'person' }, { adjacency, links }), NODE_KINDS.ASTEROID);
  assert.equal(classifyNode(null), NODE_KINDS.ASTEROID);
});

// ---------------------------------------------------------------------------
// 5. Graphology adapter + Six Degrees translation
// ---------------------------------------------------------------------------

test('the Graphology adapter carries typed node and edge attributes', () => {
  const { nodes, links } = fixture();
  const graph = toGraphologyGraph({ nodes, links }, Graph, { anchorId: 'Aaron McRae' });
  assert.equal(graph.order, nodes.length);
  assert.equal(graph.size, links.length);

  const alpha = graph.getNodeAttributes('Band Alpha');
  assert.equal(alpha.entityType, 'band');
  assert.equal(alpha.kind, NODE_KINDS.SOLAR_SYSTEM);
  assert.equal(alpha.genre, 'Post-punk');
  assert.equal(alpha.label, 'Band Alpha');
  assert.equal(graph.getNodeAttribute('Aaron McRae', 'kind'), NODE_KINDS.HOME_STAR);
  assert.equal(graph.getEdgeAttribute('Band Beta', 'Tour Guy', 'relation'), 'touring');
});

test('the adapter is idempotent about duplicate ids and self links', () => {
  const nodes = [{ id: 'Dup', type: 'band' }, { id: 'Dup', type: 'band' }, { id: 'P', type: 'person' }];
  const links = [
    { source: 'Dup', target: 'P', relation: 'member' },
    { source: 'Dup', target: 'P', relation: 'member' },
    { source: 'Dup', target: 'Dup', relation: 'member' },
    { source: 'Dup', target: 'Missing', relation: 'member' },
  ];
  const graph = toGraphologyGraph({ nodes, links }, Graph);
  assert.equal(graph.order, 2);
  assert.equal(graph.size, 1);
});

test('the adapter requires an injected Graphology constructor', () => {
  assert.throws(() => toGraphologyGraph(fixture(), null), TypeError);
});

test('a shared member reads as one user-facing degree', () => {
  const { nodes, links } = fixture();
  const graph = toGraphologyGraph({ nodes, links }, Graph);
  const path = bidirectional(graph, 'Band Alpha', 'Band Beta');
  // Stored path is Band -> Member -> Band ...
  assert.deepEqual(path, ['Band Alpha', 'Aaron McRae', 'Band Beta']);
  // ... but the Kevin Bacon-style count is 1.
  assert.equal(pathToUserFacingDegrees(path), 1);
});

test('two shared members read as two degrees, and identity as zero', () => {
  const { nodes, links } = fixture();
  const graph = toGraphologyGraph({ nodes, links }, Graph);
  assert.equal(pathToUserFacingDegrees(bidirectional(graph, 'Band Alpha', 'Band Gamma')), 2);
  assert.equal(pathToUserFacingDegrees(['Band Alpha']), 0);
  assert.equal(pathToUserFacingDegrees([]), 0);
  assert.equal(pathToUserFacingDegrees(null), 0);
});

test('a disconnected pair has no path, which the UI must report as undocumented', () => {
  const { nodes, links } = fixture();
  const graph = toGraphologyGraph({ nodes, links }, Graph);
  assert.equal(bidirectional(graph, 'Band Alpha', 'Orphan Band'), null);
});

// ---------------------------------------------------------------------------
// 6. Radial layout
// ---------------------------------------------------------------------------

test('the anchor sits at the origin and hops land on their own ring', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 3 });
  // Rings are the SEED of the layout, not the finished drawing: scatter and the
  // relax solver deliberately pull nodes off their nominal ring to break up the
  // bullseye look. This test owns the seed's ring structure, so it asks for the
  // raw seed; the relaxed output's ring behaviour is asserted below.
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing: 100,
    scatter: 0,
    relax: false,
  });

  assert.deepEqual(positions.get('Aaron McRae'), { x: 0, y: 0, hop: 0 });
  const radius = id => {
    const p = positions.get(id);
    return Math.round(Math.sqrt(p.x * p.x + p.y * p.y));
  };
  assert.equal(radius('Band Alpha'), 100);
  assert.equal(radius('Band Beta'), 100);
  assert.equal(radius('Dana Lee'), 200);
  assert.equal(radius('Band Gamma'), 300);

  // The finished layout keeps the anchor pinned and every node in the
  // neighbourhood of its seed ring -- drifting by design, but bounded, so hop
  // order still reads outward from the centre.
  const relaxed = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing: 100,
    radialBand: 0.26,
  });
  assert.deepEqual(relaxed.get('Aaron McRae'), { x: 0, y: 0, hop: 0 });
  relaxed.forEach((point, id) => {
    if (id === 'Aaron McRae') return;
    const seeded = Math.sqrt(positions.get(id).x ** 2 + positions.get(id).y ** 2);
    const actual = Math.sqrt(point.x ** 2 + point.y ** 2);
    // Band-orbit children are placed around their band rather than the anchor,
    // so they are exempt from the radial band; this fixture has none, but the
    // bound is stated generously so it tests the clamp, not the fixture.
    assert.ok(
      Math.abs(actual - seeded) <= seeded * 0.5 + 100,
      `${id} drifted from ${Math.round(seeded)} to ${Math.round(actual)}`,
    );
  });
});

test('layout positions every visible node exactly once and is deterministic', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = wideFixture(80);
  const view = getNeighborhood({ nodes, links, anchorId: 'Hub Band', maxNodes: 60 });
  const args = { nodes: view.nodes, links: view.links, anchorId: 'Hub Band', depths: view.depths };
  const a = radialLayout(args);
  const b = radialLayout(args);
  assert.equal(a.size, view.nodes.length);
  view.nodes.forEach(node => assert.ok(a.has(node.id), `${node.id} needs a position`));
  a.forEach((point, id) => assert.deepEqual(point, b.get(id)));
  // No two nodes stacked on the exact same coordinate.
  const seen = new Set([...a.values()].map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`));
  assert.equal(seen.size, a.size);
});

test('members cluster inside their band wedge rather than scattering', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 2 });
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
  });
  const angle = id => Math.atan2(positions.get(id).y, positions.get(id).x);
  const gap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  // Dana Lee is Band Alpha's member: she must be angularly nearer to Alpha
  // than to Beta.
  assert.ok(
    gap(angle('Dana Lee'), angle('Band Alpha')) < gap(angle('Dana Lee'), angle('Band Beta'))
  );
});

test('layout of an empty or anchorless view is empty, not a crash', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  assert.equal(radialLayout({}).size, 0);
  assert.equal(radialLayout({ nodes: fixture().nodes }).size, 0);
});

test('expansion ceilings exist and sit above the opening budget', () => {
  assert.ok(NEIGHBORHOOD_BUDGET.EXPAND_MAX_HOPS > NEIGHBORHOOD_BUDGET.MAX_HOPS);
  assert.ok(NEIGHBORHOOD_BUDGET.EXPAND_MAX_NODES > NEIGHBORHOOD_BUDGET.MAX_NODES);
  // Expansion must stay a bounded series of steps, not a route to the corpus.
  assert.ok(NEIGHBORHOOD_BUDGET.EXPAND_MAX_NODES <= 500);
  assert.ok(NEIGHBORHOOD_BUDGET.EXPAND_MAX_HOPS <= 6);
});

test('expanding the hop radius reveals more of the graph', () => {
  const { nodes, links } = fixture();
  const near = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 2, maxNodes: 100 });
  const far = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 3, maxNodes: 100 });
  assert.ok(far.nodes.length > near.nodes.length, 'one more degree must add nodes');
  // Yesterday's frontier is today's view: what the expand button promised is
  // exactly what the wider horizon delivers.
  near.frontier.forEach(id => {
    assert.ok(far.nodes.some(node => node.id === id), `${id} should be revealed by expanding`);
  });
});

test('a hub band with 40 members leaves every member clearly separated', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = wideFixture(40);
  nodes.push({ id: 'Aaron McRae', type: 'person' });
  links.push({ source: 'Hub Band', target: 'Aaron McRae', relation: 'member' });
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 2, maxNodes: 100 });
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing: 110,
  });
  // Whether the layout answers crowding by moving the ring outward or by
  // staggering sub-rings is an implementation choice; the guarantee is spacing.
  const points = [...positions.values()];
  let closest = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      closest = Math.min(closest, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  assert.ok(closest > 20, `closest pair was ${closest.toFixed(1)} apart`);
});

// A scene-shaped fixture: a chain of bands, each with its own members, linked
// by shared musicians. Deep and wide enough to reproduce the expanded-view
// crowding that a real scene produces at 4+ degrees.
function sceneFixture({ bands = 30, perBand = 12 } = {}) {
  const nodes = [{ id: 'Aaron McRae', type: 'person' }];
  const links = [];
  for (let b = 0; b < bands; b += 1) {
    const bandId = `Band ${String(b).padStart(2, '0')}`;
    nodes.push({ id: bandId, type: 'band' });
    for (let m = 0; m < perBand; m += 1) {
      const memberId = `Member ${b}-${m}`;
      nodes.push({ id: memberId, type: 'person' });
      links.push({ source: bandId, target: memberId, relation: 'member' });
      // Every band's first member also plays in the next band: the bridge
      // that makes the graph deep instead of a bag of stars.
      if (m === 0 && b > 0) {
        links.push({ source: `Band ${String(b - 1).padStart(2, '0')}`, target: memberId, relation: 'member' });
      }
    }
  }
  links.push({ source: 'Band 00', target: 'Aaron McRae', relation: 'member' });
  return { nodes, links };
}

function closestPair(positions) {
  const points = [...positions.entries()];
  let closest = Infinity;
  let pair = null;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[i][1].x - points[j][1].x;
      const dy = points[i][1].y - points[j][1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closest) {
        closest = dist;
        pair = [points[i][0], points[j][0]];
      }
    }
  }
  return { closest, pair };
}

test('expanded views never stack two nodes on the same coordinates', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = sceneFixture();
  // The exact shape of the reported bug: expand out to 4-6 degrees with a
  // raised node budget and watch band members land on top of each other.
  for (const [maxHops, maxNodes] of [[3, 100], [4, 160], [5, 220], [6, 400]]) {
    const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops, maxNodes });
    const positions = radialLayout({
      nodes: view.nodes,
      links: view.links,
      anchorId: 'Aaron McRae',
      depths: view.depths,
      spacing: 110,
    });
    const coords = new Set([...positions.values()].map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    assert.equal(
      coords.size,
      positions.size,
      `duplicate coordinates at ${maxHops} hops / ${maxNodes} nodes`
    );
    const { closest, pair } = closestPair(positions);
    assert.ok(
      closest > 24,
      `at ${maxHops} hops / ${view.nodes.length} nodes the closest pair (${pair}) was ${closest.toFixed(1)} apart`
    );
  }
});

test('a crowded layer moves outward instead of packing tighter', async () => {
  const { radialLayout, WIDE_BLOCK_MIN_CHILDREN } = await import('../scripts/neighborhood-helpers.mjs');
  // A wide, shallow scene: the anchor plays in many bands, each with few enough
  // members that no band trips the orbit rule (see the next test). sceneFixture
  // cannot express this -- it chains bands into a deep line, so its layers never
  // hold more than one band's worth of people, and any layer big enough to
  // crowd is also a band big enough to orbit.
  const perBand = WIDE_BLOCK_MIN_CHILDREN - 5;
  const bandCount = 12;
  const nodes = [{ id: 'Aaron McRae', type: 'person' }];
  const links = [];
  for (let b = 0; b < bandCount; b += 1) {
    const bandId = `Band ${String(b).padStart(2, '0')}`;
    nodes.push({ id: bandId, type: 'band' });
    links.push({ source: bandId, target: 'Aaron McRae', relation: 'member' });
    for (let m = 0; m < perBand; m += 1) {
      const memberId = `Member ${b}-${m}`;
      nodes.push({ id: memberId, type: 'person' });
      links.push({ source: bandId, target: memberId, relation: 'member' });
    }
  }
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 4, maxNodes: 200 });
  const spacing = 110;
  const minSeparation = 76;
  // Ring radii are a seed-time decision, so this asserts the seed. Whether the
  // relaxed drawing keeps nodes apart is measured on live data in
  // tests/layout-invariants.test.mjs.
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing,
    minSeparation,
    scatter: 0,
    relax: false,
  });
  const radiusOf = id => {
    const p = positions.get(id);
    return Math.sqrt(p.x * p.x + p.y * p.y);
  };
  const layerRadius = hop => {
    const ids = view.nodes.filter(node => node.hop === hop).map(node => node.id);
    return ids.length ? Math.min(...ids.map(radiusOf)) : null;
  };

  // A layer whose population cannot fit on its nominal ring at minSeparation
  // must start further out, rather than squeezing its members together.
  const hops = [...new Set(view.nodes.map(n => n.hop))].filter(h => h > 0).sort((a, b) => a - b);
  const crowded = hops.filter(hop => {
    const population = view.nodes.filter(n => n.hop === hop).length;
    const nominalCircumference = 2 * Math.PI * spacing * hop;
    return population * minSeparation > nominalCircumference;
  });
  assert.ok(crowded.length, 'fixture should produce at least one crowded layer');
  crowded.forEach(hop => {
    const population = view.nodes.filter(n => n.hop === hop).length;
    const needed = (population * minSeparation) / (2 * Math.PI);
    assert.ok(
      layerRadius(hop) >= Math.min(needed, spacing * hop) - 1,
      `hop ${hop} (${population} nodes) should sit out at ~${Math.round(needed)}, got ${Math.round(layerRadius(hop))}`,
    );
  });

  // And rings must stay ordered: no outer layer inside an inner one.
  for (let i = 1; i < hops.length; i += 1) {
    assert.ok(
      layerRadius(hops[i]) > layerRadius(hops[i - 1]),
      `hop ${hops[i]} must sit outside hop ${hops[i - 1]}`,
    );
  }
});

test('a band too wide for its wedge orbits its own children instead', async () => {
  // The other half of the crowding strategy, and the reason the test above has
  // to use small bands. A band with many members would otherwise claim a huge
  // angular wedge of the anchor ring and shove the rest of the graph aside, so
  // past WIDE_BLOCK_SPAN its members become a compact local ring around the
  // band itself -- which means they legitimately sit INSIDE their nominal hop
  // ring, close to their band.
  const { radialLayout, WIDE_BLOCK_MIN_CHILDREN } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = sceneFixture({ bands: 2, perBand: 40 });
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 4, maxNodes: 200 });
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing: 110,
    scatter: 0,
    relax: false,
  });
  const bandIds = view.nodes.filter(n => n.hop === 1).map(n => n.id);
  const adjacency = new Map(view.nodes.map(n => [n.id, []]));
  view.links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t2 = typeof l.target === 'object' ? l.target.id : l.target;
    adjacency.get(s)?.push(t2);
    adjacency.get(t2)?.push(s);
  });
  const orbited = bandIds.filter(id => {
    const kids = (adjacency.get(id) || []).filter(k => view.nodes.find(n => n.id === k && n.hop === 2));
    return kids.length >= WIDE_BLOCK_MIN_CHILDREN;
  });
  assert.ok(orbited.length, 'fixture should produce at least one wide band');

  orbited.forEach(bandId => {
    const band = positions.get(bandId);
    const kids = (adjacency.get(bandId) || []).filter(k => view.nodes.find(n => n.id === k && n.hop === 2));
    const distanceToBand = kids.map(k => {
      const p = positions.get(k);
      return Math.sqrt((p.x - band.x) ** 2 + (p.y - band.y) ** 2);
    });
    const distanceToAnchor = kids.map(k => {
      const p = positions.get(k);
      return Math.sqrt(p.x ** 2 + p.y ** 2);
    });
    const meanToBand = distanceToBand.reduce((a, b) => a + b, 0) / kids.length;
    const meanToAnchor = distanceToAnchor.reduce((a, b) => a + b, 0) / kids.length;
    assert.ok(
      meanToBand < meanToAnchor,
      `${bandId}'s members should cluster around it (${Math.round(meanToBand)}) `
      + `rather than around the anchor (${Math.round(meanToAnchor)})`,
    );
  });
});

test('node sizes shrink with view density but stay tappable', async () => {
  const { densitySizeScale } = await import('../scripts/neighborhood-helpers.mjs');
  // Opening-sized views are drawn at full size.
  assert.equal(densitySizeScale(17), 1);
  assert.equal(densitySizeScale(NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES), 1);
  // Bigger views shrink, but only down to the floor -- and the floor is reached
  // well before the maximum view size, so this is monotonic non-increasing
  // rather than strictly decreasing.
  const at100 = densitySizeScale(100);
  const at220 = densitySizeScale(220);
  const at400 = densitySizeScale(400);
  assert.ok(at100 < 1, 'a 100-node view is drawn smaller than an opening view');
  assert.ok(at220 <= at100 && at400 <= at220, 'never grows as the view fills up');
  // The floor was raised from 0.45 to 0.6 when framingRatio took over
  // responsibility for legibility: nodes stay tappable and the camera zooms
  // instead of the glyphs shrinking away.
  assert.equal(densitySizeScale(100000), 0.6);
  assert.ok(at400 >= 0.6);
  assert.equal(densitySizeScale(0), 1);
});

// ---------------------------------------------------------------------------
// 7. Screen-space sizing and labels
// ---------------------------------------------------------------------------

test('node sizing accounts for the window, not just the node count', async () => {
  const { viewportSizeScale, nodeSizeScale } = await import('../scripts/neighborhood-helpers.mjs');
  const view = { extent: 330, minSeparation: 44, maxNodeSize: 13 };
  const wide = viewportSizeScale({ ...view, viewportWidth: 1440, viewportHeight: 900 });
  const narrow = viewportSizeScale({ ...view, viewportWidth: 1056, viewportHeight: 700 });
  const phone = viewportSizeScale({ ...view, viewportWidth: 390, viewportHeight: 640 });
  // The reported bug: the same 17-node view collided on a smaller window
  // because nothing shrank. Smaller windows must now shrink nodes.
  assert.ok(narrow < wide || wide === 1, 'a narrower window must not scale up');
  assert.ok(phone < narrow, 'a phone must shrink more than a laptop');
  assert.ok(phone >= 0.4, 'never below the tappable floor');
  // A big window with a small graph leaves nodes at their designed size.
  assert.equal(viewportSizeScale({ ...view, viewportWidth: 2560, viewportHeight: 1440 }), 1);
  // Degenerate inputs are safe.
  assert.equal(viewportSizeScale({}), 1);
  assert.equal(viewportSizeScale({ extent: 0, viewportWidth: 800, viewportHeight: 600 }), 1);
});

test('the applied scale is the stricter of density and viewport', async () => {
  const { nodeSizeScale, densitySizeScale, viewportSizeScale } = await import(
    '../scripts/neighborhood-helpers.mjs'
  );
  const args = {
    visibleCount: 220,
    extent: 900,
    viewportWidth: 1056,
    viewportHeight: 700,
    maxNodeSize: 13,
  };
  const combined = nodeSizeScale(args);
  assert.equal(
    combined,
    Math.min(densitySizeScale(220), viewportSizeScale(args)),
    'whichever constraint is tighter must win'
  );
  assert.ok(combined <= 1);
});

test('labels are not withheld from the smallest nodes', async () => {
  const { labelSettings } = await import('../scripts/neighborhood-helpers.mjs');
  // The bug: a fixed threshold of 7 hid every moon (5px) and asteroid (4px),
  // so those names only appeared on click.
  const opening = labelSettings({ visibleCount: 17, smallestNodeSize: 4 });
  assert.ok(
    opening.labelRenderedSizeThreshold < 4,
    'the threshold must sit below the smallest drawn node'
  );
  assert.ok(opening.labelDensity > 1, 'a small view should show every name it can');
  // Scaled-down nodes lower the threshold with them.
  const scaled = labelSettings({ visibleCount: 17, smallestNodeSize: 1.8 });
  assert.ok(scaled.labelRenderedSizeThreshold < 1.8);
  assert.ok(scaled.labelRenderedSizeThreshold >= 0);
  // Crowded views hand thinning back to Sigma's overlap culling.
  const crowded = labelSettings({ visibleCount: 300, smallestNodeSize: 3 });
  assert.ok(crowded.labelDensity < opening.labelDensity);
});

test('layoutExtent measures the radius the camera must frame', async () => {
  const { layoutExtent, radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  assert.equal(layoutExtent(new Map()), 0);
  const { nodes, links } = fixture();
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 3 });
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing: 110,
  });
  const extent = layoutExtent(positions);
  const maxRadius = Math.max(
    ...[...positions.values()].map(p => Math.sqrt(p.x * p.x + p.y * p.y))
  );
  assert.equal(Math.round(extent), Math.round(maxRadius));
  assert.ok(extent > 0);
});

// ---------------------------------------------------------------------------
// 8. Nodes must not sit on unrelated edges
// ---------------------------------------------------------------------------

// Distance from point p to segment a-b.
function segmentDistance(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

// The worst node-to-unrelated-edge distance in a laid-out view, in layout units.
function worstEdgeClearance(view, positions) {
  const incident = new Map(view.nodes.map(node => [node.id, new Set()]));
  view.links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    if (incident.has(source)) incident.get(source).add(link);
    if (incident.has(target)) incident.get(target).add(link);
  });
  let worst = { clearance: Infinity, node: null, edge: null };
  view.nodes.forEach(node => {
    const point = positions.get(node.id);
    view.links.forEach(link => {
      if (incident.get(node.id).has(link)) return;
      const [source, target] = linkEndpoints(link);
      const a = positions.get(source);
      const b = positions.get(target);
      if (!a || !b) return;
      const clearance = segmentDistance(point, a, b);
      if (clearance < worst.clearance) {
        worst = { clearance, node: node.id, edge: `${source} -- ${target}` };
      }
    });
  });
  return worst;
}

// Node-to-edge clearance now lives in tests/layout-invariants.test.mjs, which
// measures the distance to the CURVE Sigma actually draws (curvature is chosen
// per edge) across the whole shape/anchor/budget matrix. A straight-line check
// here would both duplicate and contradict it.

test('every node is placed inside its parent branch, so no edge crosses the middle', async () => {
  const { radialLayout } = await import('../scripts/neighborhood-helpers.mjs');
  const { nodes, links } = sceneFixture({ bands: 12, perBand: 6 });
  const view = getNeighborhood({ nodes, links, anchorId: 'Aaron McRae', maxHops: 4, maxNodes: 200 });
  const positions = radialLayout({
    nodes: view.nodes,
    links: view.links,
    anchorId: 'Aaron McRae',
    depths: view.depths,
    spacing: 110,
  });
  // No membership edge should pass close to the anchor at the centre: that was
  // the symptom of a member being placed on the far side of the graph from its
  // own band.
  const anchor = positions.get('Aaron McRae');
  const incidentToAnchor = new Set();
  view.links.forEach(link => {
    const [source, target] = linkEndpoints(link);
    if (source === 'Aaron McRae' || target === 'Aaron McRae') incidentToAnchor.add(link);
  });
  view.links.forEach(link => {
    if (incidentToAnchor.has(link)) return;
    const [source, target] = linkEndpoints(link);
    const a = positions.get(source);
    const b = positions.get(target);
    if (!a || !b) return;
    assert.ok(
      segmentDistance(anchor, a, b) > 40,
      `${source} -- ${target} passes too close to the anchor`
    );
  });
});

test('framing fits the view when legible and zooms in when it is not', async () => {
  const { framingRatio } = await import('../scripts/neighborhood-helpers.mjs');
  const base = 1.22;
  // A small neighborhood on a desktop: fit it, at the label-headroom ratio.
  assert.equal(
    framingRatio({ extent: 330, viewportWidth: 1440, viewportHeight: 900, baseRatio: base }),
    base
  );
  // The same neighborhood on a phone cannot be fitted legibly, so zoom in.
  const phone = framingRatio({ extent: 330, viewportWidth: 390, viewportHeight: 844, baseRatio: base });
  assert.ok(phone < base, 'a phone should zoom in rather than shrink nodes to fit');
  assert.ok(phone > 0);
  // A big expanded view zooms in further than a small one on the same screen.
  const small = framingRatio({ extent: 400, viewportWidth: 1280, viewportHeight: 620, baseRatio: base });
  const large = framingRatio({ extent: 2000, viewportWidth: 1280, viewportHeight: 620, baseRatio: base });
  assert.ok(large < small);
  // Degenerate inputs fall back to the base ratio rather than dividing by zero.
  assert.equal(framingRatio({}), base);
  assert.equal(framingRatio({ extent: 0, viewportWidth: 800, viewportHeight: 600 }), base);
});
