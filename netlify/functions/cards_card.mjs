// GET /api/cards-card?r=<code> — the picture in a shared 6* Card Game result's link preview.
//
// Mirror of daily_card.mjs: same renderer (pureimage), same font, same
// never-error rule. The result comes from the URL, so there is no database
// read at all; a given code always draws the same picture, and the CDN keeps
// each card for a week.
//
// Design (v15d): midnight star-sky (vertical midnight gradient, dense stars,
// two faint constellation lines) + a fan of four card backs in the deck's own
// design, so the card reads as a card game at a glance — then the result line,
// stats row, closing band, footer URL. The in-game Download canvas is gone
// (v15d cut Download), so this function is now the only card renderer.
//
// v15f: renders at 1x (1200x630 directly, no supersample, no downscale).
// Measured 2026-10-30: the 2x gradient fill alone cost 5,143ms of a 5,576ms
// render (cold handler 5,914ms) — past Facebook's first-scrape patience,
// which is why fresh shares posted white while Daily/Rawkle (solid
// backgrounds, ~400ms renders) shared instantly. At 1x the same drawing
// costs 921ms total with identical layout, colors, and output dimensions;
// only antialiasing softens slightly. game_share.mjs is untouched (SUPER
// stays 2 for Daily/Rawkle); this file simply stops using it.
import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';

import {
  WIDTH, HEIGHT, COLORS, FONT_FAMILY,
  ensureFont, ellipsize,
} from './game_share.mjs';
import { parseCardsResultCode, WINNER_NAMES } from '../../scripts/cards-result.mjs';

// v15d: the dynamic render failing falls back to the cards baseline card,
// not the generic splash — it ships in the same release (repo root).
const fallback = () =>
  new Response(null, {
    status: 302,
    headers: { location: '/cards-og.png', 'cache-control': 'no-store' },
  });

// Deterministic starfield: same code draws the same stars, so the CDN copy
// and a fresh render never disagree.
function starsFor(code) {
  let seed = 2166136261;
  for (let i = 0; i < code.length; i++) {
    seed ^= code.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const rand = () => {
    seed = Math.imul(seed, 1664525) + 1013904223;
    return ((seed >>> 0) / 4294967296);
  };
  const stars = [];
  for (let i = 0; i < 400; i++) {
    const roll = rand();
    stars.push({
      x: rand() * WIDTH,
      y: rand() * (HEIGHT - 62),
      r: roll < 0.7 ? 1 : (roll < 0.95 ? 2 : 3),
      a: 0.35 + rand() * 0.65,
      gold: rand() < 0.15,
    });
  }
  return stars;
}

// Two faint constellation groups, fixed in the corners, clear of the text.
const CONSTELLATIONS = [
  [[90, 90], [150, 60], [210, 100], [260, 70], [310, 110]],
  [[900, 500], [960, 470], [1010, 510], [1060, 480], [1110, 520]],
];

function centerText(ctx, text, size, y, color) {
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, WIDTH / 2, y);
}

