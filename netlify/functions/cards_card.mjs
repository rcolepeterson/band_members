// GET /api/cards-card?r=<code> — the picture in a shared 6* Card Game result's link preview.
//
// Mirror of daily_card.mjs: same renderer (pureimage), same font, same
// never-error rule. The result comes from the URL, so there is no database
// read at all; a given code always draws the same picture, and the CDN keeps
// each card for a week.
//
// Design mirrors the in-game Download card (v14 canvas): midnight starfield,
// 6* mark, result line, stats row, closing band, footer URL.
import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';

import {
  WIDTH, HEIGHT, SUPER, COLORS, FONT_FAMILY,
  ensureFont, ellipsize,
  downscale2x,
} from './game_share.mjs';
import { parseCardsResultCode, WINNER_NAMES } from '../../scripts/cards-result.mjs';

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: { location: '/splash-og.png', 'cache-control': 'no-store' },
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
  for (let i = 0; i < 160; i++) {
    stars.push({
      x: rand() * WIDTH,
      y: rand() * (HEIGHT - 62),
      r: rand() < 0.85 ? 1 : 2,
      a: 0.25 + rand() * 0.6,
    });
  }
  return stars;
}

function centerText(ctx, text, size, y, color) {
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, WIDTH / 2, y);
}

async function renderCardsCard({ result, host }) {
  if (!ensureFont()) return null;
  const img = PImage.make(WIDTH * SUPER, HEIGHT * SUPER);
  const ctx = img.getContext('2d');
  ctx.scale(SUPER, SUPER);

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (const s of starsFor(`${result.winner}-${result.turns}-${result.chain}-${result.closing}`)) {
    ctx.fillStyle = `rgba(219,230,242,${s.a.toFixed(2)})`;
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }

  centerText(ctx, '6*', 120, 118, COLORS.gold);

  centerText(ctx, '6* CARD GAME', 22, 205, COLORS.gold);

  const line = result.won
    ? 'You beat Mara, Dev, and Kit.'
    : `${WINNER_NAMES[result.winner]} takes the game.`;
  centerText(ctx, ellipsize(ctx, line, 52, WIDTH - 120), 52, 252, COLORS.wordmark);

  const stats = `${result.turns} turns · ${result.chain}-card chain · ${result.stalls} stalls · Ricky ${result.ricky} · Freeze ${result.freeze}`;
  centerText(ctx, ellipsize(ctx, stats, 26, WIDTH - 120), 26, 338, COLORS.muted);

  centerText(ctx, 'CLOSING BAND', 20, 418, COLORS.muted);
  centerText(ctx, ellipsize(ctx, result.closing, 44, WIDTH - 120), 44, 474, COLORS.gold);

  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  centerText(ctx, `Play the card game · ${host}/cards`, 16, stripTop + 39, COLORS.gold);

  const card = downscale2x(img);
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
