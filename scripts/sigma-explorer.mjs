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
// Edges are drawn STRAIGHT, like the lines between stars in a constellation.
// Curved edges were tried and rejected: bowed threads pile up and fight each
// other wherever several cross. That puts the whole burden of keeping threads
// off unrelated nodes on the layout solver (see relaxLayout), which is where it
// belongs anyway.
//
// Interaction contract carried over from the SVG renderer (do not regress):
//   - Click a band   -> electric blue (#27b8ff) glow on its members + edges.
//   - Click a member -> amber/gold (#ffb454) glow on their bands + edges.
//   - Click empty space -> clear the selection.
//   - Pan (drag), zoom (wheel/pinch), tap to select. 2.5D only: NO camera
//     rotation, NO orbit, NO CAD-style pilot mode. Depth comes from scale,
//     glow, halo and fog, not from a third axis.
//
// Deps come from the CDN as ES modules via the import map in index.html,
// mirroring how the page already loads d3 from a CDN script tag; package.json
// pins the same versions so the test suite and the browser agree.
// ---------------------------------------------------------------------------

import Graph from 'graphology';
import Sigma from 'sigma';

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
  nodeSizeScale,
  layoutExtent,
  labelSettings,
  framingRatio,
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

// Hover styling. Sigma's default hover draws a WHITE rounded plate behind the
// node and its label, which is jarring on a dark starfield and washes the label
// out. This is the same idea done in the theme's own colours: a dark plate so
// threads passing behind the text do not run through the letters, a thin cyan
// edge, and a soft glow on the node itself.
// Nearly opaque on purpose: the node's ordinary label is drawn UNDER this plate,
// and at 0.88 it ghosted through as a second set of letters.
const HOVER_PLATE_FILL = 'rgba(9,12,18,0.985)';
const HOVER_PLATE_EDGE = 'rgba(143,232,246,0.45)';
const HOVER_LABEL_COLOR = '#e8f6fa';
const HOVER_GLOW = 'rgba(143,232,246,0.30)';

// Upper bound on datalist options. Comfortably above the band count, low
// enough that a pathological graph cannot stall the browser building the list.
const MAX_SUGGESTIONS = 800;

const SMALLEST_NODE_SIZE = Math.min(...Object.values(KIND_STYLE).map(style => style.size));
const LARGEST_NODE_SIZE = Math.max(...Object.values(KIND_STYLE).map(style => style.size));

const EDGE_COLOR = 'rgba(150,170,190,0.22)';
const DIM_LABEL_COLOR = 'rgba(150,163,178,0.75)';
// How much a selected node grows. Used both when drawing and when framing.
const HIGHLIGHT_GROWTH = 1.25;
// Dimmed nodes must be OPAQUE. A translucent fill let highlighted edges show
// straight through them, which read as two nodes overlapping (reported from
// the first preview) rather than as one dimmed node behind a gold thread.
const DIM_NODE_COLOR = '#4e5865';
const STAGE_ID = 'sigma-stage';

const EXPLORE_COPY = 'You are viewing one region of a much larger music universe.';

// Base camera ratio for a freshly framed view. Comfortably above 1 because Sigma
// frames NODES, and a node's label extends well past it -- at 1.0 every name
// near the edge was cut off, and at 1.22 the longest ones still were.
// framingRatio() reduces this (zooms in) when fitting the whole view would push
// nodes into each other.
const FRAMED_RATIO = 1.5;

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
  /* Sentence case, not uppercase: this is a person's name, and shouting it was
     never the point -- the ring and the glow already say "you are here". */
  font-size:11.5px;letter-spacing:0.02em;color:#c8d3e0;opacity:0.9;
  /* A soft dark halo around the glyphs, so a thread passing behind the text
     reads as behind it instead of through it. Cheaper and less boxy than a
     plate, and it keeps the label feeling like part of the starfield. */
  text-shadow:0 0 6px rgba(8,11,17,0.95),0 0 12px rgba(8,11,17,0.85)}
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
  margin-top:6px;white-space:nowrap;font-size:11.5px;letter-spacing:0.02em;
  color:#a8d7e0;opacity:0.9;text-shadow:0 0 6px rgba(8,11,17,0.95),0 0 12px rgba(8,11,17,0.85)}
