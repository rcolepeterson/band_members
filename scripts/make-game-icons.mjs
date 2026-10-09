// Draws the /game home-screen icons: game-icon-180.png (iOS), -192 and -512
// (Android / web app manifest).
//
// Add to Home Screen (Cole, 2026-10-08): the daily game gets its own icon, a
// big green guitar pick (the game's "shortest path" color) with "6°" in it,
// on the board's dark background. Full-bleed background and the pick inside
// the middle ~70%, so Android's "maskable" crop (circle, squircle) never cuts
// it. Same drawing kit as the preview card: pureimage + the vendored Lato.
//
// Regenerate:  node scripts/make-game-icons.mjs
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as PImage from 'pureimage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#05080d';
const PICK = '#3fa36b';
const TEXT = '#ffffff';

const font = PImage.registerFont(join(ROOT, 'vendor/fonts/og/Lato-Medium.ttf'), 'Lato');
font.loadSync();

function draw(size) {
  const img = PImage.make(size, size);
  const ctx = img.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, size, size);

  // The pick (24x28 units), 64% of the icon wide, centered.
  const w = size * 0.64;
  const s = w / 24;
  const left = (size - w) / 2;
  const top = (size - 28 * s) / 2 + size * 0.02;
  const X = (x) => left + x * s;
  const Y = (y) => top + y * s;
  // A classic guitar pick: wide rounded shoulders tapering to a rounded tip.
  // (The game's teardrop read as a map pin at icon size.)
  ctx.beginPath();
  ctx.moveTo(X(12), Y(1.5));
  ctx.bezierCurveTo(X(18.5), Y(1.5), X(23), Y(3), X(22.5), Y(8.5));
  ctx.bezierCurveTo(X(22), Y(14), X(16), Y(22), X(13.3), Y(25.6));
  ctx.bezierCurveTo(X(12.6), Y(26.5), X(11.4), Y(26.5), X(10.7), Y(25.6));
  ctx.bezierCurveTo(X(8), Y(22), X(2), Y(14), X(1.5), Y(8.5));
  ctx.bezierCurveTo(X(1), Y(3), X(5.5), Y(1.5), X(12), Y(1.5));
  ctx.closePath();
  ctx.fillStyle = PICK;
  ctx.fill();

  // "6°" in the wide upper part of the pick.
  const px = Math.round(size * 0.26);
  ctx.font = `${px}pt Lato`;
  ctx.fillStyle = TEXT;
  const label = '6°';
  const tw = ctx.measureText(label).width;
  ctx.fillText(label, (size - tw) / 2 + size * 0.015, Y(13.2));
  return img;
}

for (const size of [180, 192, 512]) {
  const out = join(ROOT, `game-icon-${size}.png`);
  await PImage.encodePNGToStream(draw(size), createWriteStream(out));
  console.log('wrote', out);
}
