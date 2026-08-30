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
import Sigma, { createNodeBorderProgram } from 'sigma';

import {
  rendererFromSearch,
  resolveAnchor,
  getNeighborhood,
  getConnectedComponents,
  buildAdjacency,
  radialLayout,
  classifyNode,
  toGraphologyGraph,
  NEIGHBORHOOD_BUDGET,
  NODE_KINDS,
  NODE_TYPES,
  nodeTypeForRole,
  MEMBERSHIP_ROLES,
  roleForNode,
  roleFromMembership,
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

// Role colours. Hue carries the role because brightness does not: a founder and
// a plain member drawn in the same hue at different lightness are
// indistinguishable once they are intermixed around a band, which is how they
// actually appear. The reference point is the one distinction that already works
// in this app -- gold strings for members, blue strings for bands -- where the
// hue changes, not the weight.
//
// Nothing here is invented. Gold is the existing MEMBER_HIGHLIGHT_COLOR family,
// lavender is the existing constellation colour, slate is the existing moon
// colour, and bands keep their cyan so a person can never be mistaken for one.
//
// Size is deliberately NOT set here. `kind` owns size (how connected) and `role`
// owns colour (what they were); keeping the two axes on separate channels is the
// entire point, since a founder of one band and a founder of six should differ.
const ROLE_STYLE = {
  [MEMBERSHIP_ROLES.FOUNDER]: { color: '#ffc65c' },
  [MEMBERSHIP_ROLES.MEMBER]: { color: '#c9b6ff' },
  [MEMBERSHIP_ROLES.TOURING]: { color: '#7d8ea0' },
};

// Threads are NOT coloured by role.
//
// #119 coloured them per membership at rest, and that broke the one distinction
// the app already had: a thread glows gold when a MEMBER is clicked and electric
// blue when a BAND is clicked. Painting founder threads gold at rest gave gold
// two meanings at once -- "founding member" and "this is what you selected" --
// and a colour that means two things means neither.
//
// So every thread stays one quiet blue-grey until a click, and gold and blue
// belong to selection alone. Role lives on the NODES, where it has three hues of
// its own and competes with nothing.
//
// The role attribute is still carried on every edge. It costs nothing to keep, it
// is what a legend or a "show only founders" filter would read, and deriving it
// at render time later would mean plumbing weight through the view builder a
// second time.

// Node treatments: solid, ringed, hollow.
//
// The three shapes from the original design legend --
//
//   Founding band member   solid filled circle
//   Long time band member  ringed circle, dot in the centre
//   Short term / touring   hollow outline
//
// -- which were never built, because a border needs a WebGL node program and the
// vendored Sigma bundle exported none. @sigma/node-border is the official one and
// now rides inside that bundle (see scripts/vendor-libs.mjs).
//
// This is a SECOND channel on top of hue, not a replacement for it, and it earns
// its keep in exactly the case hue cannot cover: a click sets every highlighted
// node to one colour, so gold-means-founder disappears the moment gold also means
// selected. Shape survives that, because the border programs read the `color`
// attribute the highlight overwrites and keep their geometry regardless.
//
// Ring gaps are painted in the stage background (#04070b, the dark theme's
// --color-bg) rather than left transparent: these are opaque WebGL discs, and a
// "transparent" band would show the node's own fill through it and read as solid.
const STAGE_BG = '#04070b';

// Sizes are fractions of the node radius, drawn outside in.
const RINGED_PROGRAM = createNodeBorderProgram({
  borders: [
    // Outer ring in the node's colour.
    { color: { attribute: 'color' }, size: { value: 0.28 } },
    // Gap, so the ring reads as a ring and not a thick edge.
    { color: { value: STAGE_BG }, size: { value: 0.26 } },
    // Centre dot, the rest of the way in.
    { color: { attribute: 'color' }, size: { fill: true } },
  ],
});

const HOLLOW_PROGRAM = createNodeBorderProgram({
  borders: [
    // A thin outline and nothing else. Deliberately the lightest visual mass of
    // the three: a touring stint should recede next to a founder.
    { color: { attribute: 'color' }, size: { value: 0.3 } },
    { color: { value: STAGE_BG }, size: { fill: true } },
  ],
});

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

/**
 * The secondary actions, as one quiet row of pills under the search field --
 * the shape of a fresh browser home page: wordmark, search, a row of shortcuts.
 *
 * Each carries a one-word label and a sentence explaining it, shown in a
 * popover on hover, on keyboard focus, and on tap. One word alone is not
 * self-explanatory ("Reset" resets WHAT?), and a title attribute is invisible
 * to touch, so the sentence is part of the control rather than a nicety.
 *
 * `target` names an existing control in index.html: these pills drive the
 * page's real buttons rather than reimplementing their behaviour, so the two
 * paths cannot drift apart. `action` names a Sigma-side function instead.
 */
const STAGE_ACTIONS = [
  {
    key: 'expand',
    label: 'Expand',
    detail: 'Push the horizon out one degree and pull in the bands just beyond this view.',
    action: 'expand',
  },
  {
    key: 'reset',
    label: 'Reset',
    // Deliberately does not name the default anchor. Every visitor sees this
    // copy, and naming one person makes a shared tool read as somebody's
    // personal page.
    detail: 'Start over from the beginning, back to the view you opened with.',
    action: 'home',
  },
  {
    key: 'filter',
    label: 'Filter',
    detail: 'Narrow the tree to one scene, one genre, or the most recently added bands.',
    action: 'filters',
  },
  {
    key: 'add',
    label: 'Add',
    detail: 'Add a band and its line-up to the tree. Requires signing in.',
    target: '#add-band-btn',
  },
  {
    key: 'share',
    label: 'Share',
    detail: 'Copy a link to this exact view, or post it.',
    target: '#share-graph-btn',
  },
  {
    key: 'feedback',
    label: 'Feedback',
    detail: 'Tell us what is broken, missing or wrong. It reaches a person.',
    target: '#send-feedback-btn',
  },
];

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
const TIP_ID = 'sigma-action-tip';
// Set on <body> while the Sigma renderer owns the screen, so the page's own
// toolbar, hero and stats badge can step aside for the minimal chrome. Removed
// again by destroy(), which matters because the flag is switchable at runtime.
const BODY_ACTIVE_CLASS = 'rbft-sigma-chrome';

const EXPLORE_COPY = 'You are viewing one region of a much larger music universe.';
// Shown while the view is centred on the home star, which is where every visitor
// who has not followed a shared link begins.
//
// Landing a stranger on one specific musician is only charming if they are told
// why -- the Tom-from-Myspace trick works because Tom introduced himself. Without
// this, the opening view reads as "here is a person you have never heard of".
// First person, because it is his site and his node. The name comes from the
// home star rather than being written in, so changing the default anchor cannot
// leave the copy claiming to be someone else.
//
// The last sentence names Travel. Travel is the primary way to move through this
// graph -- clicking a node re-centres the view on it -- and until now no copy
// anywhere said so. The opening story pointed only at the search field, which
// teaches a visitor exactly one way in and leaves the other 3,000 nodes looking
// like decoration. "Click any band or musician" matches the phrasing the legacy
// selection panel already uses, so the site says it one way.
const introCopy = (name) => {
  const first = String(name || '').trim().split(/\s+/)[0] || 'I';
  return `<strong class="sigma-intro__hello">Hey, I&rsquo;m ${escapeHtml(first)}.</strong> `
    + `I built this site &mdash; you&rsquo;re starting on my node. `
    + `Search for a band or artist above to find your place in the band universe. `
    + `Click any band or musician to travel there.`;
};

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
#${STAGE_ID} .sigma-star-label{position:absolute;z-index:3;pointer-events:none;
  transform:translateX(-50%);white-space:nowrap;letter-spacing:0.02em;
  /* A halo rather than a plate, so a thread passing behind the name reads as
     behind it without putting a box on the starfield. */
  text-shadow:0 0 7px rgba(8,11,17,0.97),0 0 14px rgba(8,11,17,0.9),0 0 22px rgba(8,11,17,0.7)}
#${STAGE_ID} .sigma-star-label[hidden]{display:none}
/* Gold, and bigger than a node label: this is the one fixed point in the
   galaxy, and it should read as a different kind of thing from the band and
   musician names around it. */
#${STAGE_ID} .sigma-home-label{font-size:14px;color:#ffc978;font-weight:500}
#${STAGE_ID} .sigma-focus-ring{position:absolute;pointer-events:none;transform:translate(-50%,-50%);
  width:58px;height:58px}
