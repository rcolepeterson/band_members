// Draws game-og.png, the link-preview card for /game (1200x630).
//
// Wordle-simple (Cole, 2026-10-08): a dark field, a row of guitar picks in
// the brand's gold/silver/blue, and words
// that say "this is a game you play every day" at a glance. Static on purpose; a per-day card
// showing today's matchup would be a server-rendered follow-up.
//
// Regenerate:  node scripts/make-game-og-image.mjs
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as PImage from 'pureimage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1200;
const H = 630;

// Same palette as the game board.
const BG = '#05080d';
const PANEL = '#0b131c';
const TEXT = '#edf7ff';
const MUTED = '#9fb1c1';
const FAINT = '#5b6b7c';
const ACCENT = '#8fe8f6';
const GOOD = '#c9a83a';
const OK = '#c0c0c0';
const BAD = '#74c9d0';

const font = PImage.registerFont(join(ROOT, 'vendor/fonts/og/Lato-Medium.ttf'), 'Lato');
font.loadSync();

const img = PImage.make(W, H);
const ctx = img.getContext('2d');

ctx.fillStyle = BG;
ctx.fillRect(0, 0, W, H);
// A quiet inner panel, like the game card.
ctx.fillStyle = PANEL;
ctx.fillRect(40, 40, W - 80, H - 80);

// The guitar pick from the game (viewBox 24x28), scaled to `size` wide.
function pick(cx, top, size, color) {
  const s = size / 24;
  const X = (x) => cx - size / 2 + x * s;
  const Y = (y) => top + y * s;
  ctx.beginPath();
  ctx.moveTo(X(12), Y(2.5));
  ctx.bezierCurveTo(X(6.8), Y(2.5), X(2.5), Y(6.5), X(2.5), Y(11.8));
  ctx.bezierCurveTo(X(2.5), Y(17.8), X(7.7), Y(23.4), X(11.1), Y(26));
  ctx.bezierCurveTo(X(11.6), Y(26.4), X(12.4), Y(26.4), X(12.9), Y(26));
  ctx.bezierCurveTo(X(16.3), Y(23.4), X(21.5), Y(17.8), X(21.5), Y(11.8));
  ctx.bezierCurveTo(X(21.5), Y(6.5), X(17.2), Y(2.5), X(12), Y(2.5));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Text centered on x, drawn letter by letter when it needs tracking.
function centered(text, y, px, color, tracking = 0) {
  ctx.font = `${px}pt Lato`;
  ctx.fillStyle = color;
  if (!tracking) {
    const w = ctx.measureText(text).width;
    ctx.fillText(text, (W - w) / 2, y);
    return;
  }
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
  let x = (W - total) / 2;
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, x, y);
    x += widths[i] + tracking;
  });
}

// A chain of five moves: shortest path, long way, dead end, back on track.
const picks = [GOOD, OK, BAD, GOOD, GOOD];
const size = 92;
const gap = 30;
const rowW = picks.length * size + (picks.length - 1) * gap;
picks.forEach((color, i) => pick((W - rowW) / 2 + size / 2 + i * (size + gap), 150, size, color));

centered('SIX DEGREES OF ROCK', 340, 26, ACCENT, 9);
centered('A new rock puzzle every day', 428, 60, TEXT);
centered('Connect two bands through the musicians they share.', 500, 28, MUTED);
centered('sixdegreesofrock.com/game', 560, 22, FAINT, 1);

const out = join(ROOT, 'game-og.png');
await PImage.encodePNGToStream(img, createWriteStream(out));
console.log('wrote', out);
