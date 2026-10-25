// Draws splash-og.png, the link-preview card for the splash hub (1200x630).
// Mirror of scripts/make-game-og-image.mjs: same dark field, same panel,
// same vendored Lato (vendor/fonts/og/Lato-Medium.ttf).
// The motif is the constellation: gold and blue nodes joined by faint
// edges, under the brand wordmark.
//
// Regenerate:  node scripts/make-splash-og-image.mjs
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as PImage from 'pureimage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1200;
const H = 630;

const BG = '#05080d';
const PANEL = '#0b131c';
const TEXT = '#edf7ff';
const MUTED = '#9fb1c1';
const GOLD = '#ffb454';
const BLUE = '#27b8ff';
const EDGE = 'rgba(161,204,228,0.34)';

const font = PImage.registerFont(join(ROOT, 'vendor/fonts/og/Lato-Medium.ttf'), 'Lato');
font.loadSync();

const img = PImage.make(W, H);
const ctx = img.getContext('2d');

ctx.fillStyle = BG;
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = PANEL;
ctx.fillRect(40, 40, W - 80, H - 80);

function text(str, size, y, color, cx) {
  ctx.fillStyle = color;
  ctx.font = `${size}pt Lato`;
  const w = ctx.measureText(str).width;
  ctx.fillText(str, cx - w / 2, y);
}

text('SIX DEGREES OF ROCK', 72, 210, TEXT, W / 2);
text('Every game and the graph, in one place.', 26, 280, MUTED, W / 2);

// A quiet constellation zigzag: gold band nodes, blue member nodes.
const pts = [
  { x: 240, y: 420, c: GOLD, r: 13 },
  { x: 420, y: 360, c: BLUE, r: 10 },
  { x: 600, y: 440, c: GOLD, r: 13 },
  { x: 780, y: 370, c: BLUE, r: 10 },
  { x: 960, y: 430, c: GOLD, r: 13 },
];
ctx.strokeStyle = EDGE;
ctx.lineWidth = 3;
ctx.beginPath();
pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
ctx.stroke();
pts.forEach((p) => {
  ctx.fillStyle = p.c;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  ctx.fill();
});

ctx.fillStyle = GOLD;
ctx.font = '20pt Lato';
const foot = 'sixdegreesofrock.com';
ctx.fillText(foot, W / 2 - ctx.measureText(foot).width / 2, 560);

const out = createWriteStream(join(ROOT, 'splash-og.png'));
await PImage.encodePNGToStream(img, out);
console.log('wrote splash-og.png');