#${STAGE_ID} .sigma-focus-ring .ring{position:absolute;inset:0;border-radius:50%;
  border:1.4px solid rgba(143,232,246,0.75);box-shadow:0 0 14px rgba(143,232,246,0.35)}
/* When the home star and the current focus are near each other, Aaron's name
   would print across the focus ring; positionOverlays() flips it above his star. */
/* A relocated panel has lost the button it used to hang below, so it is centred
   on screen as a dialog instead. clampPopover() sets an inline left offset to
   keep a bottom-anchored popover on screen; that offset is meaningless here, so
   the centring has to win over it. */
#${STAGE_ID} > .share-popover{position:fixed;left:50% !important;top:50%;
  transform:translate(-50%,-50%);z-index:12;max-height:86vh;overflow-y:auto;
  margin:0;width:min(560px,92vw)}
@media (max-width:720px){
  #${STAGE_ID} > .share-popover{width:94vw;max-height:82vh}
}

/* left/top are set by positionFilters() from the Filter pill's own rect, the
   same way the shortcut popover is placed. They used to be
   left:50%;top:calc(100% + 10px), which reads like "hang below my trigger" but
   this panel is a child of the STAGE, not of the pill row -- so 100% meant the
   full height of a 100dvh stage and the panel opened just below the bottom of
   the window. It was doing everything else correctly, entirely off screen. */
#${STAGE_ID} .sigma-filters{position:absolute;width:min(420px,92vw);z-index:8;padding:16px 18px 18px;
  border-radius:var(--radius-card,12px);border:1px solid rgba(143,232,246,0.3);background:rgba(9,12,18,0.97);
  box-shadow:0 18px 44px rgba(3,6,10,0.7);display:flex;flex-direction:column;gap:12px;
  text-align:left}
#${STAGE_ID} .sigma-filters[hidden]{display:none}
#${STAGE_ID} .sigma-filters__title{margin:0;font-size:14px;color:#e6f1f8;letter-spacing:0.01em}
#${STAGE_ID} .sigma-filters__close{position:absolute;top:8px;right:10px;width:28px;height:28px;
  border:0;background:none;color:#93a1b2;font-size:20px;line-height:1;cursor:pointer;padding:0}
#${STAGE_ID} .sigma-filters__close:hover{color:#e6f1f8}
#${STAGE_ID} .sigma-filters__slot label{display:block;margin-bottom:5px;font-size:12px;color:#93a1b2}
#${STAGE_ID} .sigma-filters__slot select{width:100%;min-height:42px;margin:0;
  border-radius:var(--radius-control,8px);border:1px solid rgba(190,206,224,0.24);background:rgba(14,19,26,0.92);
  color:#e2ecf5;font-size:14px;padding:0 10px}
#${STAGE_ID} .sigma-filters__row{display:flex;gap:8px;flex-wrap:wrap}
#${STAGE_ID} .sigma-filters__row button{flex:1;min-width:130px;min-height:42px;margin:0;
  border-radius:999px;border:1px solid rgba(190,206,224,0.24);background:rgba(14,19,26,0.9);
  color:#c3d0de;font-size:13px;cursor:pointer}
#${STAGE_ID} .sigma-filters__row button:hover{color:#eaf4fb;border-color:rgba(143,232,246,0.6)}
#${STAGE_ID} .sigma-filters__row button[aria-pressed="true"]{color:#0b1016;
  background:rgba(143,232,246,0.9);border-color:rgba(143,232,246,0.9)}
/* A dot on the pill when anything is filtering, so a narrowed tree is never a
   mystery -- the count in the footer tells you how many nodes, but not why. */
#${STAGE_ID} .sigma-action[data-active="true"]::after{content:'';width:6px;height:6px;
  margin-left:7px;border-radius:50%;background:#8fe8f6;display:inline-block}

/* Threads and nodes pass under the chrome, since the starfield is the whole
   page. These gradients sink the graph slightly behind the hero and the footer
   so text never has a node label sitting in the middle of it. Deliberately soft
   and short: a hard band would rebuild the seam that full-bleed removes. */
#${STAGE_ID} .sigma-scrim{position:absolute;left:0;right:0;z-index:3;pointer-events:none}
#${STAGE_ID} .sigma-scrim--top{top:0;height:clamp(140px,22vh,210px);
  background:linear-gradient(180deg,rgba(6,9,14,0.92) 0%,rgba(6,9,14,0.72) 45%,rgba(6,9,14,0) 100%)}
#${STAGE_ID} .sigma-scrim--bottom{bottom:0;height:clamp(90px,14vh,140px);
  background:linear-gradient(0deg,rgba(6,9,14,0.9) 0%,rgba(6,9,14,0.6) 50%,rgba(6,9,14,0) 100%)}

/* The hero: wordmark, search, and one quiet row of shortcut pills, stacked at
   the top of the starfield. This is the shape of a fresh browser home page, and
   the reason the graph itself gets the whole rest of the screen. */
#${STAGE_ID} .sigma-hero{position:absolute;left:50%;top:clamp(16px,3.4vh,40px);
  transform:translateX(-50%);width:min(620px,92vw);display:flex;flex-direction:column;
  align-items:center;gap:clamp(10px,1.6vh,16px);z-index:4}
#${STAGE_ID} .sigma-wordmark{margin:0;font-size:clamp(15px,2.2vw,26px);font-weight:400;
  letter-spacing:0.18em;text-transform:uppercase;color:#dbe6f2;text-align:center;
  text-shadow:0 0 10px rgba(8,11,17,0.95),0 0 20px rgba(8,11,17,0.8)}
/* The shortcut row stays deliberately quiet -- hairline border, no fill -- so
   the constellation is the only bright thing until someone reaches for a
   control. */
#${STAGE_ID} .sigma-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
#${STAGE_ID} .sigma-action{height:clamp(40px,4.2vw,44px);padding:0 clamp(14px,1.6vw,20px);
  border-radius:999px;border:1px solid rgba(190,206,224,0.22);background:rgba(10,14,20,0.55);
  color:#c3d0de;font-size:clamp(13px,1.2vw,14px);line-height:1;white-space:nowrap;
  cursor:pointer;margin:0;backdrop-filter:blur(6px);
  transition:color 140ms ease,border-color 140ms ease,background 140ms ease}
#${STAGE_ID} .sigma-action:hover{color:#eaf4fb;border-color:rgba(143,232,246,0.6);
  background:rgba(143,232,246,0.14)}
#${STAGE_ID} .sigma-action:focus-visible{outline:2px solid rgba(143,232,246,0.8);outline-offset:2px}
#${STAGE_ID} .sigma-action[aria-expanded="true"]{color:#eaf4fb;border-color:rgba(143,232,246,0.6)}
/* One popover element, moved to whichever pill is being hovered, focused or
   tapped. A title attribute would have been invisible on touch. */
#${STAGE_ID} .sigma-tip{position:absolute;z-index:6;
  /* max-content so the sentence sets its own width up to the cap; without it the
     popover shrank to the space left of wherever it was previously placed. */
  width:max-content;max-width:min(280px,80vw);
  padding:9px 12px;border-radius:var(--radius-card,12px);border:1px solid rgba(143,232,246,0.34);
  background:rgba(9,12,18,0.97);color:#dce9f3;font-size:13px;line-height:1.4;
  box-shadow:0 10px 30px rgba(3,6,10,0.7);pointer-events:none}
#${STAGE_ID} .sigma-tip[hidden]{display:none}
/* The running commentary sits at the bottom, out of the hero's way. */
#${STAGE_ID} .sigma-footer{position:absolute;left:50%;bottom:clamp(14px,2.4vh,26px);
  transform:translateX(-50%);width:min(620px,92vw);display:flex;flex-direction:column;
  align-items:center;gap:4px;text-align:center;z-index:4}
#${STAGE_ID} .sigma-prompt{width:100%;display:flex;flex-direction:column;gap:10px}
#${STAGE_ID} .sigma-prompt form{display:flex;gap:10px;align-items:stretch}
/* One explicit height for both controls, rather than letting each derive its
   own from padding plus line-height: a button's content box does not resolve
   the same way an input's does, and the two ended up 8px apart. Horizontal
   padding only; vertical centring is done by the flex/line box. */
#${STAGE_ID} .sigma-prompt input,
#${STAGE_ID} .sigma-prompt button{height:clamp(48px,5.4vw,58px);box-sizing:border-box;
  /* margin:0 is load-bearing. The page's global form styling
     (input,select,textarea{margin-top:var(--space-2)}) is written for stacked
     fields with a label above, and it leaked in here: the field sat 8px lower
     than the Explore button, so the two pills were the same size but not on the
     same row. Reset on both controls so neither can drift again. */
  margin:0;vertical-align:middle}
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
#${STAGE_ID} .sigma-footer .sigma-hint{margin:0;font-size:13px;color:#93a1b2}
/* The greeting is in the gold of his star label, so the voice and the node the
   visitor is looking at are visibly the same thing. */