// Squircle-cornered rectangle: straight edges, corners as superellipse
// arcs (n=4) of radius r — the path form of the game's CSS
// corner-shape: squircle. Drawn as a path, not fillRect/strokeRect:
// pureimage's strokeRect ignores the canvas transform, so under this
// card's translate/rotate the gold borders used to land unrotated in
// the top-left corner and the backs shipped borderless (seen live
// 2026-11-28). Paths respect the transform.
function squircleRectPath(ctx, x, y, w, h, r, n = 4) {
  const SEG = 16;
  const corners = [
    { cx: x + w - r, cy: y + r, a0: -Math.PI / 2 },
    { cx: x + w - r, cy: y + h - r, a0: 0 },
    { cx: x + r, cy: y + h - r, a0: Math.PI / 2 },
    { cx: x + r, cy: y + r, a0: Math.PI },
  ];
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  for (const c of corners) {
    for (let i = 0; i <= SEG; i++) {
      const t = c.a0 + (i / SEG) * (Math.PI / 2);
      const co = Math.cos(t), si = Math.sin(t);
      const px = c.cx + r * Math.sign(co) * Math.pow(Math.abs(co), 2 / n);
      const py = c.cy + r * Math.sign(si) * Math.pow(Math.abs(si), 2 / n);
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
}

// One card back, rotated about its center: squircle corners (matching
// the in-game cards), gold border + inner hairline.
function drawCardBack(ctx, cx, cy, w, h, angleDeg) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((angleDeg * Math.PI) / 180);
  squircleRectPath(ctx, -w / 2, -h / 2, w, h, 10);
  ctx.fillStyle = '#0e1a28';
  ctx.fill();
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 2;
  ctx.stroke();
  squircleRectPath(ctx, -w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 5);
  ctx.strokeStyle = 'rgba(217,179,108,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = `30pt ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.gold;
  ctx.fillText('6*', 0, 2);
  ctx.restore();
}

async function renderCardsCard({ result, host }) {
  if (!ensureFont()) return null;
  // v15f: 1x canvas — same logical drawing, no supersample (see header).
  const img = PImage.make(WIDTH, HEIGHT);
  const ctx = img.getContext('2d');

  // Midnight sky: vertical gradient, deep blue up top fading to black.
  // Deepened 2026-11-28 (Aaron's hybrid pick): the static card's
  // fade-to-black mood on the result card too — the fade now reaches
  // near-black higher up, so the fan and closing band sit on black.
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, '#122640');
  sky.addColorStop(0.38, '#0a1524');
  sky.addColorStop(1, '#03060a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (const s of starsFor(`${result.winner}-${result.turns}-${result.chain}-${result.closing}`)) {
    ctx.fillStyle = s.gold
      ? `rgba(217,179,108,${s.a.toFixed(2)})`
      : `rgba(219,230,242,${s.a.toFixed(2)})`;
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }

  ctx.strokeStyle = 'rgba(127,178,217,0.32)';
  ctx.lineWidth = 1;
  for (const group of CONSTELLATIONS) {
    ctx.beginPath();
    group.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(219,230,242,0.5)';
    for (const [x, y] of group) ctx.fillRect(x - 1, y - 1, 3, 3);
  }

  centerText(ctx, '6*', 96, 88, COLORS.gold);

  centerText(ctx, '6* CARD GAME', 20, 158, COLORS.gold);

  const line = result.won
    ? 'You beat Mara, Dev, and Kit.'
    : `${WINNER_NAMES[result.winner]} takes the game.`;
  centerText(ctx, ellipsize(ctx, line, 46, WIDTH - 120), 46, 205, COLORS.wordmark);

  const stats = `${result.turns} turns · ${result.chain}-card chain · ${result.stalls} stalls · Ricky ${result.ricky} · Freeze ${result.freeze}`;
  centerText(ctx, ellipsize(ctx, stats, 22, WIDTH - 120), 22, 252, COLORS.muted);

  // Challenge share (2026-11-22): the dare rides the card picture too,
  // in the same shapes as the share text and the preview title.
  const dare = result.won ? 'Beat that.' : 'Think you can do better?';
  centerText(ctx, dare, 22, 286, COLORS.gold);

  // Fan of four backs, fanned about the center. (fanY 375 -> 384 with
  // the dare line above it, so the fan's top corners clear the text.)
  const fanY = 384;
  const fanCards = [
    { cx: 457, angle: -14 },
    { cx: 563, angle: -5 },
    { cx: 669, angle: 5 },
    { cx: 775, angle: 14 },
  ];
  for (const c of fanCards) drawCardBack(ctx, c.cx, fanY, 108, 154, c.angle);

  centerText(ctx, 'CLOSING BAND', 20, 492, COLORS.muted);
  centerText(ctx, ellipsize(ctx, result.closing, 44, WIDTH - 120), 44, 528, COLORS.gold);

  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  centerText(ctx, `Play the card game · ${host}/cards`, 16, stripTop + 39, COLORS.gold);

  // v15f: already 1200x630 — no downscale step.
  const card = img;
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await PImage.encodePNGToStream(card, sink);
  const png = Buffer.concat(chunks);
  return png.length ? png : null;
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const result = parseCardsResultCode(url.searchParams.get('r'));
    if (!result) return fallback();
    const png = await renderCardsCard({ result, host: url.host });
    if (!png) return fallback();
    return new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        // A code always draws the same card; let the CDN keep it.
        'cache-control': 'public, max-age=86400, s-maxage=604800',
      },
    });
  } catch (error) {
    console.error('cards-card: falling back to the static card', error && error.message);
    return fallback();
  }
};

export const config = { path: '/api/cards-card' };
