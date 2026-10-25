// GET /api/rawkle-card?r=<code> — the picture in a shared Rawkle result's link preview.
//
// Mirror of daily_card.mjs, for Rawkle's grid instead of Daily's picks.
// Facebook and Instagram drop any pre-filled text from a share, so a shared
// result used to arrive as a bare /rawkle link. A link's preview is the one
// thing those apps always show, so the score now lives there: the share link
// carries a short result code (rawkleResultCode in scripts/rawkle-result.mjs),
// og_rawkle.js turns it into the preview title, and this draws the matching
// card: puzzle number, the result, and the guess grid in the game's own tile
// colors. The code carries no letters and no band name, so the card is
// spoiler-free by construction — the same rule Daily's card follows.
//
// WHY IT IS CHEAP
//
// The score comes from the URL, so there is no database read at all (unlike
// Daily's card, which looks up the day's two bands), and the CDN keeps each
// card for a week: a given code always draws the same picture.
//
// Same renderer, font and never-error rule as daily_card.mjs: any failure
// redirects to the static /rawkle-og.png card, so a share always unfurls
// into something.
import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';

import {
  WIDTH, HEIGHT, SUPER, COLORS, FONT_FAMILY,
  ensureFont, measure, downscale2x,
} from './game_share.mjs';
import { parseRawkleResultCode, rawkleResultTitle } from '../../scripts/rawkle-result.mjs';

// Rawkle's own tile colors (the board's, not the Daily pick palette).
const TILE = {
  g: '#ffb454', // gold: right letter, right spot
  b: '#27b8ff', // blue: in the name, wrong spot
  a: '#1b2940', // dark: not in the name at all
};
const TILE_STROKE = 'rgba(148,190,233,0.45)';

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: { location: '/rawkle-og.png', 'cache-control': 'no-store' },
  });

function centerText(ctx, text, size, y, color) {
  ctx.fillStyle = color;
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  ctx.fillText(text, (WIDTH - measure(ctx, text, size)) / 2, y);
}

export async function renderRawkleCard({ result, host = 'sixdegreesofrock.com' } = {}) {
  if (!result || !ensureFont()) return null;
  const img = PImage.make(WIDTH * SUPER, HEIGHT * SUPER);
  const ctx = img.getContext('2d');
  ctx.scale(SUPER, SUPER);
  ctx.fillStyle = '#0c1a2e'; // midnight space blue (brand), as on Daily's card
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Title and result: "Rawkle #2" then "Solved in 4 tries".
  const [head, score] = rawkleResultTitle(result).split(' · ');
  centerText(ctx, head, 54, 130, COLORS.wordmark);
  centerText(ctx, score, 36, 198, result.won ? COLORS.gold : COLORS.muted);

  // The guess grid: one row per guess, tiles in the game's own colors,
  // shrinking to fit the longest row (a 24-tile marathon row still fits).
  const rows = result.rows;
  const maxTiles = Math.max(...rows.map((r) => r.length));
  const gap = 8;
  const size = Math.min(46, Math.floor((WIDTH - 240 - (maxTiles - 1) * gap) / maxTiles));
  const rowH = size + 12;
  const blockH = rows.length * rowH - 12;
  const top = 240 + Math.max(0, Math.floor((250 - blockH) / 2));
  rows.forEach((row, ri) => {
    const rowW = row.length * size + (row.length - 1) * gap;
    let x = (WIDTH - rowW) / 2;
    const y = top + ri * rowH;
    row.forEach((tile) => {
      ctx.fillStyle = TILE[tile] || TILE.a;
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = TILE_STROKE;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, size, size);
      x += size + gap;
    });
  });

  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  centerText(ctx, `Play today's band · ${host}/rawkle`, 16, stripTop + 39, COLORS.gold);

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
    const result = parseRawkleResultCode(url.searchParams.get('r'));
    if (!result) return fallback();
    const png = await renderRawkleCard({ result, host: url.host });
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
    console.error('rawkle-card: falling back to the static card', error && error.message);
    return fallback();
  }
};

export const config = { path: '/api/rawkle-card' };