#${STAGE_ID} .sigma-intro__hello{color:#ffc978;font-weight:500}
#${STAGE_ID} .sigma-footer .sigma-frontier{font-size:12px;color:#8b98a8}
#${STAGE_ID} .sigma-context{margin:0;font-size:12px;color:#9aa7b6;line-height:1.45}
#${STAGE_ID} .sigma-context strong{color:#dfe6ef;font-weight:500}
/* Disconnected-scene disclosure: a filtered scene can leave a handful of
   bands with no shared members with what's on screen, and no "Expand" will
   ever reach them. This says so and offers a one-click jump, rather than
   quietly implying the view is complete. */
#${STAGE_ID} .sigma-other-groups{margin:0;font-size:12px;color:#8b98a8;display:flex;
  flex-wrap:wrap;justify-content:center;align-items:baseline;gap:6px}
#${STAGE_ID} .sigma-other-groups[hidden]{display:none}
#${STAGE_ID} .sigma-other-groups__btn{border:0;background:none;padding:0;margin:0;
  font:inherit;color:#8fe8f6;text-decoration:underline;text-underline-offset:2px;
  cursor:pointer}
#${STAGE_ID} .sigma-other-groups__btn:hover{color:#c3f2fb}
#${STAGE_ID} .sigma-other-groups__btn:focus-visible{outline:2px solid rgba(143,232,246,0.8);
  outline-offset:2px}
/* --------------------------------------------------------------------------
   The page's own chrome, stood down while Sigma is rendering.

   Both renderers share index.html, and its toolbar, hero and stats badge were
   built for the SVG path: with the Sigma stage on top, the visitor saw two sets
   of controls for one graph. These rules retire the duplicates for as long as
   the Sigma flag is on; destroy() removes the body class, so switching back
   restores everything.
   -------------------------------------------------------------------------- */
body.${BODY_ACTIVE_CLASS} .hero,
body.${BODY_ACTIVE_CLASS} .graph-overlay-top,
body.${BODY_ACTIVE_CLASS} .graph-stats-badge,
body.${BODY_ACTIVE_CLASS} .graph-panel-head,
body.${BODY_ACTIVE_CLASS} .graph-version-pill,
/* Anchored to the page's Sign-up button, which is now hidden, so it floated
   over the hero pointing at nothing. */
body.${BODY_ACTIVE_CLASS} .welcome-nudge{display:none !important}
/* The account strip in the site header STAYS: it is the one place that shows who
   you are signed in as and how to sign out, and it sits top-right exactly where
   a search homepage puts the avatar. It is why there is no Sign-in pill in the
   shortcut row -- two entry points for one action is worse than none. */
body.${BODY_ACTIVE_CLASS} .site-header{position:fixed;top:0;right:0;left:auto;width:auto;
  z-index:6;background:none;border:none;box-shadow:none;padding:10px 14px}
body.${BODY_ACTIVE_CLASS} .site-header .header-inner{padding:0;max-width:none}
/* The stage is fixed to the viewport, so the page behind it must not scroll a
   dark panel out from under the constellation. */
body.${BODY_ACTIVE_CLASS} .graph-panel{min-height:100dvh}

/* The node card, docked. Clicking a band or musician now flies the camera AND
   opens its card in one action, so the card cannot be anchored to the node any
   more: it would ride along with the flight and land under the hero or the
   footer. Docked bottom-right it is always in the same place, clear of the
   centred constellation and clear of the footer's commentary. Fixed rather than
   absolute because the starfield is the whole page.
   The mobile bottom-sheet rules below 700px still win -- they are !important and
   a corner card on a phone would cover the graph it describes. */
@media (min-width:701px){
  body.${BODY_ACTIVE_CLASS} .node-card{position:fixed;z-index:13;
    right:clamp(16px,2vw,28px);bottom:clamp(16px,2.4vh,28px);left:auto;top:auto;
    transform:none;width:min(330px,32vw);min-width:0;max-width:none;
    max-height:min(56vh,520px)}
  /* The tail is a pointer at a node this card no longer sits beside. */
  body.${BODY_ACTIVE_CLASS} .node-card__tail{display:none}
  body.${BODY_ACTIVE_CLASS} .node-card.node-card--below{transform:none}
}

