// ---------------------------------------------------------------------------
// Sigma.js neighborhood explorer — browser renderer (issue #80).
//
// This is the Sigma/WebGL rendering path for the band tree. It is OFF by
// default: the page keeps shipping the SVG renderer until this one reaches
// interaction and performance parity. Opt in with ?renderer=sigma
// (see rendererFromSearch / DEFAULT_RENDERER in neighborhood-helpers.mjs).
//
// What it renders: a capped local neighborhood, not the whole tree.
//   - Home/direct visits anchor on Aaron McRae, drawn as a silver ringed
//     star ("you are here").
//   - A shared/deep link (?band=, ?member=, ?node=) overrides that anchor.
//   - Breadth-first traversal outward until the visible-node budget is hit
//     (~60 opening, 100 expanded), with the unrendered frontier surfaced as
//     an explicit "Expand this constellation" action so nobody mistakes the
//     opening view for the entire universe.
//   - Layout is the deterministic radial layout from neighborhood-helpers:
//     no force simulation on load, identical coordinates for everybody who
//     opens the same link.
//
// Interaction contract carried over from the SVG renderer (do not regress):
//   - Click a band   -> electric blue (#27b8ff) glow on its members + edges.
//   - Click a member -> amber/gold (#ffb454) glow on their bands + edges.
//   - Click empty space -> clear the selection.
//   - Pan (drag), zoom (wheel/pinch), tap to select. 2.5D only: NO camera
//     rotation, NO orbit, NO CAD-style pilot mode. Depth comes from scale,
//     glow, halo and fog, not from a third axis.
//
// Deps come from the CDN as ES modules, mirroring how the page already loads
// d3 from a CDN script tag; package.json pins the same major versions so the
// test suite and the browser agree.
// ---------------------------------------------------------------------------

import Graph from 'https://esm.sh/graphology@0.26.0';
import Sigma from 'https://esm.sh/sigma@3.0.3';

import {
  rendererFromSearch,
  resolveAnchor,
  getNeighborhood,
  buildAdjacency,
  radialLayout,
  classifyNode,
  toGraphologyGraph,
  NEIGHBORHOOD_BUDGET,
  NODE_KINDS,
  HOME_STAR_STYLE,
  linkEndpoints,
  normalizeAnchorKey,
  densitySizeScale,
} from './neighborhood-helpers.mjs';

// ---------------------------------------------------------------------------
// Visual language
// ---------------------------------------------------------------------------

// Highlight hues are copied from the SVG renderer's CSS (.band-highlight /
// .member-highlight in index.html) so the two renderers cannot drift apart.
export const BAND_HIGHLIGHT_COLOR = '#27b8ff';   // electric blue
export const MEMBER_HIGHLIGHT_COLOR = '#ffb454'; // amber / gold

const KIND_STYLE = {
  [NODE_KINDS.HOME_STAR]: { color: HOME_STAR_STYLE.color, size: 22 },
  [NODE_KINDS.SOLAR_SYSTEM]: { color: '#8fe8f6', size: 13 },
  [NODE_KINDS.CONSTELLATION]: { color: '#c9b6ff', size: 10 },
  [NODE_KINDS.PLANET]: { color: '#9fb8cc', size: 7 },
  [NODE_KINDS.MOON]: { color: '#7d8ea0', size: 5 },
  [NODE_KINDS.ASTEROID]: { color: '#5c6472', size: 4 },
};

const EDGE_COLOR = 'rgba(150,170,190,0.22)';
const DIM_NODE_COLOR = 'rgba(120,134,150,0.35)';
const STAGE_ID = 'sigma-stage';

const EXPLORE_COPY = 'You are viewing one region of a much larger music universe.';

// ---------------------------------------------------------------------------
// Stage chrome
// ---------------------------------------------------------------------------