/* The search prompt is the one thing a first-time visitor must not have to
   look for, so it is scaled like a search homepage's field rather than like a
   toolbar control: wide, tall enough to read as the primary action, and lifted
   off the starfield with a shadow so it never competes with the threads behind
   it. Sizes use clamp() so the same rule serves a phone and a desktop. */
#${STAGE_ID} .sigma-prompt{position:absolute;left:50%;bottom:30px;transform:translateX(-50%);
  width:min(620px,92vw);display:flex;flex-direction:column;gap:10px;z-index:4}
#${STAGE_ID} .sigma-prompt form{display:flex;gap:10px;align-items:stretch}
/* One explicit height for both controls, rather than letting each derive its
   own from padding plus line-height: a button's content box does not resolve
   the same way an input's does, and the two ended up 8px apart. Horizontal
   padding only; vertical centring is done by the flex/line box. */
#${STAGE_ID} .sigma-prompt input,
#${STAGE_ID} .sigma-prompt button{height:clamp(48px,5.4vw,58px);box-sizing:border-box}
#${STAGE_ID} .sigma-prompt input{flex:1;min-width:0;
  padding:0 clamp(18px,2vw,24px);border-radius:999px;
  border:1px solid rgba(143,232,246,0.38);background:rgba(10,14,20,0.86);color:#e8eef6;
  /* Never below 16px: iOS Safari zooms the whole page when a focused input's
     text is smaller than that, which yanks the constellation off screen. */
  font-size:clamp(16px,1.7vw,18px);line-height:1.2;
  box-shadow:0 8px 28px rgba(4,7,12,0.55);backdrop-filter:blur(6px);
  transition:border-color 140ms ease, box-shadow 140ms ease}
#${STAGE_ID} .sigma-prompt input::placeholder{color:#93a1b2}
#${STAGE_ID} .sigma-prompt input:focus{outline:none;border-color:rgba(143,232,246,0.75);
  box-shadow:0 8px 28px rgba(4,7,12,0.55),0 0 0 3px rgba(143,232,246,0.18)}
#${STAGE_ID} .sigma-prompt button{flex:none;white-space:nowrap;
  display:inline-flex;align-items:center;justify-content:center;
  padding:0 clamp(20px,2.4vw,30px);border-radius:999px;
  border:1px solid rgba(143,232,246,0.42);background:rgba(143,232,246,0.18);color:#e2f7fc;
  /* Matches the input's line-height so both controls compute to the same
     height; a button's default "normal" line-height made it 8px taller. */
  font-size:clamp(15px,1.6vw,17px);line-height:1.2;font-weight:500;letter-spacing:0.01em;cursor:pointer;
  box-shadow:0 8px 28px rgba(4,7,12,0.45);transition:background 140ms ease, border-color 140ms ease}
#${STAGE_ID} .sigma-prompt button:hover{background:rgba(143,232,246,0.28);
  border-color:rgba(143,232,246,0.7)}
#${STAGE_ID} .sigma-prompt button:focus-visible{outline:2px solid rgba(143,232,246,0.8);
  outline-offset:2px}
#${STAGE_ID} .sigma-prompt .sigma-hint{text-align:center;font-size:13px;color:#93a1b2}
#${STAGE_ID} .sigma-expand{position:absolute;right:18px;bottom:26px;z-index:4;display:flex;
  flex-direction:column;align-items:flex-end;gap:6px}
#${STAGE_ID} .sigma-expand button{padding:9px 14px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(201,182,255,0.4);background:rgba(201,182,255,0.14);color:#e4dbff;font-size:13px}
#${STAGE_ID} .sigma-expand .sigma-frontier{font-size:11px;color:#8b98a8}
#${STAGE_ID} .sigma-context{position:absolute;left:18px;top:18px;z-index:4;font-size:12px;
  color:#9aa7b6;max-width:min(320px,60vw);line-height:1.45}
