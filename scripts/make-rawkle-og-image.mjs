// Draws rawkle-og.png, the link-preview card for /rawkle (1200x630).
// Mirror of scripts/make-game-og-image.mjs: same dark field, same panel,
// same vendored Lato (vendor/fonts/og/Lato-Medium.ttf).
// The motif is the game's own board: one row of tiles in gold, blue and
// dark, under the wordmark. Static on purpose; a per-result card showing
// the player's own grid is /api/rawkle-card.
//
// Regenerate:  node scripts/make-rawkle-og-image.mjs
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
const DARK = '#1b2940';
const DARK_EDGE = 'rgba(148,190,233,0.45)';

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

text('SIX DEGREES OF ROCK', 26, 150, MUTED, W / 2);
text('RAWKLE', 92, 270, TEXT, W / 2);
text('Guess the band. One famous band a day, six tries.', 26, 340, MUTED, W / 2);

// One row of tiles, gold / blue / dark — the board at a glance.
const tiles = [GOLD, BLUE, DARK, GOLD, BLUE, DARK, GOLD];
const size = 56;
const gap = 12;
const rowW = tiles.length * size + (tiles.length - 1) * gap;
let x = (W - rowW) / 2;
const y = 400;
tiles.forEach((color) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = DARK_EDGE;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  x += size + gap;
});

ctx.fillStyle = GOLD;
ctx.font = '20pt Lato';
const foot = 'sixdegreesofrock.com/rawkle';
ctx.fillText(foot, W / 2 - ctx.measureText(foot).width / 2, 560);

const out = createWriteStream(join(ROOT, 'rawkle-og.png'));
await PImage.encodePNGToStream(img, out);
console.log('wrote rawkle-og.png');