const STAGE_CSS = `
#${STAGE_ID}{position:absolute;inset:0;overflow:hidden}
#${STAGE_ID}[hidden]{display:none}
#${STAGE_ID} .sigma-canvas-host{position:absolute;inset:0}
/* Parallax starfield: the 2.5D depth cue that replaces literal 3D. Two
   static radial-gradient layers at different scales read as near and far
   stars; the camera-driven translate in updateParallax() separates them. */
#${STAGE_ID} .sigma-starfield{position:absolute;inset:-15%;pointer-events:none;
  background-image:
    radial-gradient(1.5px 1.5px at 20% 30%, rgba(255,255,255,0.55) 50%, transparent 51%),
    radial-gradient(1px 1px at 70% 20%, rgba(255,255,255,0.4) 50%, transparent 51%),
    radial-gradient(1px 1px at 45% 75%, rgba(255,255,255,0.35) 50%, transparent 51%),
    radial-gradient(2px 2px at 85% 60%, rgba(255,255,255,0.3) 50%, transparent 51%);
  background-size:340px 340px,220px 220px,180px 180px,420px 420px;
  will-change:transform}
/* Fog: fades the edge of the rendered region so the graph looks like it
   continues past the viewport instead of stopping at a hard boundary. */
#${STAGE_ID} .sigma-fog{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(circle at center, transparent 52%, rgba(8,11,17,0.72) 100%)}
/* The silver ringed home star. Drawn as a DOM overlay tracking the anchor's
   viewport position rather than a custom WebGL program: one node, no shader
   maintenance, and it can carry a text label. */
#${STAGE_ID} .sigma-home-star{position:absolute;pointer-events:none;transform:translate(-50%,-50%);
  width:76px;height:76px;display:flex;align-items:center;justify-content:center}
/* The hidden attribute must win over the display rules above and below.
   Without this, a view that Aaron is not part of still painted his star over
   whatever sat at the centre of the screen -- a phantom "you are here". */
#${STAGE_ID} .sigma-home-star[hidden],
#${STAGE_ID} .sigma-focus-ring[hidden]{display:none}
#${STAGE_ID} .sigma-home-star::before{content:'';position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle, ${HOME_STAR_STYLE.haloColor} 0%, transparent 68%)}
#${STAGE_ID} .sigma-home-star .ring{position:absolute;left:0;right:0;top:50%;height:26px;
  margin-top:-13px;border:1.6px solid ${HOME_STAR_STYLE.ringColor};border-radius:50%;
  transform:rotate(${HOME_STAR_STYLE.ringTiltDeg}deg);box-shadow:0 0 10px rgba(159,176,196,0.45)}
#${STAGE_ID} .sigma-home-star .core{position:relative;width:16px;height:16px;border-radius:50%;
  background:${HOME_STAR_STYLE.color};box-shadow:0 0 18px 4px rgba(223,230,239,0.65)}
#${STAGE_ID} .sigma-home-star .home-label{position:absolute;top:100%;margin-top:6px;white-space:nowrap;
  font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#c8d3e0;opacity:0.85}
/* Focus ring: where the camera currently sits when that is NOT Aaron. A thin
   cyan ring, deliberately quieter than the silver ringed star so the home
   star keeps its unique identity in the universe. */
#${STAGE_ID} .sigma-focus-ring{position:absolute;pointer-events:none;transform:translate(-50%,-50%);
  width:58px;height:58px}
#${STAGE_ID} .sigma-focus-ring .ring{position:absolute;inset:0;border-radius:50%;
  border:1.4px solid rgba(143,232,246,0.75);box-shadow:0 0 14px rgba(143,232,246,0.35)}
/* When the home star and the current focus are near each other, the two
   labels would print on top of each other; positionOverlays() flips the home
   label above its star to keep both readable. */
#${STAGE_ID} .sigma-home-star.label-above .home-label{top:auto;bottom:100%;margin-top:0;margin-bottom:8px}
#${STAGE_ID} .sigma-focus-ring .focus-label{position:absolute;top:100%;left:50%;transform:translateX(-50%);
  margin-top:6px;white-space:nowrap;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;
  color:#a8d7e0;opacity:0.85}
#${STAGE_ID} .sigma-prompt{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);
  width:min(460px,86vw);display:flex;flex-direction:column;gap:6px;z-index:4}
#${STAGE_ID} .sigma-prompt form{display:flex;gap:8px}
#${STAGE_ID} .sigma-prompt input{flex:1;min-width:0;padding:11px 14px;border-radius:999px;
  border:1px solid rgba(143,232,246,0.34);background:rgba(10,14,20,0.82);color:#e8eef6;
  font-size:15px;backdrop-filter:blur(6px)}
#${STAGE_ID} .sigma-prompt input::placeholder{color:#8b98a8}
#${STAGE_ID} .sigma-prompt button{padding:11px 16px;border-radius:999px;border:1px solid rgba(143,232,246,0.34);
  background:rgba(143,232,246,0.14);color:#d7f2f8;font-size:14px;cursor:pointer}
#${STAGE_ID} .sigma-prompt .sigma-hint{text-align:center;font-size:12px;color:#8b98a8}
#${STAGE_ID} .sigma-expand{position:absolute;right:18px;bottom:26px;z-index:4;display:flex;
  flex-direction:column;align-items:flex-end;gap:6px}
#${STAGE_ID} .sigma-expand button{padding:9px 14px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(201,182,255,0.4);background:rgba(201,182,255,0.14);color:#e4dbff;font-size:13px}
#${STAGE_ID} .sigma-expand .sigma-frontier{font-size:11px;color:#8b98a8}
#${STAGE_ID} .sigma-context{position:absolute;left:18px;top:18px;z-index:4;font-size:12px;
  color:#9aa7b6;max-width:min(320px,60vw);line-height:1.45}
#${STAGE_ID} .sigma-context strong{color:#dfe6ef;font-weight:500}
@media (max-width:720px){
  #${STAGE_ID} .sigma-prompt{bottom:78px;width:min(92vw,460px)}
  #${STAGE_ID} .sigma-expand{right:12px;bottom:20px}
  #${STAGE_ID} .sigma-context{font-size:11px;max-width:70vw}
}
`;

