// One-shot generator for the site's static Open Graph fallback image
// (og-image.png, 1200x630). Committed to the repo so it is served as a
// static file and referenced from <meta property="og:image">.
//
// WHEN THIS IMAGE IS THE ONE PEOPLE SEE
//
// Shared links that name a node (/?anchor=KISS) are unfurled with the live
// per-anchor card drawn by netlify/functions/og_image.mjs. This static file is
// the fallback for everything else: the bare site URL, and any request where
// the live card fails. So it must be generic and it must be on-brand.
//
// WHY THIS WAS REWRITTEN
//
// The previous version rendered RBFT_logo_3.png -- four guitar picks reading
// "RBFT" over the words "Rock Band Family Tree" -- through Playwright. The site
// was renamed to Six Degrees of Rock, so every share of the front door was
// still unfurling under the retired name and the retired logo.
//
// It is now drawn with pureimage instead of Playwright + Chromium:
//   - pureimage is already a runtime dependency, and is what the live per-anchor
//     card uses, so the static fallback and the dynamic card share a font, a
//     palette and a layout language instead of drifting apart.
//   - no browser binary to download, so this regenerates anywhere, including in
//     CI, which is what let the old image go stale in the first place.
//
// Run with: node scripts/generate-og-image.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import * as PImage from 'pureimage';

const OUT = resolve('og-image.png');

// 1200x630 is the shape every unfurler crops to.
const WIDTH = 1200;
const HEIGHT = 630;

// Same palette as netlify/functions/og_image.mjs, so a feed showing both a
// generic share and an anchored one reads as one product.
const COLORS = {
  background: '#070b10',
  edge: 'rgba(161,204,228,0.34)',
  band: '#8fe8f6',
  member: '#c9b6f0',
  anchor: '#ffc978',
  wordmark: '#e9eef6',
  tagline: 'rgba(184,202,220,0.92)',
  footer: '#cfe6f5',
  strip: '#0a1016',
};

const HOST = 'bandmembers.netlify.app';
const TAGLINE = 'Explore how bands and musicians connect across scenes and decades.';

const FONT_FAMILY = 'OgSans';
const FONT_PATH = resolve('vendor/fonts/og/Lato-Medium.ttf');

function ensureFont() {
  if (!existsSync(FONT_PATH)) {
    console.error(`Missing font at ${FONT_PATH} — aborting.`);
    process.exit(1);
  }
  // registerFont wants a path it can read freely; /tmp keeps pureimage away
  // from anything read-only, matching the live card's approach.
  const scratch = join(tmpdir(), 'sdor-og-font.ttf');
  if (!existsSync(scratch)) writeFileSync(scratch, readFileSync(FONT_PATH));
  PImage.registerFont(scratch, FONT_FAMILY).loadSync();
}

// A fixed decorative constellation. Hand-placed rather than generated from live
// data: this image is committed, so it must render identically on every run, and
// a generic card should not imply that these particular six nodes matter.
// Coordinates are in card space, sitting in the lower band of the card where
// there is no text.
const STARS = [
  { x: 190, y: 470, r: 9, kind: 'band' },
  { x: 330, y: 402, r: 6, kind: 'member' },
  { x: 470, y: 486, r: 13, kind: 'anchor' },
  { x: 616, y: 396, r: 6, kind: 'member' },
  { x: 742, y: 478, r: 9, kind: 'band' },
  { x: 886, y: 410, r: 6, kind: 'member' },
  { x: 1014, y: 480, r: 9, kind: 'band' },
];
// Six edges: the six degrees the name promises, drawn as one path across the
// card so the picture states the premise without needing a caption.
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]];

function draw() {
  const img = PImage.make(WIDTH, HEIGHT);
  const ctx = img.getContext('2d');

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Edges first so the dots sit on top of their own connections.
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 2;
  EDGES.forEach(([a, b]) => {
    ctx.beginPath();
    ctx.moveTo(STARS[a].x, STARS[a].y);
    ctx.lineTo(STARS[b].x, STARS[b].y);
    ctx.stroke();
  });

  STARS.forEach(star => {
    ctx.fillStyle = COLORS[star.kind];
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  });

  // Wordmark and tagline, on the same left margin as the live card's.
  ctx.fillStyle = COLORS.wordmark;
  ctx.font = `54pt ${FONT_FAMILY}`;
  ctx.fillText('SIX DEGREES OF ROCK', 90, 220);

  ctx.fillStyle = COLORS.tagline;
  ctx.font = `21pt ${FONT_FAMILY}`;
  ctx.fillText(TAGLINE, 90, 285);

  // Footer strip, identical treatment to the live card.
  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  ctx.fillStyle = COLORS.footer;
  ctx.font = `16pt ${FONT_FAMILY}`;
  ctx.fillText(HOST, 90, stripTop + 39);

  return img;
}

async function main() {
  ensureFont();
  const img = draw();
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', chunk => chunks.push(Buffer.from(chunk)));
  await PImage.encodePNGToStream(img, sink);
  const png = Buffer.concat(chunks);
  if (!png.length) {
    console.error('og: encoder produced no bytes — aborting.');
    process.exit(1);
  }
  writeFileSync(OUT, png);
  console.log(`Wrote ${OUT} (${WIDTH}x${HEIGHT}, ${png.length} bytes)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