@media (max-width:720px){
  #${STAGE_ID} .sigma-hero{width:min(94vw,620px);gap:10px}
  #${STAGE_ID} .sigma-prompt{gap:8px}
  #${STAGE_ID} .sigma-prompt form{gap:8px}
  /* One row, all six words. The wrap to a second row was never a shortage of
     space -- at the old padding the row measured 353px inside 390px and still
     broke. Tightened padding and font bring the rightmost edge to 366px, so
     every action stays visible and named rather than being renamed, hidden
     behind a menu, or pushed off a scrolling edge. Height stays at 44px for the
     tap target even though only width was ever the constraint. */
  #${STAGE_ID} .sigma-actions{gap:5px;flex-wrap:nowrap}
  #${STAGE_ID} .sigma-action{padding:0 9px;font-size:12px;height:44px}
  /* Keeps "Explore" from eating the field's width on a narrow phone, without
     dropping the input's font below the 16px no-zoom threshold. */
  #${STAGE_ID} .sigma-prompt button{padding:0 18px}
  #${STAGE_ID} .sigma-footer .sigma-hint{font-size:12px}
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
    <div class="sigma-scrim sigma-scrim--top" aria-hidden="true"></div>
    <div class="sigma-scrim sigma-scrim--bottom" aria-hidden="true"></div>
    <div class="sigma-home-star" hidden><span class="ring"></span><span class="core"></span></div>
    <div class="sigma-focus-ring" hidden><span class="ring"></span></div>
    <!-- The labels are siblings of the overlays they name, not children. Inside,
         they inherited the star's zoom scaling: the text grew with the zoom, and
         its distance from the star grew with it too, so the name drifted away
         from the thing it labels. Positioned independently they hold one size
         and one gap at every zoom level. -->
    <span class="sigma-star-label sigma-home-label" hidden></span>
    <div class="sigma-hero">
      <h1 class="sigma-wordmark">Six Degrees of Rock</h1>
    <div class="sigma-prompt">
      <form autocomplete="off">
        <input type="search" name="favorite-band" placeholder="Who&rsquo;s your favorite band?"
               aria-label="Search any band or artist to open their corner of the music universe"
               list="sigma-search-options" />
        <button type="submit">Explore</button>
      </form>
      <datalist id="sigma-search-options"></datalist>
    </div>
      <div class="sigma-actions" role="group" aria-label="Graph actions">
        ${STAGE_ACTIONS.map(item => `
          <button type="button" class="sigma-action" data-key="${item.key}"
                  aria-describedby="${TIP_ID}">${escapeHtml(item.label)}</button>`).join('')}
      </div>
    </div>
    <div class="sigma-tip" id="${TIP_ID}" role="tooltip" hidden></div>
    <!-- The page's own scene and genre <select> elements are MOVED in here at
         boot (see RELOCATED_FILTERS). They keep their existing change handlers,
         so there is one filtering implementation rather than a second one that
         drifts. Recently-added and Clear press the page's chips for the same
         reason. -->
    <div class="sigma-filters" role="dialog" aria-label="Filter the tree" hidden>
      <button type="button" class="sigma-filters__close" data-filter-action="close"
              aria-label="Close filters">&times;</button>
      <p class="sigma-filters__title">Filter the tree</p>
      <div class="sigma-filters__slot" data-slot="scene"></div>
      <div class="sigma-filters__slot" data-slot="genre"></div>
      <div class="sigma-filters__row">
        <button type="button" data-filter-action="recent" aria-pressed="false">Recently added</button>
        <button type="button" data-filter-action="clear">Clear all</button>
      </div>
    </div>
    <div class="sigma-footer">
      <!-- The introduction reads BEFORE the numbers. A visitor who has just been
           dropped on a stranger's node needs to know why before being told how
           many degrees out it is. -->
      <p class="sigma-hint">${EXPLORE_COPY}</p>
      <p class="sigma-context" aria-live="polite"></p>
      <span class="sigma-frontier"></span>
      <p class="sigma-other-groups" hidden>
        <span class="sigma-other-groups__text"></span>
        <button type="button" class="sigma-other-groups__btn"></button>
      </p>
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
  // Reassigned by setGraph() when the page applies a filter.
  master,
  mount = null,
  doc = typeof document !== 'undefined' ? document : null,
  search = typeof window !== 'undefined' ? window.location.search : '',
  // Injectable so the address-bar sync is testable, and so a document without a
  // window (jsdom fragments, tests) simply skips it.
  win = typeof window !== 'undefined' ? window : null,
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
  const hintEl = stage.querySelector('.sigma-hint');
  const frontierEl = stage.querySelector('.sigma-frontier');
  const otherGroupsEl = stage.querySelector('.sigma-other-groups');
  const otherGroupsTextEl = stage.querySelector('.sigma-other-groups__text');
  const otherGroupsBtn = stage.querySelector('.sigma-other-groups__btn');
  // The page's Add / Share / Feedback panels live INSIDE the toolbar that stands
  // down for the Sigma chrome, so hiding the toolbar hid the panels too and the
  // new pills opened nothing. They are moved onto the stage for the duration and
  // put back by destroy(), which keeps their existing handlers intact -- listeners
  // are bound to the elements, not to where they sit in the tree.
  const RELOCATED_PANELS = ['#add-band-popover', '#share-popover', '#feedback-popover'];
  // The page's real filter widgets, moved into the stage's filter panel. Moving
  // them rather than rebuilding them keeps their existing change handlers -- and
  // therefore one filtering implementation instead of two that drift apart.
  const RELOCATED_FILTERS = [
    { slot: 'scene', selector: '#scene-filter', label: 'Scene' },
    { slot: 'genre', selector: '#genre-filter', label: 'Genre' },
  ];
  const relocated = [];

  RELOCATED_PANELS.forEach(selector => {
    const panel = doc.querySelector(selector);
    if (!panel || !panel.parentNode) return;
    relocated.push({ panel, parent: panel.parentNode, next: panel.nextSibling });
    stage.appendChild(panel);
  });

  // Node ids whose label would collide with the chrome. See updateLabelBlocking.
  const homeLabelEl = stage.querySelector('.sigma-home-label');

  // Lives in the page's .graph-stage rather than this stage, so it is looked up
  // from the document.
  const nodeCardEl = doc.querySelector('.node-card');
  const heroEl = stage.querySelector('.sigma-hero');
  const footerEl = stage.querySelector('.sigma-footer');
  const filterPanel = stage.querySelector('.sigma-filters');
  RELOCATED_FILTERS.forEach(({ slot, selector, label }) => {
    const field = doc.querySelector(selector);
    const target = filterPanel.querySelector(`[data-slot="${slot}"]`);
    if (!field || !target || !field.parentNode) return;
    relocated.push({ panel: field, parent: field.parentNode, next: field.nextSibling });
    const caption = doc.createElement('label');
    caption.textContent = label;
    caption.setAttribute('for', field.id);
    target.appendChild(caption);
    target.appendChild(field);
  });

  const actionRow = stage.querySelector('.sigma-actions');
  const actionButtons = new Map(
    [...stage.querySelectorAll('.sigma-action')].map(el => [el.dataset.key, el])
  );
  const tip = stage.querySelector(`#${TIP_ID}`);
  const expandBtn = actionButtons.get('expand');
  const form = stage.querySelector('.sigma-prompt form');
  const input = stage.querySelector('.sigma-prompt input');
  const datalist = stage.querySelector('#sigma-search-options');

  const svg = doc.getElementById('graph-svg');
  const svgDisplayBefore = svg ? svg.style.display : null;
  if (svg) svg.style.display = 'none';
  // Retires the page's duplicate controls for as long as this renderer is up.
  doc.body.classList.add(BODY_ACTIVE_CLASS);

  // Reassignable, not const: setGraph() swaps all five when a filter changes.
  let adjacency = buildAdjacency(master.nodes, master.links);
  let masterById = new Map(master.nodes.map(node => [node.id, node]));
  // Computed once: updateChrome() runs on every view change, and this does not.
  let bandNames = master.nodes.filter(node => node.type === 'band').map(node => node.id);
  // Also computed once per filter, not per view: which nodes can reach which
  // others depends on the filtered graph's shape, not on where the anchor is.
  let components = getConnectedComponents(master.nodes, master.links, adjacency);

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
    displacedAnchorId: null,
    labelBlocked: new Set(),
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
    // Which component's node ids (as its componentKey()) "Show next group"
    // has already sent the visitor to this filter, so repeated clicks tour
    // every disconnected group instead of ping-ponging between the two
    // largest. Reset whenever setGraph() changes the filtered graph.
    visitedComponentKeys: new Set(),
    // The anchor "Show next group" jumps to, recomputed on every render.
    nextGroupAnchor: null,
  };

  state.homeStarId = homeStarId;

  const viewGraph = new GraphConstructor({ type: 'undirected', multi: false, allowSelfLoops: false });

  const renderer = new SigmaConstructor(viewGraph, canvasHost, {
    // The two border programs from the design legend. 'circle' is Sigma's own and
    // stays the default, so a node with no `type` renders exactly as before --
    // bands, the home star's tiny under-node, and anyone with no role in view.
    nodeProgramClasses: {
      [NODE_TYPES.RINGED]: RINGED_PROGRAM,
      [NODE_TYPES.HOLLOW]: HOLLOW_PROGRAM,
    },
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
    // Size from kind, colour from role. A person whose role is known overrides
    // the kind colour, which is what lets a founder read as a founder even when
    // they are a constellation -- `bandCount > 1` used to win outright and paint
    // every multi-band musician the same purple regardless of what they did.
    const roleStyle = attrs.role ? ROLE_STYLE[attrs.role] : null;
    const res = {
      ...attrs,
      size: (attrs.size || style.size) * state.sizeScale,
      color: (roleStyle && roleStyle.color) || style.color,
    };
    // The anchor's visual identity is the DOM ringed star overlay; the WebGL
    // node underneath is kept tiny and label-free so they don't fight.
    if (attrs.kind === NODE_KINDS.HOME_STAR) {
      res.size = 6;
      res.color = HOME_STAR_STYLE.color;
      res.label = '';
      return res;
    }
    // A name that would be drawn across the wordmark, the search field or the
    // footer is dropped: chrome text wins over a node label. Computed from
    // geometry in updateLabelBlocking(), not from what is currently drawn, so it
    // cannot oscillate frame to frame.
    if (state.labelBlocked.has(id)) res.label = '';
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
    // One quiet colour at rest, for every thread whatever its role. Gold and
    // electric blue are reserved for selection: gold when a member is clicked,
    // electric blue when a band is clicked.
    if (!state.highlightEdges.size) return { ...attrs, color: EDGE_COLOR };
    return state.highlightEdges.has(edge)
      ? { ...attrs, color: state.highlightColor, size: 2.2, zIndex: 1 }
      : { ...attrs, color: 'rgba(120,134,150,0.10)', size: 0.8 };
  }

  // -- sizing ---------------------------------------------------------------

  // How far out to sit for the current view: fit everything when that is
  // legible, otherwise show a region at a usable scale and let people pan.
  /**
   * How much of the canvas the chrome is sitting on, top and bottom, in pixels.
   *
   * The starfield is the whole page, so the hero and footer float over the
   * drawing. Framing to the full viewport therefore aimed the graph at a
   * rectangle whose top and bottom strips are occupied: nodes landed under the
   * wordmark and the footer, and their names had to be suppressed to avoid
   * printing through the text. Measuring the chrome instead lets the graph be
   * framed into the space that is actually free.
   */
  function chromeInsets() {
    const host = canvasHost.getBoundingClientRect();
    const MARGIN = 12;
    const measure = el => {
      if (!el || el.hidden) return 0;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? r : 0;
    };
    const hero = measure(heroEl);
    const footer = measure(footerEl);
    return {
      top: hero ? Math.max(0, hero.bottom - host.top) + MARGIN : 0,
      bottom: footer ? Math.max(0, host.bottom - footer.top) + MARGIN : 0,
    };
  }

  /** The rectangle the graph is allowed to occupy, in canvas pixels. */
  function safeArea() {
    const host = canvasHost.getBoundingClientRect();
    const insets = chromeInsets();
    // Never let the chrome claim so much that there is nothing left to draw in;
    // a very short window keeps a usable band in the middle.
    const height = Math.max(host.height * 0.45, host.height - insets.top - insets.bottom);
    const top = Math.min(insets.top, Math.max(0, host.height - height));
    return { width: host.width, height, top, hostHeight: host.height };
  }

  /**
   * Camera y shift, in framed graph units, that puts the middle of the drawing in
   * the middle of the space the chrome leaves free rather than the middle of the
   * window.
   *
   * Converted through viewportToFramedGraph rather than derived from the ratio,
   * because that mapping already accounts for the current zoom and for Sigma's
   * own framing of the graph into a unit square.
   */
  function cameraOffsetY(targetRatio = null) {
    const area = safeArea();
    const deltaPx = (area.top + area.height / 2) - area.hostHeight / 2;
    if (!deltaPx) return 0;
    const from = renderer.viewportToFramedGraph({ x: 0, y: 0 });
    const to = renderer.viewportToFramedGraph({ x: 0, y: 100 });
    let perPixel = (to.y - from.y) / 100;
    if (!Number.isFinite(perPixel) || !perPixel) return 0;
    // The mapping above describes the CURRENT zoom, but callers apply this shift
    // in the same setState as a new ratio. Framed units per pixel scale with the
    // ratio, so without this the shift was computed at the wrong zoom and
    // overshot -- by half again as much on a short window.
    const current = renderer.getCamera().getState().ratio || 1;
    if (targetRatio && Number.isFinite(targetRatio) && current) {
      perPixel *= targetRatio / current;
    }
    // Moving the camera's centre UP in framed space moves the drawing DOWN on
    // screen, hence the negation.
    return -deltaPx * perPixel;
  }

  /**
   * The ratio at which a view counts as "fitted".
   *
   * Deliberately NOT loosened to make the whole drawing fit the band between the
   * hero and the footer, which was the obvious next move and measured worse:
   * zooming out to clear the chrome pulls the nodes closer together, so labels
   * start colliding with EACH OTHER instead. On a 1440x900 window that traded 2
   * hidden names for 5. The graph is centred in the band instead, and the few
   * names that still land under the chrome are dropped by updateLabelBlocking().
   */
  function fitRatio() {
    return FRAMED_RATIO;
  }

  function framedRatio() {
    // The FULL canvas, deliberately, not the band the chrome leaves free.
    // Measuring the band here was the obvious move and it was wrong: framingRatio
    // reads a smaller usable area as "fitting would not be legible" and zooms in
    // on a region instead, which cut the opening view from 17 nodes on screen to
    // 8. Nodes visible matters more than names hidden. The band is used for
    // CENTRING (see cameraOffsetY), so the drawing sits in the clear space
    // without being shrunk into it.
    const rect = canvasHost.getBoundingClientRect();
    return framingRatio({
      extent: state.layoutExtent,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      // Selection grows a node by a quarter (see reduceNode), so frame for the
      // biggest a node can ever be drawn, not its resting size.
      maxNodeSize: LARGEST_NODE_SIZE * state.sizeScale * HIGHLIGHT_GROWTH,
      baseRatio: fitRatio(),
    });
  }

  // Node radii are screen pixels, so how close nodes look depends on the
  // window as much as on the node count. Recomputed per view AND on resize.
  function applySizeScale(visibleCount = state.view ? state.view.nodes.length : 0) {
    // Full canvas, for the same reason as framedRatio: sizing to the band shrank
    // nodes and pulled their labels closer together.
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
      // Role is computed against the CURRENT anchor, which is why it is computed
      // here and re-computed on every travel rather than once at load: centring
      // on Dillinger makes Ben Weinman a founder, centring on Suicidal
      // Tendencies makes the same node a member. It reads master.links, not
      // view.links, so a role is not decided by which memberships happen to have
      // survived the neighbourhood budget.
      const role = roleForNode(masterById.get(node.id) || node, {
        anchorId,
        links: master.links,
      });
      viewGraph.addNode(node.id, {
        label: node.id,
        x: point.x,
        y: point.y,
        hop: point.hop,
        kind,
        role,
        // The shape channel. Sigma picks the node program off `type`, and it is
        // set here rather than in reduceNode because a program change is a
        // different draw call, not a per-frame style tweak.
        //
        // The home star is forced plain. Its visual identity is the DOM ringed-star
        // overlay and the WebGL node beneath it is deliberately tiny and
        // label-free; giving that a ring of its own would put two different rings
        // on one node at two different radii.
        type: kind === NODE_KINDS.HOME_STAR ? NODE_TYPES.SOLID : nodeTypeForRole(role),
        entityType: node.type,
        size: style.size,
        color: style.color,
      });
    });
    view.links.forEach(link => {
      const [source, target] = linkEndpoints(link);
      if (!viewGraph.hasNode(source) || !viewGraph.hasNode(target)) return;
      if (viewGraph.hasEdge(source, target)) return;
      // weight rides along because the role is derived from it, and because an
      // edge that has lost its weight cannot be re-classified later.
      viewGraph.addEdge(source, target, {
        size: 1,
        relation: link.relation || 'member',
        weight: Number(link.weight || 1),
        role: roleFromMembership(link),
      });
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
    } else if (ratio >= fitRatio() - 1e-6) {
      // Centred in the space the chrome leaves free, not in the window: framing
      // to the window put the top of the drawing under the wordmark.
      renderer.getCamera().setState({ x: 0.5, y: 0.5 + cameraOffsetY(ratio), ratio, angle: 0 });
      positionOverlays();
    } else {
      flyTo(anchorId, { animate: false, ratio });
    }
    return true;
  }

  // The busiest node among `ids` -- the most useful place to land in a
  // narrowed graph, whether that narrowing came from a filter or from
  // jumping into a disconnected group. Shared by setGraph() and the
  // "Show next group" handler so there is one definition of "busiest".
  function highestDegreeNode(ids) {
    let best = null;
    let bestDegree = -1;
    ids.forEach(id => {
      const neighbours = adjacency.get(id);
      // buildAdjacency stores a Set per node, so this is .size -- reading
      // .length gave undefined, every comparison was false, and no anchor was
      // ever chosen, so a filtered graph silently did nothing.
      const degree = neighbours ? neighbours.size : 0;
      if (degree > bestDegree) { best = id; bestDegree = degree; }
    });
    return best;
  }

  // A stable identity for a component that does not depend on traversal
  // order -- the same disconnected group produces the same key every time
  // it is recomputed, so "already shown this filter" can be tracked by key
  // rather than by object identity.
  function componentKey(ids) {
    return ids.length ? ids.slice().sort()[0] : '';
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
    // Disabled rather than hidden: a shortcut row that changes length as you
    // explore makes the others move under the pointer.
    expandBtn.disabled = !remaining;
    expandBtn.setAttribute('aria-disabled', String(!remaining));

    // "Expand" only ever finds more of the anchor's own component. A filtered
    // scene can leave other bands with no shared members with it at all --
    // invisible forever, no matter how far this expands -- so that has to be
    // said explicitly rather than left for "frontier: none" to imply falsely
    // that the view is complete.
    const currentComponent = components.find(ids => ids.includes(state.anchorId));
    const currentKey = currentComponent ? componentKey(currentComponent) : null;
    if (currentKey) state.visitedComponentKeys.add(currentKey);
    let otherComponents = currentKey ? components.filter(ids => componentKey(ids) !== currentKey) : [];
    if (otherComponents.length) {
      let unvisited = otherComponents.filter(ids => !state.visitedComponentKeys.has(componentKey(ids)));
      if (!unvisited.length) {
        // Toured every other group already -- start the loop over rather than
        // going quiet once the tour is done.
        state.visitedComponentKeys = new Set([currentKey]);
        unvisited = otherComponents;
      }
      unvisited = unvisited.slice().sort((a, b) => b.length - a.length);
      const nextGroup = unvisited[0];
      state.nextGroupAnchor = highestDegreeNode(nextGroup);

      const otherNodeCount = otherComponents.reduce((sum, ids) => sum + ids.length, 0);
      const otherGroupCount = otherComponents.length;
      otherGroupsTextEl.textContent =
        `${otherNodeCount} more ${otherNodeCount === 1 ? 'node' : 'nodes'} in ` +
        `${otherGroupCount} separate ${otherGroupCount === 1 ? 'group' : 'groups'} — ` +
        `no shared members with what's on screen.`;
      otherGroupsBtn.textContent = otherGroupCount === 1 ? 'Show that group' : 'Show next group';
      otherGroupsEl.hidden = false;
    } else {
      state.nextGroupAnchor = null;
      otherGroupsEl.hidden = true;
    }

    if (homeStarId) {
      homeLabelEl.textContent =
        homeStarId === state.anchorId ? `${homeStarId} — you are here` : homeStarId;
    }

    // His introduction while the view is centred on him, the generic explainer
    // once the visitor has gone somewhere of their own choosing. Keyed on the
    // anchor rather than on "first visit" so it also comes back with Reset,
    // which is the other way to end up on his node.
    if (hintEl) {
      const onHomeStar = Boolean(homeStarId) && homeStarId === state.anchorId;
      hintEl.innerHTML = onHomeStar ? introCopy(homeStarId) : EXPLORE_COPY;
    }
    positionOverlays();

    stage.dispatchEvent(new CustomEvent('rbft:sigma-view', {
      bubbles: true,
      detail: { anchorId: state.anchorId, nodes: state.view.nodes.length },
    }));
    // NOT syncAddressBar() -- see below. The address bar is written once, for the
    // view the visitor opened with, and then left alone: a refresh should return
    // you to where you came in, not to the last node you happened to click.
    // Share builds its link from the live view instead (see shareableUrl).
    // The footer's text just changed, and a longer context line makes it taller.
    // That moves the zone labels are measured against, so the blocking has to be
    // recomputed here as well as per frame -- Sigma does not draw a frame when
    // only the DOM chrome moved, so waiting for afterRender left a label sitting
    // across the footer with nothing to correct it.
    updateLabelBlocking();

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

  /**
   * Keeps the address bar pointing at the current view.
   *
   * Three things depend on it: copying the URL out of the bar, reloading without
   * losing your place, and Share -- which reads the query string to build the
   * link it hands to someone else. replaceState rather than pushState, so
   * exploring does not bury the visitor's previous page under a hundred history
   * entries; travel is not navigation.
   */
  // Called ONCE, after the opening view is drawn, to canonicalise the link the
  // visitor arrived on -- ?band= / ?member= / ?node= / ?person= all collapse to a
  // single ?anchor=. It is deliberately not called again: travelling used to
  // rewrite the URL, which made a refresh reopen the last node clicked and left
  // no way back to the start short of pressing Reset. Aaron is the opening view
  // again, and the ringed star is his alone.
  function syncAddressBar() {
    if (!win || !win.history || typeof win.history.replaceState !== 'function') return;
    try {
      const url = new URL(win.location.href);
      // One canonical parameter for the anchor. The other accepted spellings
      // (?band=, ?member=, ?node=, ?person=) are inbound-only, and are cleared
      // so a stale one cannot contradict the view being shown.
      const INBOUND_ANCHOR_KEYS = ['band', 'member', 'node', 'person', 'anchor'];
      // Only a visitor who arrived on a link that named a node gets a canonical
      // ?anchor= written back. A plain visit to / stays / : Aaron is the opening
      // view because he is the home star, not because the visitor asked for him,
      // and stamping his name into the address bar made the site's own front
      // door look like a deep link to one musician (and got copied around as
      // one). Shared links such as /?anchor=KISS are still canonicalised and
      // preserved, so Share, reload-in-place and the previews keep working.
      const arrivedAnchored = INBOUND_ANCHOR_KEYS.some(key => url.searchParams.has(key));
      ['band', 'member', 'node', 'person'].forEach(key => url.searchParams.delete(key));
      if (arrivedAnchored) {
        url.searchParams.set('anchor', state.anchorId);
      } else {
        url.searchParams.delete('anchor');
      }
      win.history.replaceState(win.history.state, '', url);
    } catch (error) {
      // A malformed or opaque location is not worth breaking exploration over.
    }
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
    const nextRatio = ratio || camera.getState().ratio || 1;
    const next = {
      x: display.x,
      // Same shift: centring on a node means centring it in the free band, not
      // behind the wordmark.
      y: display.y + cameraOffsetY(nextRatio),
      ratio: nextRatio,
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
        return null;
      }
      const point = renderer.graphToViewport({
        x: viewGraph.getNodeAttribute(id, 'x'),
        y: viewGraph.getNodeAttribute(id, 'y'),
      });
      el.hidden = false;
      el.style.left = `${point.x}px`;
      el.style.top = `${point.y}px`;
      el.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      return point;
    };

    /**
     * Puts a label just outside the overlay it names, in unscaled screen space.
     *
     * GAP is measured from the overlay's drawn edge rather than from its centre,
     * so the name sits the same short distance from the star whether the camera
     * is zoomed in on a phone or framing the whole neighbourhood.
     */
    const placeLabel = (labelEl, point, overlayEl, scale, above) => {
      if (!point || !labelEl.textContent) {
        labelEl.hidden = true;
        return;
      }
      const GAP = 7;
      const radius = (overlayEl.offsetHeight * scale) / 2;
      labelEl.hidden = false;
      labelEl.style.left = `${point.x}px`;
      labelEl.style.top = above
        ? `${point.y - radius - GAP - labelEl.offsetHeight}px`
        : `${point.y + radius + GAP}px`;
    };

    const zoomScale = Math.max(0.55, Math.min(1.9, 1 / ratio));
    const homeScale = zoomScale * HOME_STAR_STYLE.sizeMultiplier * 0.5;
    const homePoint = place(homeStarEl, homeStarId, homeScale);
    // The ring marks a node the visitor CLICKED, not merely the node the view
    // happens to be centred on.
    //
    // Anchored to state.anchorId it appeared without anyone asking: on a shared
    // link (the way most visitors arrive), after a search, and after a filter
    // displaced the anchor. That put two ringed, glowing objects on screen in the
    // same visual language -- Aaron's Saturn star and this -- both saying "look
    // here", and neither of them clicked. On page load Aaron should be the only
    // node wearing the rings.
    //
    // state.selection is the right signal because it is set ONLY by
    // highlightFrom, which runs when a node is clicked, and cleared by
    // clearHighlight -- which every non-click path already calls: first paint,
    // explore/search, a filter change, Reset, and a click on empty space.
    const clickedId = state.selection ? state.selection.id : null;
    const focusPoint = place(
      focusRingEl,
      clickedId && clickedId !== homeStarId ? clickedId : null,
      zoomScale
    );

    // Aaron is often one hop from whatever a visitor searched for, which put his
    // name and the focus label on top of each other. Flip his above the star
    // when the two overlays are close.
    const crowded =
      !!homePoint &&
      !!focusPoint &&
      Math.hypot(homePoint.x - focusPoint.x, homePoint.y - focusPoint.y) < 120;
    // Only the home star is labelled. The focus ring used to carry the anchor's
    // name too, which printed it twice -- Sigma already draws that node's label,
    // and the footer says "Centered on ..." as well.
    placeLabel(homeLabelEl, homePoint, homeStarEl, homeScale, crowded);
  }

  // One canvas context, reused, for measuring label widths.
  const labelMetrics = doc.createElement('canvas').getContext('2d');

  /**
   * Works out which node labels would be drawn across the chrome, and asks for a
   * refresh when that set changes.
   *
   * Measured for EVERY labelled node rather than for the labels Sigma currently
   * displays: suppressing a label removes it from the displayed set, so reading
   * that set would make the answer depend on the previous frame and oscillate.
   * Geometry does not move when a label is hidden, so this is stable.
   *
   * Boxes are reconstructed the way Sigma draws them: x + size + 3, baseline at
   * y + labelSize/3.
   */
  function updateLabelBlocking() {
    const zones = [];
    // Relative to the CANVAS, not the stage. graphToViewport returns coordinates
    // in the renderer's own container, and the stage wrapper sits ~280px down the
    // page inside .graph-stage -- converting the chrome into stage space shifted
    // every zone by that much, so the zones sat where nothing was drawn (one had
    // a negative top) and labels printed across the footer unchallenged.
    const originBox = canvasHost.getBoundingClientRect();
    const addZone = el => {
      if (!el || el.hidden) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      zones.push({
        left: r.left - originBox.left,
        right: r.right - originBox.left,
        top: r.top - originBox.top,
        bottom: r.bottom - originBox.top,
      });
    };
    addZone(heroEl);
    addZone(footerEl);
    addZone(homeLabelEl);
    // The node card is docked over the constellation while it is open, so it is
    // chrome for as long as it is up. Without this a name could hide underneath
    // it and look culled for no reason -- the same fault as the hero and footer,
    // just with a box that comes and goes.
    if (nodeCardEl && !nodeCardEl.hidden && nodeCardEl.classList.contains('is-open')) {
      addZone(nodeCardEl);
    }

    const size = renderer.getSetting('labelSize') || 12;
    labelMetrics.font = `${renderer.getSetting('labelWeight') || 'normal'} ${size}px `
      + `${renderer.getSetting('labelFont') || 'sans-serif'}`;

    const hits = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;

    const candidates = [];
    viewGraph.forEachNode((id, attrs) => {
      if (!attrs.label) return;
      const display = renderer.getNodeDisplayData(id);
      if (!display) return;
      const point = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
      const left = point.x + display.size + 3;
      candidates.push({
        id,
        size: display.size,
        box: {
          left,
          right: left + labelMetrics.measureText(attrs.label).width,
          top: point.y + size / 3 - size * 0.78,
          bottom: point.y + size / 3 + size * 0.24,
        },
      });
    });

    // Bigger nodes keep their names when two would collide -- bands outrank
    // touring members -- and the id breaks ties so the same view always resolves
    // the same way rather than flickering between two equally good answers.
    candidates.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));

    const blocked = new Set();
    const placed = [];
    candidates.forEach(candidate => {
      // Chrome first: no label may print across the wordmark, field or footer.
      if (zones.some(zone => hits(candidate.box, zone))) {
        blocked.add(candidate.id);
        return;
      }
      // A selected node always keeps its name: it is the thing being read.
      const selected = state.selection && state.selection.id === candidate.id;
      if (!selected && placed.some(box => hits(candidate.box, box))) {
        blocked.add(candidate.id);
        return;
      }
      placed.push(candidate.box);
    });

    const changed =
      blocked.size !== state.labelBlocked.size ||
      [...blocked].some(id => !state.labelBlocked.has(id));
    if (!changed) return;
    state.labelBlocked = blocked;
    // refresh() re-runs the reducers, which is what applies the suppression.
    // skipIndexation because nothing about the graph's structure changed.
    renderer.refresh({ skipIndexation: true });
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
      // Terse on purpose: the "No Rawk Found" panel makes the offer to add the
      // band, and two copies of the same sentence on one screen read as a fault.
      contextEl.innerHTML =
        `No match for <strong>${escapeHtml(rawQuery)}</strong> in the tree yet.`;
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

  /**
   * Travels to a node: it becomes the centre of a fresh neighbourhood, and stays
   * highlighted so the connections that brought you there still read.
   *
   * This is what makes the graph feel like a place rather than a picture. Mike
   * McCready sits 6 degrees from Aaron and Pearl Jam sits 7, so reaching Pearl
   * Jam by expanding would mean pulling in hundreds of nodes to show one band;
   * travelling to Mike puts it one hop away. Clicking is how you cross the
   * galaxy, one star at a time.
   */
  function travelTo(node) {
    if (!node) return;
    // Clicking the current centre is not travel -- just re-assert the highlight,
    // so a second click on the anchor does not re-render the same view.
    if (node === state.anchorId) {
      highlightFrom(node);
      return;
    }
    state.anchorSource = 'requested';
    state.maxHops = NEIGHBORHOOD_BUDGET.MAX_HOPS;
    const moved = renderNeighborhood({
      anchorId: node,
      maxNodes: NEIGHBORHOOD_BUDGET.MAX_NODES,
    });
    // renderNeighborhood clears the highlight as part of drawing a new view;
    // re-applying it after the fact is what keeps the clicked node lit on
    // arrival, which is the difference between travelling and being teleported.
    // Travel is announced BEFORE the highlight, and the order is the whole bug:
    // the page closes any open card on travel, because the view that card
    // described is gone. Highlighting dispatches rbft:sigma-select, which opens
    // the card for the clicked node -- so announcing travel afterwards closed the
    // card that had just been opened, and only a SECOND click (which is not
    // travel, so it only re-highlights) could make it stick. Stale card closes
    // first, new card opens second.
    stage.dispatchEvent(
      new CustomEvent('rbft:sigma-travel', { bubbles: true, detail: { anchorId: node } })
    );
    if (moved) highlightFrom(node);
  }

  renderer.on('clickNode', ({ node }) => travelTo(node));
  // Kept so a double click is not read as two separate journeys.
  renderer.on('doubleClickNode', ({ node }) => travelTo(node));
  renderer.on('clickStage', () => clearHighlight());
  // afterRender fires once per painted frame, with the camera in its final
  // state for that frame -- the only place the DOM home-star overlay can be
  // kept exactly on top of its WebGL node during pans, zooms and animated
  // camera flights.
  renderer.on('afterRender', () => {
    positionOverlays();
    updateLabelBlocking();
    updateParallax();
  });

  renderer.on('resize', () => {
    applySizeScale();
    // The pill row rewraps on a narrow window, which moves the trigger.
    positionFilters();
  });

  // Any reflow of the chrome moves the zones labels are measured against.
  const chromeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => updateLabelBlocking())
    : null;
  if (chromeObserver) {
    [heroEl, footerEl, homeLabelEl, nodeCardEl].forEach(el => { if (el) chromeObserver.observe(el); });
  }

  // Closing the card is a class change, not a resize, so the size observer above
  // can miss it and leave a zone standing where there is no longer a card.
  const cardStateObserver = nodeCardEl && typeof MutationObserver === 'function'
    ? new MutationObserver(() => updateLabelBlocking())
    : null;
  if (cardStateObserver) {
    cardStateObserver.observe(nodeCardEl, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    exploreFor(input.value);
  });
  // -- shortcut row ---------------------------------------------------------

  /**
   * Returns the constellation to its opening state: the default anchor at the
   * centre, budgets back to the opening view. "Reset" on its own is ambiguous,
   * which is exactly why the pill carries a sentence.
   */
  function goHome() {
    state.maxHops = NEIGHBORHOOD_BUDGET.MAX_HOPS;
    state.anchorSource = 'default';
    clearHighlight();
    // The view they OPENED with, which is not necessarily the default anchor.
    // Most visitors arrive on a link shared by another user, so for them
    // "start over" means the band in that link -- sending them to the project's
    // default anchor instead would drop them somewhere they have never been.
    const home = state.openingAnchorId || homeStarId || NEIGHBORHOOD_BUDGET.DEFAULT_ANCHOR;
    renderNeighborhood({
      anchorId: home,
      maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
      animate: true,
    });
  }

  /**
   * Positions the shared popover under a pill, clamped to stay on screen -- the
   * end pills of a centred row would otherwise push it off the edge.
   */
  function showTip(button) {
    const item = STAGE_ACTIONS.find(entry => entry.key === button.dataset.key);
    if (!item) return;
    tip.textContent = item.detail;
    tip.hidden = false;
    const stageBox = stage.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const width = tip.offsetWidth;
    const margin = 10;
    let left = box.left - stageBox.left + box.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, stageBox.width - width - margin));
    tip.style.left = `${left}px`;
    tip.style.top = `${box.bottom - stageBox.top + 8}px`;
    button.setAttribute('aria-expanded', 'true');
  }

  // Under the Filter pill, clamped inside the stage. Measured after the panel is
  // visible, because a hidden element has no width to centre.
  function positionFilters() {
    const button = actionButtons.get('filter');
    if (!button || !filterPanel || filterPanel.hidden) return;
    const stageBox = stage.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const width = filterPanel.offsetWidth;
    const margin = 10;
    let left = box.left - stageBox.left + box.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, stageBox.width - width - margin));
    filterPanel.style.left = `${left}px`;
    filterPanel.style.top = `${box.bottom - stageBox.top + 10}px`;
  }

  function hideTip() {
    tip.hidden = true;
    actionButtons.forEach(button => button.removeAttribute('aria-expanded'));
  }

  /**
   * Opens or closes the filter panel, and keeps the pill's state dot honest.
   */
  function toggleFilters(force = null) {
    const open = force === null ? filterPanel.hidden : force;
    filterPanel.hidden = !open;
    const pill = actionButtons.get('filter');
    if (pill) pill.setAttribute('aria-expanded', String(open));
    if (open) {
      syncFilterState();
      positionFilters();
    }
  }

  /**
   * Reflects the page's filter state in the panel and on the pill.
   *
   * Read from the page rather than tracked here: the same filters can be changed
   * from the SVG renderer's own controls, from Reset view, or by a country chip,
   * and a second copy of that state would drift.
   */
  function syncFilterState() {
    const recentChip = doc.querySelector('.tool-chip[data-action="recent"]');
    const recentOn = recentChip ? recentChip.getAttribute('aria-pressed') === 'true' : false;
    const recentBtn = filterPanel.querySelector('[data-filter-action="recent"]');
    if (recentBtn) {
      recentBtn.setAttribute('aria-pressed', String(recentOn));
      // The page disables Recently-added when the data carries no timestamps.
      recentBtn.disabled = !recentChip || recentChip.disabled;
    }
    const scene = doc.querySelector('#scene-filter');
    const genre = doc.querySelector('#genre-filter');
    const active =
      recentOn ||
      (scene && scene.value && scene.value !== 'all') ||
      (genre && genre.value && genre.value !== 'all');
    const pill = actionButtons.get('filter');
    if (pill) pill.setAttribute('data-active', String(Boolean(active)));
  }

  filterPanel.addEventListener('click', event => {
    const button = event.target.closest('[data-filter-action]');
    if (!button) return;
    // The page closes its popovers on any outside click; this panel is outside
    // them, so the press must not travel (same trap as the pills).
    event.stopPropagation();
    const action = button.dataset.filterAction;
    if (action === 'close') return toggleFilters(false);
    // Recently-added and Clear press the page's own chips, so the behaviour and
    // the mutual exclusions stay in one place.
    const selector = action === 'recent'
      ? '.tool-chip[data-action="recent"]'
      : '.tool-chip[data-action="clear"]';
    const chip = doc.querySelector(selector);
    if (chip) chip.click();
    syncFilterState();
  });
  // A change to either select re-filters through the page's own handler; this
  // only needs to catch up the pill's dot.
  filterPanel.addEventListener('change', () => syncFilterState());

  /** Runs a pill's action: a Sigma function, or the page's own button. */
  function runAction(item) {
    if (item.action === 'expand') return expand();
    if (item.action === 'home') return goHome();
    if (item.action === 'filters') return toggleFilters();
    if (!item.target) return;
    const target = doc.querySelector(item.target);
    if (target) target.click();
  }

  actionButtons.forEach((button, key) => {
    const item = STAGE_ACTIONS.find(entry => entry.key === key);
    if (!item) return;
    // Hover and keyboard focus reveal the explanation; a tap runs the action, so
    // touch users get the sentence from the pill they are already pressing --
    // pointerdown shows it, and it stays up briefly after the action fires.
    button.addEventListener('pointerenter', () => { if (!button.disabled) showTip(button); });
    button.addEventListener('pointerleave', hideTip);
    button.addEventListener('focus', () => showTip(button));
    button.addEventListener('blur', hideTip);
    button.addEventListener('click', event => {
      // stopPropagation is load-bearing. The page closes its popovers on any
      // click outside them; without this, the pill's own click carried on
      // bubbling to that handler and shut the panel in the same tick it opened,
      // so Add / Share / Feedback appeared to do nothing at all.
      event.stopPropagation();
      hideTip();
      runAction(item);
    });
  });

  // Jumps to the busiest node of another disconnected group in this filter.
  // Reuses the exact same anchor-and-BFS render path a node click uses --
  // rendering every group at once is the bigger change this defers.
  otherGroupsBtn.addEventListener('click', () => {
    if (!state.nextGroupAnchor) return;
    renderNeighborhood({
      anchorId: state.nextGroupAnchor,
      maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
      animate: true,
    });
  });

  // Escape closes the popover, and so does a press anywhere else -- without
  // this, a tap-opened popover on a phone has no way out.
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    hideTip();
    toggleFilters(false);
  });
  doc.addEventListener('pointerdown', event => {
    if (!actionRow.contains(event.target)) hideTip();
    if (!actionRow.contains(event.target) && !filterPanel.contains(event.target)) {
      toggleFilters(false);
    }
  });

  /**
   * Hides pills whose page-side control is not available -- Sign in, once the
   * visitor is signed in. Watched rather than read once, because signing in
   * happens without a reload.
   */
  function syncActionAvailability() {
    STAGE_ACTIONS.filter(item => item.hideWhenSignedIn).forEach(item => {
      const button = actionButtons.get(item.key);
      const target = item.target ? doc.querySelector(item.target) : null;
      // offsetParent is null for a control the page has hidden.
      const available = !!target && (!!target.offsetParent || target.getClientRects().length > 0);
      if (button) button.hidden = !available;
    });
  }

  syncActionAvailability();
  const authObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(syncActionAvailability)
    : null;
  if (authObserver) {
    const header = doc.querySelector('.site-header');
    if (header) authObserver.observe(header, { attributes: true, subtree: true, childList: true });
  }

  /**
   * Replaces the graph being explored -- the page calls this every time a filter
   * changes, with the same filtered {nodes, links} the SVG renderer draws.
   *
   * The anchor is preserved when it survives the filter, because a filter should
   * narrow what you are looking at rather than move you somewhere else. When it
   * does not survive, the default anchor is tried, then the most connected node
   * left, so a filtered view still opens somewhere meaningful instead of nowhere.
   */
  function setGraph(next) {
    if (!next || !Array.isArray(next.nodes)) return false;
    if (!next.nodes.length) {
      // An empty result is a real outcome of a narrow filter, not a failure.
      contextEl.textContent = 'No bands match these filters.';
      frontierEl.textContent = '';
      otherGroupsEl.hidden = true;
      viewGraph.clear();
      renderer.refresh();
      state.view = { nodes: [], links: [], frontier: [], depths: new Map() };
      return true;
    }

    master = next;
    adjacency = buildAdjacency(master.nodes, master.links);
    masterById = new Map(master.nodes.map(node => [node.id, node]));
    bandNames = master.nodes.filter(node => node.type === 'band').map(node => node.id);
    components = getConnectedComponents(master.nodes, master.links, adjacency);
    // A new filter is a new graph -- which groups have already been shown by
    // "Show next group" resets with it.
    state.visitedComponentKeys = new Set();

    let anchorId = masterById.has(state.anchorId) ? state.anchorId : null;

    // A filter that excludes where you were standing moves you somewhere else,
    // which is unavoidable -- but clearing it should put you back rather than
    // leaving you on a node you never chose. The displaced anchor is remembered
    // for exactly that.
    if (!anchorId && !state.displacedAnchorId) state.displacedAnchorId = state.anchorId;
    if (anchorId && state.displacedAnchorId && masterById.has(state.displacedAnchorId)) {
      anchorId = state.displacedAnchorId;
      state.displacedAnchorId = null;
    }

    if (!anchorId && masterById.has(NEIGHBORHOOD_BUDGET.DEFAULT_ANCHOR)) {
      anchorId = NEIGHBORHOOD_BUDGET.DEFAULT_ANCHOR;
    }
    // Most connected survivor: the busiest node is the most useful place to
    // land in a narrowed graph.
    if (!anchorId) anchorId = highestDegreeNode(master.nodes.map(node => node.id));
    if (!anchorId) return false;

    state.maxHops = NEIGHBORHOOD_BUDGET.MAX_HOPS;
    clearHighlight();
    return renderNeighborhood({
      anchorId,
      maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
      animate: false,
    });
  }

  // -- first paint ----------------------------------------------------------

  const resolved = resolveAnchor({ search, nodes: master.nodes, links: master.links, adjacency });
  state.anchorSource = resolved.source;
  if (!resolved.anchorId) return null;
  state.openingAnchorId = resolved.anchorId;
  renderNeighborhood({
    anchorId: resolved.anchorId,
    maxNodes: NEIGHBORHOOD_BUDGET.OPENING_MAX_NODES,
    animate: false,
  });
  // The one and only write: canonicalise the link this visit arrived on. From
  // here the address bar stays put, so a refresh returns to this view.
  syncAddressBar();

  // A link asked for a band we do not have. Say so, rather than opening on the
  // fallback as though nothing was requested -- the recipient of a stale shared
  // link would otherwise land on a stranger's node with no way to tell they had
  // been sent somewhere specific. Reuses the same prompt a failed search raises,
  // which already offers to add the missing band.
  if (resolved.requestedByLink) {
    stage.dispatchEvent(
      new CustomEvent('rbft:sigma-search-miss', {
        bubbles: true,
        detail: { query: resolved.requestedByLink, fromLink: true },
      })
    );
  }

  return {
    stage,
    renderer,
    canonical,
    state,
    exploreFor,
    travelTo,
    setGraph,
    expand,
    flyTo,
    highlightFrom,
    clearHighlight,
    destroy() {
      renderer.kill();
      if (authObserver) authObserver.disconnect();
      if (chromeObserver) chromeObserver.disconnect();
      if (cardStateObserver) cardStateObserver.disconnect();
      // Panels go home before the stage is dropped, or they would be removed
      // with it and the SVG renderer would come back without them.
      relocated.forEach(({ panel, parent, next }) => {
        panel.hidden = true;
        parent.insertBefore(panel, next);
      });
      stage.remove();
      // Hand the page's own toolbar, hero and badge back, so switching the flag
      // off at runtime leaves a working SVG renderer rather than a bare page.
      doc.body.classList.remove(BODY_ACTIVE_CLASS);
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
    win.RBFT_SIGMA = initSigmaExplorer({ master, search: win.location.search, win });
    return Boolean(win.RBFT_SIGMA);
  };
  if (!start()) win.addEventListener('rbft:graph-ready', start, { once: true });
}

bootFromPage();