function injectStyles(doc) {
  if (doc.getElementById('sigma-explorer-styles')) return;
  const style = doc.createElement('style');
  style.id = 'sigma-explorer-styles';
  style.textContent = STAGE_CSS;
  doc.head.appendChild(style);
}

function buildStage(doc, mount) {
  let stage = doc.getElementById(STAGE_ID);
  if (!stage) {
    stage = doc.createElement('div');
    stage.id = STAGE_ID;
    mount.appendChild(stage);
  }
  stage.innerHTML = `
    <div class="sigma-starfield" aria-hidden="true"></div>
    <div class="sigma-canvas-host"></div>
    <div class="sigma-fog" aria-hidden="true"></div>
    <div class="sigma-home-star" hidden><span class="ring"></span><span class="core"></span><span class="home-label"></span></div>
    <div class="sigma-focus-ring" hidden><span class="ring"></span><span class="focus-label"></span></div>
    <p class="sigma-context" aria-live="polite"></p>
    <div class="sigma-prompt">
      <form autocomplete="off">
        <input type="search" name="favorite-band" placeholder="Who&rsquo;s your favorite band?"
               aria-label="Search any band or artist to open their corner of the music universe"
               list="sigma-search-options" />
        <button type="submit">Explore</button>
      </form>
      <datalist id="sigma-search-options"></datalist>
      <p class="sigma-hint">${EXPLORE_COPY}</p>
    </div>
    <div class="sigma-expand">
      <button type="button" data-action="expand">Expand this constellation</button>
      <span class="sigma-frontier"></span>
    </div>
  `;
  stage.hidden = false;
  return stage;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Boots the Sigma explorer over a master graph ({ nodes, links }).
 *
 * `mount` defaults to .graph-stage. The SVG renderer's <svg> is hidden while
 * the Sigma path owns the stage, and restored if this controller is killed —
 * the feature flag has to be reversible in a live tab.
 */
export function initSigmaExplorer({
  master,
  mount = null,
  doc = typeof document !== 'undefined' ? document : null,
  search = typeof window !== 'undefined' ? window.location.search : '',
  SigmaConstructor = Sigma,
  GraphConstructor = Graph,
} = {}) {
  if (!doc || !master || !Array.isArray(master.nodes) || !master.nodes.length) return null;

  const host = mount || doc.querySelector('.graph-stage');
  if (!host) return null;

  injectStyles(doc);
  const stage = buildStage(doc, host);
  const canvasHost = stage.querySelector('.sigma-canvas-host');
  const starfield = stage.querySelector('.sigma-starfield');
  const homeStarEl = stage.querySelector('.sigma-home-star');
  const focusRingEl = stage.querySelector('.sigma-focus-ring');
  const contextEl = stage.querySelector('.sigma-context');
  const frontierEl = stage.querySelector('.sigma-frontier');
  const expandBtn = stage.querySelector('[data-action="expand"]');
  const form = stage.querySelector('.sigma-prompt form');
  const input = stage.querySelector('.sigma-prompt input');
  const datalist = stage.querySelector('#sigma-search-options');

  const svg = doc.getElementById('graph-svg');
  const svgDisplayBefore = svg ? svg.style.display : null;
  if (svg) svg.style.display = 'none';

  const adjacency = buildAdjacency(master.nodes, master.links);
  const masterById = new Map(master.nodes.map(node => [node.id, node]));

  // The silver ringed star belongs to ONE musician -- the project's default
  // anchor -- not to "wherever the camera happens to be". Someone who lands on
  // a shared Mudhoney link and then wanders into Aaron's corner should still
  // see him as the distinctive star. The current focus gets a quieter cyan
  // focus ring instead (see positionOverlays).
  const homeStarNode = master.nodes.find(
    node => normalizeAnchorKey(node.id) === normalizeAnchorKey(NEIGHBORHOOD_BUDGET.DEFAULT_ANCHOR)
  );
  const homeStarId = homeStarNode ? homeStarNode.id : null;

  // Canonical Graphology graph for the whole data set. Sigma only ever gets
  // the capped view graph; this one backs traversal, expansion and (next
  // milestone) Six Degrees shortest paths.
  const canonical = toGraphologyGraph(master, GraphConstructor);

  const state = {
    anchorId: null,
    anchorSource: 'none',
    maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
    maxHops: NEIGHBORHOOD_BUDGET.MAX_HOPS,
    view: null,
    selection: null,          // { id, type }
    highlightNodes: new Set(),
    highlightEdges: new Set(),
    highlightColor: null,
    // Sigma node sizes are in screen pixels while the camera fits the whole
    // view, so a 200-node neighborhood draws the same size dots at a much
    // tighter spacing than a 40-node one. Scaling size with density keeps the
    // gaps between nodes readable as views grow.
    sizeScale: 1,
  };

  const viewGraph = new GraphConstructor({ type: 'undirected', multi: false, allowSelfLoops: false });

  const renderer = new SigmaConstructor(viewGraph, canvasHost, {
    // 2.5D contract: pan and zoom only. Sigma's camera rotation stays off.
    enableCameraRotation: false,
    minCameraRatio: 0.08,
    maxCameraRatio: 4,
    labelFont: 'Satoshi, system-ui, sans-serif',
    labelColor: { color: '#c8d3e0' },
    labelDensity: 0.45,
    labelGridCellSize: 90,
    labelRenderedSizeThreshold: 7,
    defaultEdgeColor: EDGE_COLOR,
    hideEdgesOnMove: true,
    hideLabelsOnMove: true,
    nodeReducer: (id, attrs) => reduceNode(id, attrs),
    edgeReducer: (edge, attrs) => reduceEdge(edge, attrs),
  });

  // -- reducers -------------------------------------------------------------

  function reduceNode(id, attrs) {
    const style = KIND_STYLE[attrs.kind] || KIND_STYLE[NODE_KINDS.PLANET];
    const res = {
      ...attrs,
      size: (attrs.size || style.size) * state.sizeScale,
      color: style.color,
    };
    // The anchor's visual identity is the DOM ringed star overlay; the WebGL
    // node underneath is kept tiny and label-free so they don't fight.
    if (attrs.kind === NODE_KINDS.HOME_STAR) {
      res.size = 6;
      res.color = HOME_STAR_STYLE.color;
      res.label = '';
      return res;
    }
    if (state.highlightNodes.size) {
      if (state.highlightNodes.has(id) || id === (state.selection && state.selection.id)) {
        res.color = state.highlightColor;
        res.size = res.size * 1.25;
        res.zIndex = 2;
      } else {
        res.color = DIM_NODE_COLOR;
        res.label = '';
      }
    }
    return res;
  }

  function reduceEdge(edge, attrs) {
    if (!state.highlightEdges.size) return { ...attrs, color: EDGE_COLOR };
    return state.highlightEdges.has(edge)
      ? { ...attrs, color: state.highlightColor, size: 2.2, zIndex: 1 }
      : { ...attrs, color: 'rgba(120,134,150,0.08)' };
  }

  // -- view assembly --------------------------------------------------------

  function renderNeighborhood({ anchorId, maxNodes = state.maxNodes, animate = true }) {
    const view = getNeighborhood({
      nodes: master.nodes,
      links: master.links,
      anchorId,
      maxHops: state.maxHops,
      maxNodes,
      adjacency,
    });
    if (!view.nodes.length) return false;

    const positions = radialLayout({
      nodes: view.nodes,
      links: view.links,
      anchorId,
      depths: view.depths,
      spacing: 110,
      adjacency,
    });

    viewGraph.clear();
    view.nodes.forEach(node => {
      const point = positions.get(node.id) || { x: 0, y: 0, hop: node.hop || 0 };
      const kind =
        node.id === homeStarId
          ? NODE_KINDS.HOME_STAR
          : classifyNode(masterById.get(node.id) || node, { adjacency, links: master.links });
      const style = KIND_STYLE[kind] || KIND_STYLE[NODE_KINDS.PLANET];
      viewGraph.addNode(node.id, {
        label: node.id,
        x: point.x,
        y: point.y,
        hop: point.hop,
        kind,
        entityType: node.type,
        size: style.size,
        color: style.color,
      });
    });
    view.links.forEach(link => {
      const [source, target] = linkEndpoints(link);
      if (!viewGraph.hasNode(source) || !viewGraph.hasNode(target)) return;
      if (viewGraph.hasEdge(source, target)) return;
      viewGraph.addEdge(source, target, { size: 1, relation: link.relation || 'member' });
    });

    state.sizeScale = densitySizeScale(view.nodes.length);
    state.anchorId = anchorId;
    state.view = view;
    state.maxNodes = maxNodes;
    clearHighlight();
    updateChrome();
    // First paint / expansion: let Sigma's default camera frame the whole
    // capped view, which is exactly what we want when the view changes size.
    // Search and double-click travel instead: a short animated warp that
    // lands centered on the new anchor.
    if (animate) {
      flyTo(anchorId, { animate: true, ratio: 0.7 });
    } else {
      renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
      positionOverlays();
    }
    return true;
  }

  function updateChrome() {
    const view = state.view;
    const anchor = masterById.get(state.anchorId);
    const kindWord = anchor && anchor.type === 'band' ? 'band' : 'musician';
    contextEl.innerHTML = `Centered on <strong>${escapeHtml(state.anchorId)}</strong> — ` +
      `${view.nodes.length} of ${master.nodes.length} nodes in view, ` +
      `${state.maxHops} degrees out from this ${kindWord}.`;

    const remaining = view.frontier.length;
    frontierEl.textContent = remaining
      ? `${remaining} connected ${remaining === 1 ? 'node' : 'nodes'} just beyond this view`
      : 'Every connection in this region is on screen';
    expandBtn.hidden = !remaining;

    const homeLabel = homeStarEl.querySelector('.home-label');
    if (homeLabel && homeStarId) {
      homeLabel.textContent =
        homeStarId === state.anchorId ? `${homeStarId} — you are here` : homeStarId;
    }
    const focusLabel = focusRingEl.querySelector('.focus-label');
    if (focusLabel) focusLabel.textContent = state.anchorId === homeStarId ? '' : state.anchorId;
    positionOverlays();

    // Search suggestions: the frontier first (the natural next step), then a
    // slice of the whole corpus. Never the entire 50K list.
    const suggestions = [...view.frontier.slice(0, 40), ...master.nodes.slice(0, 200).map(n => n.id)];
    datalist.innerHTML = Array.from(new Set(suggestions))
      .map(id => `<option value="${escapeHtml(id)}"></option>`)
      .join('');
  }

  // -- camera ---------------------------------------------------------------

  // "Warp": a single animated camera move to the target. This is the RPG-ish
  // travel feel, achieved with 2D camera state only.
  function flyTo(id, { animate = true, ratio = null } = {}) {
    if (!viewGraph.hasNode(id)) return;
    const camera = renderer.getCamera();
    // Sigma normalizes graph coordinates into its own framed space, so a
    // node's display data is already in camera coordinates: centering on it
    // is just copying x/y across. Refresh first so a node added moments ago
    // has display data to read.
    renderer.refresh();
    const display = renderer.getNodeDisplayData(id);
    if (!display) return;
    const next = {
      x: display.x,
      y: display.y,
      ratio: ratio || camera.getState().ratio || 1,
      angle: 0,
    };
    if (animate && typeof camera.animate === 'function') {
      camera.animate(next, { duration: 520 }, positionOverlays);
    } else {
      camera.setState(next);
    }
    positionOverlays();
  }

  // Keeps the two DOM overlays glued to their WebGL nodes. Called from
  // afterRender, so it runs with the camera in its final state for the frame.
  function positionOverlays() {
    const ratio = renderer.getCamera().getState().ratio || 1;
    const place = (el, id, scale) => {
      if (!id || !viewGraph.hasNode(id)) {
        el.hidden = true;
        return;
      }
      const point = renderer.graphToViewport({
        x: viewGraph.getNodeAttribute(id, 'x'),
        y: viewGraph.getNodeAttribute(id, 'y'),
      });
      el.hidden = false;
      el.style.left = `${point.x}px`;
      el.style.top = `${point.y}px`;
      el.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(3)})`;
    };
    const zoomScale = Math.max(0.55, Math.min(1.9, 1 / ratio));
    place(homeStarEl, homeStarId, zoomScale * HOME_STAR_STYLE.sizeMultiplier * 0.5);
    place(focusRingEl, state.anchorId === homeStarId ? null : state.anchorId, zoomScale);

    // Aaron is often one hop from whatever a visitor searched for, which put
    // "AARON MCRAE" and the focus label on top of each other. Flip the home
    // label above its star when the two overlays are close.
    const crowded =
      !homeStarEl.hidden &&
      !focusRingEl.hidden &&
      Math.hypot(
        parseFloat(homeStarEl.style.left) - parseFloat(focusRingEl.style.left),
        parseFloat(homeStarEl.style.top) - parseFloat(focusRingEl.style.top)
      ) < 120;
    homeStarEl.classList.toggle('label-above', crowded);
  }

  function updateParallax() {
    const camera = renderer.getCamera().getState();
    const drift = 40;
    starfield.style.transform =
      `translate(${(-camera.x * drift).toFixed(1)}px, ${(-camera.y * drift).toFixed(1)}px)`;
  }

  // -- selection / highlighting --------------------------------------------

  function clearHighlight() {
    state.selection = null;
    state.highlightNodes = new Set();
    state.highlightEdges = new Set();
    state.highlightColor = null;
    renderer.refresh();
  }

  function highlightFrom(id) {
    if (!viewGraph.hasNode(id)) return;
    const entityType = viewGraph.getNodeAttribute(id, 'entityType');
    // Band click -> its members in electric blue.
    // Member click -> their bands in gold. Same contract as the SVG renderer.
    state.highlightColor = entityType === 'band' ? BAND_HIGHLIGHT_COLOR : MEMBER_HIGHLIGHT_COLOR;
    state.selection = { id, type: entityType };
    state.highlightNodes = new Set([id]);
    state.highlightEdges = new Set();
    viewGraph.forEachNeighbor(id, neighbor => state.highlightNodes.add(neighbor));
    viewGraph.forEachEdge(id, edge => state.highlightEdges.add(edge));
    renderer.refresh();
    // Let the page's existing card/panel code react without this module
    // reaching into it.
    stage.dispatchEvent(
      new CustomEvent('rbft:sigma-select', { bubbles: true, detail: { id, type: entityType } })
    );
  }

  function exploreFor(rawQuery) {
    const query = normalizeAnchorKey(rawQuery);
    if (!query) return { ok: false, reason: 'empty' };
    const exact = master.nodes.find(node => normalizeAnchorKey(node.id) === query);
    const partial = exact || master.nodes.find(node => normalizeAnchorKey(node.id).includes(query));
    if (!partial) {
      contextEl.innerHTML =
        `We have not mapped <strong>${escapeHtml(rawQuery)}</strong> yet. ` +
        `Add it to the universe from the Add-band flow.`;
      stage.dispatchEvent(
        new CustomEvent('rbft:sigma-search-miss', { bubbles: true, detail: { query: rawQuery } })
      );
      return { ok: false, reason: 'not-found' };
    }
    state.anchorSource = 'requested';
    // A new anchor starts from the standard horizon: expansions belong to the
    // view they were performed in, not to every later destination.
    state.maxHops = NEIGHBORHOOD_BUDGET.MAX_HOPS;
    renderNeighborhood({ anchorId: partial.id, maxNodes: NEIGHBORHOOD_BUDGET.MAX_NODES });
    return { ok: true, anchorId: partial.id };
  }

  function expand() {
    // The deliberate "explore beyond this view" step. Raising the node budget
    // alone does nothing once a view has exhausted its hop radius, so this
    // pushes the horizon out one degree AND raises the budget -- both capped,
    // so expanding stays a series of readable steps rather than an escape
    // hatch to the whole 50K corpus.
    const nextHops = Math.min(state.maxHops + 1, NEIGHBORHOOD_BUDGET.EXPAND_MAX_HOPS);
    const nextNodes = Math.min(
      state.maxNodes + NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
      NEIGHBORHOOD_BUDGET.EXPAND_MAX_NODES
    );
    if (nextHops === state.maxHops && nextNodes === state.maxNodes) return;
    state.maxHops = nextHops;
    renderNeighborhood({ anchorId: state.anchorId, maxNodes: nextNodes, animate: false });
  }

  // -- wiring ---------------------------------------------------------------

  renderer.on('clickNode', ({ node }) => highlightFrom(node));
  renderer.on('doubleClickNode', ({ node }) => {
    state.anchorSource = 'requested';
    state.maxHops = NEIGHBORHOOD_BUDGET.MAX_HOPS;
    renderNeighborhood({ anchorId: node, maxNodes: NEIGHBORHOOD_BUDGET.MAX_NODES });
  });
  renderer.on('clickStage', () => clearHighlight());
  // afterRender fires once per painted frame, with the camera in its final
  // state for that frame -- the only place the DOM home-star overlay can be
  // kept exactly on top of its WebGL node during pans, zooms and animated
  // camera flights.
  renderer.on('afterRender', () => {
    positionOverlays();
    updateParallax();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    exploreFor(input.value);
  });
  expandBtn.addEventListener('click', expand);

  // -- first paint ----------------------------------------------------------

  const resolved = resolveAnchor({ search, nodes: master.nodes, links: master.links, adjacency });
  state.anchorSource = resolved.source;
  if (!resolved.anchorId) return null;
  renderNeighborhood({
    anchorId: resolved.anchorId,
    maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
    animate: false,
  });

  return {
    stage,
    renderer,
    canonical,
    state,
    exploreFor,
    expand,
    flyTo,
    highlightFrom,
    clearHighlight,
    destroy() {
      renderer.kill();
      stage.remove();
      if (svg) svg.style.display = svgDisplayBefore || '';
    },
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Auto-boot behind the feature flag
// ---------------------------------------------------------------------------

// index.html publishes its master graph on window and fires
// 'rbft:graph-ready' once /api/bands (or the CSV fallback) has been adapted by
// buildMasterGraph(). We wait for that instead of re-fetching, so both
// renderers always show the same data.
export function bootFromPage(win = typeof window !== 'undefined' ? window : null) {
  if (!win || rendererFromSearch(win.location.search) !== 'sigma') return;
  const start = () => {
    const master = win.RBFT_MASTER_GRAPH;
    if (!master) return false;
    win.RBFT_SIGMA = initSigmaExplorer({ master, search: win.location.search });
    return Boolean(win.RBFT_SIGMA);
  };
  if (!start()) win.addEventListener('rbft:graph-ready', start, { once: true });
}

bootFromPage();