#${STAGE_ID} .sigma-context strong{color:#dfe6ef;font-weight:500}
@media (max-width:720px){
  #${STAGE_ID} .sigma-prompt{bottom:78px;width:min(94vw,620px);gap:8px}
  #${STAGE_ID} .sigma-prompt form{gap:8px}
  /* Keeps "Explore" from eating the field's width on a narrow phone, without
     dropping the input's font below the 16px no-zoom threshold. */
  #${STAGE_ID} .sigma-prompt button{padding:0 18px}
  #${STAGE_ID} .sigma-prompt .sigma-hint{font-size:12px}
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
  // Computed once: updateChrome() runs on every view change, and this does not.
  const bandNames = master.nodes.filter(node => node.type === 'band').map(node => node.id);

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
    layoutExtent: 0,
    // Exposed so scripts/layout-audit.mjs can catch a phantom overlay: a star
    // drawn for a node that is not in the current view.
    homeStarId: null,
  };

  state.homeStarId = homeStarId;

  const viewGraph = new GraphConstructor({ type: 'undirected', multi: false, allowSelfLoops: false });

  const renderer = new SigmaConstructor(viewGraph, canvasHost, {
    // 2.5D contract: pan and zoom only. Sigma's camera rotation stays off.
    enableCameraRotation: false,
    // Deliberately tiny: framingRatio() zooms in hard on big views, and a floor
    // here would silently cap that zoom and let nodes touch again.
    minCameraRatio: 0.005,
    maxCameraRatio: 4,
    labelFont: 'Satoshi, system-ui, sans-serif',
    labelColor: { color: '#c8d3e0' },
    // Overwritten per view by applyLabelSettings(); these are the opening
    // defaults so the very first frame is not label-less.
    ...labelSettings({ visibleCount: 0, smallestNodeSize: SMALLEST_NODE_SIZE }),
    // Per-node label colour, so dimmed nodes keep their NAME while losing
    // emphasis. Stripping labels on dim made names appear only on click.
    labelColor: { attribute: 'labelColor', color: '#c8d3e0' },
    defaultEdgeColor: EDGE_COLOR,
    hideEdgesOnMove: true,
    hideLabelsOnMove: true,
    // Replaces the white default hover plate; see drawHover.
    defaultDrawNodeHover: drawHover,
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
        res.size = res.size * HIGHLIGHT_GROWTH;
        res.zIndex = 2;
      } else {
        // Dim, but keep the name: a highlight should answer "who else is
        // connected", not blank out the rest of the constellation.
        res.color = DIM_NODE_COLOR;
        res.labelColor = DIM_LABEL_COLOR;
      }
    }
    return res;
  }

  function reduceEdge(edge, attrs) {
    if (!state.highlightEdges.size) return { ...attrs, color: EDGE_COLOR };
    return state.highlightEdges.has(edge)
      ? { ...attrs, color: state.highlightColor, size: 2.2, zIndex: 1 }
      : { ...attrs, color: 'rgba(120,134,150,0.10)', size: 0.8 };
  }

  // -- sizing ---------------------------------------------------------------

  // How far out to sit for the current view: fit everything when that is
  // legible, otherwise show a region at a usable scale and let people pan.
  function framedRatio() {
    const rect = canvasHost.getBoundingClientRect();
    return framingRatio({
      extent: state.layoutExtent,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      // Selection grows a node by a quarter (see reduceNode), so frame for the
      // biggest a node can ever be drawn, not its resting size.
      maxNodeSize: LARGEST_NODE_SIZE * state.sizeScale * HIGHLIGHT_GROWTH,
      baseRatio: FRAMED_RATIO,
    });
  }

  // Node radii are screen pixels, so how close nodes look depends on the
  // window as much as on the node count. Recomputed per view AND on resize.
  function applySizeScale(visibleCount = state.view ? state.view.nodes.length : 0) {
    const rect = canvasHost.getBoundingClientRect();
    state.sizeScale = nodeSizeScale({
      visibleCount,
      extent: state.layoutExtent,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      maxNodeSize: LARGEST_NODE_SIZE,
    });
    // Label thresholds follow the smallest node ACTUALLY drawn, so shrinking
    // nodes never silently costs a name.
    const labels = labelSettings({
      visibleCount,
      smallestNodeSize: SMALLEST_NODE_SIZE * state.sizeScale,
    });
    Object.entries(labels).forEach(([key, value]) => renderer.setSetting(key, value));
    renderer.refresh();
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
      spacing: 190,
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

    state.layoutExtent = layoutExtent(positions);
    applySizeScale(view.nodes.length);
    state.anchorId = anchorId;
    state.view = view;
    state.maxNodes = maxNodes;
    clearHighlight();
    updateChrome();
    // Framing, in two cases:
    //
    //   FITS      The whole view is legible on this screen, so frame the whole
    //             view -- centred on its bounding box, not on the anchor. The
    //             relaxed layout is an asymmetric cloud, so centring on the
    //             anchor clipped whatever was furthest from it.
    //   ZOOMED IN Fitting would push nodes into each other, so show a region at
    //             a usable scale. Now the anchor IS the right thing to centre on:
    //             it is what the visitor came for.
    const ratio = framedRatio();
    if (animate) {
      flyTo(anchorId, { animate: true, ratio: Math.min(0.8, ratio) });
    } else if (ratio >= FRAMED_RATIO - 1e-6) {
      renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio, angle: 0 });
      positionOverlays();
    } else {
      flyTo(anchorId, { animate: false, ratio });
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

    // Search suggestions, in alphabetical order.
    //
    // The list used to be ordered by relevance -- the frontier first, then an
    // arbitrary slice of the corpus -- which reads as random the moment someone
    // clicks the empty field and just looks at what is on offer. A browser
    // datalist substring-filters as you type, so relevance ordering buys
    // nothing once there is a query, and alphabetical is what a person scanning
    // a list expects. Every band is offered (not a 200-node slice), plus the
    // current frontier, so the natural next steps are always present.
    //
    // Musicians are deliberately not listed: 2,700 names would bury the bands,
    // and typing any musician's name still resolves through resolveAnchor.
    const suggestions = new Set([...view.frontier.slice(0, 40), ...bandNames]);
    datalist.innerHTML = Array.from(suggestions)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
      .slice(0, MAX_SUGGESTIONS)
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

  renderer.on('resize', () => applySizeScale());

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

/**
 * Draws the hover treatment for a node: a dark rounded plate behind the label,
 * a hairline cyan edge, and a soft glow behind the node.
 *
 * Signature is Sigma's `defaultDrawNodeHover(context, data, settings)`.
 */
function drawHover(context, data, settings) {
  const size = settings.labelSize || 12;
  const font = settings.labelFont || 'Satoshi, system-ui, sans-serif';
  const weight = settings.labelWeight || 'normal';
  const label = data.label;

  context.font = `${weight} ${size}px ${font}`;

  // Glow behind the node, so hovering reads as "this one" even without a label.
  context.beginPath();
  context.fillStyle = HOVER_GLOW;
  context.arc(data.x, data.y, data.size + 7, 0, Math.PI * 2);
  context.closePath();
  context.fill();

  if (!label) return;

  const width = context.measureText(label).width;
  const paddingX = 10;
  const paddingY = 6;
  const plateHeight = size + paddingY * 2;
  // Starts just inside where Sigma's normal label begins, so the plate covers it
  // completely -- otherwise the first glyph of the underlying label peeks out
  // from behind the plate's left edge.
  const left = data.x + data.size;
  const top = data.y - plateHeight / 2;
  const radius = plateHeight / 2;

  context.beginPath();
  context.fillStyle = HOVER_PLATE_FILL;
  context.strokeStyle = HOVER_PLATE_EDGE;
  context.lineWidth = 1;
  // Rounded rectangle; roundRect is not available everywhere, so it is drawn by
  // hand from arcs.
  const right = left + width + paddingX * 2;
  const bottom = top + plateHeight;
  context.moveTo(left + radius, top);
  context.lineTo(right - radius, top);
  context.arcTo(right, top, right, top + radius, radius);
  context.lineTo(right, bottom - radius);
  context.arcTo(right, bottom, right - radius, bottom, radius);
  context.lineTo(left + radius, bottom);
  context.arcTo(left, bottom, left, bottom - radius, radius);
  context.lineTo(left, top + radius);
  context.arcTo(left, top, left + radius, top, radius);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = HOVER_LABEL_COLOR;
  context.fillText(label, left + paddingX + 2, data.y + size / 3);
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
