// GET /api/fantasy-card?r=<code> — the picture in a shared Fantasy Band Game
// result's link preview.
//
// A TRADING CARD, not Daily's score sheet. The first version reused Daily's
// template (dark sheet, centered title, muted score line, footer strip) and
// at a glance in a feed it read as a Daily card, so this draws the result
// as a collectible card instead: a gold-bordered frame, the five drafted
// players as a lineup with their $ prices, the final score big, and a
// WIN / LOSS stamp. Facebook and Instagram drop any pre-filled text from
// a share, so a shared result used to arrive as a bare /fantasy link. A
// link's preview is the one thing those apps always show, so the score
// now lives there: the share link carries a short result code
// (fantasyResultCode in scripts/fantasy-result.mjs), og_fantasy.js turns
// it into the preview title, and this draws the matching card.
//
// WHY IT IS CHEAP
//
// The score comes from the URL and the five names come from the frozen
// 100-player pool module (./_fantasy_pool.mjs), so there is no database read
// at all, and the CDN keeps each card for a week: a given code always draws
// the same picture. Fantasy results spoil nothing — the band is the player's
// own draft — so the names are on the card by design.
//
// Same renderer, font and never-error rule as rawkle_card.mjs: any failure
// redirects to the static /game-og.png?v=3 card (no fantasy-specific static
// exists), so a share always unfurls into something.
//
// READABILITY
//
// The card is usually seen at link-preview size, so the score is the
// biggest thing on it, the names stay at 28pt, and nothing smaller than
// 16pt is drawn. The stamp is the only win/loss signal that has to read
// at a glance: gold when the band beat the Gold line, grey when it did not.
import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';

import {
  WIDTH, HEIGHT, SUPER, COLORS, FONT_FAMILY,
  ensureFont, measure, ellipsize, downscale2x,
} from './game_share.mjs';
import { parseFantasyResultCode, fantasyResultTitle } from '../../scripts/fantasy-result.mjs';
import { poolPlayer } from './_fantasy_pool.mjs';

// Slot order for the five draft rows: vocals, guitar, bass, drums, wild card.
const SLOTS = ['V', 'G', 'B', 'D', 'W'];

// Gold line the score is judged against (locked; mirrors the game page).
const GOLD_LINE = 69;

// Card geometry, in the 1200x630 logical space.
const FRAME = { x: 28, y: 24, w: 1144, h: 578 }; // outer gold frame
const INNER = { x: 40, y: 36, w: 1120, h: 554 }; // thin inner frame
const FACE = '#0c1a2e'; // midnight space blue, the card face
const DIVIDER = '#1e3048'; // steel blue rule between lineup and score
const STAMP_LOSS = '#8a97a5'; // grey-blue stamp when the band missed Gold

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: { location: '/game-og.png?v=3', 'cache-control': 'no-store' },
  });

function text(ctx, str, size, x, y, color) {
  ctx.fillStyle = color;
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  ctx.fillText(str, x, y);
}

function centerText(ctx, str, size, cx, y, color) {
  text(ctx, str, size, cx - measure(ctx, str, size) / 2, y, color);
}

function rightText(ctx, str, size, rightX, y, color) {
  text(ctx, str, size, rightX - measure(ctx, str, size), y, color);
}

function hline(ctx, x0, x1, y, color, width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

// pureimage's strokeRect ignores the current transform AND lineWidth (it
// paints 1px lines at raw coordinates), so rectangles go through paths,
// which do respect both — the same way game_share.mjs draws its zigzag.
function strokeBox(ctx, x, y, w, h, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.stroke();
}

// One lineup row: { slot, name, price }. Prices come from the frozen pool;
// the explicit-names path (tests) carries no price, so the price is omitted
// there instead of guessed. Exported so tests can pin the resolution.
export function resolveCardRows(result, names) {
  if (Array.isArray(names) && names.length === 5) {
    return SLOTS.map((slot, i) => ({ slot, name: String(names[i] ?? 'Unknown player'), price: null }));
  }
  return SLOTS.map((slot, i) => {
    const player = poolPlayer(result.picks[i]);
    return {
      slot,
      name: player ? player.name : 'Unknown player',
      price: player ? (player.price ?? player.price0 ?? null) : null,
    };
  });
}

export async function renderFantasyCard({ result, names, host = 'sixdegreesofrock.com' } = {}) {
  if (!result || !ensureFont()) return null;
  const img = PImage.make(WIDTH * SUPER, HEIGHT * SUPER);
  const ctx = img.getContext('2d');
  ctx.scale(SUPER, SUPER);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Card face + double gold frame.
  ctx.fillStyle = FACE;
  ctx.fillRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h);
  strokeBox(ctx, FRAME.x, FRAME.y, FRAME.w, FRAME.h, COLORS.gold, 5);
  strokeBox(ctx, INNER.x, INNER.y, INNER.w, INNER.h, COLORS.gold, 2);

  // Header: game name left, date right, gold rule underneath.
  const [head, date] = fantasyResultTitle(result).split(' · ');
  text(ctx, String(head || 'Fantasy Band Game').toUpperCase(), 30, 64, 92, COLORS.wordmark);
  rightText(ctx, String(date || ''), 24, 1136, 92, COLORS.muted);
  hline(ctx, 64, 1136, 112, COLORS.gold, 2);

  // Lineup (left): slot letter, name, $ price per pick.
  const rows = resolveCardRows(result, names);
  const rowTop = 180;
  const rowH = 74;
  rows.forEach((row, i) => {
    const y = rowTop + i * rowH;
    text(ctx, row.slot, 28, 64, y, COLORS.gold);
    const line = ellipsize(ctx, row.name, 28, 500);
    text(ctx, line, 28, 112, y, COLORS.label);
    if (row.price !== null && row.price !== undefined) {
      rightText(ctx, `$${row.price}`, 26, 696, y, COLORS.gold);
    }
  });

  // Steel rule between the lineup and the score.
  ctx.strokeStyle = DIVIDER;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(730, 150);
  ctx.lineTo(730, 500);
  ctx.stroke();

  // Score (right): label, the big number, the Gold-line target, the stamp.
  const scoreCx = 938;
  centerText(ctx, 'FINAL SCORE', 20, scoreCx, 190, COLORS.muted);
  const scoreText = result.finalScore.toFixed(2);
  let scoreSize = 108;
  if (measure(ctx, scoreText, scoreSize) > 360) scoreSize = 88;
  centerText(ctx, scoreText, scoreSize, scoreCx, 320, COLORS.gold);
  centerText(ctx, `GOLD LINE ${GOLD_LINE}`, 22, scoreCx, 368, COLORS.muted);

  const stamp = result.won
    ? { color: COLORS.gold, label: 'WIN' }
    : { color: STAMP_LOSS, label: 'LOSS' };
  const stampBox = { x: scoreCx - 150, y: 400, w: 300, h: 78 };
  strokeBox(ctx, stampBox.x, stampBox.y, stampBox.w, stampBox.h, stamp.color, 4);
  strokeBox(ctx, stampBox.x + 7, stampBox.y + 7, stampBox.w - 14, stampBox.h - 14, stamp.color, 1.5);
  centerText(ctx, stamp.label, 38, scoreCx, 452, stamp.color);

  // Footer: gold rule, then the play line inside the frame.
  hline(ctx, 64, 1136, 544, COLORS.gold, 2);
  centerText(ctx, `Play today's game · ${host}/fantasy`, 16, 600, 580, COLORS.gold);

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
    const result = parseFantasyResultCode(url.searchParams.get('r'));
    if (!result) return fallback();
    const png = await renderFantasyCard({ result, host: url.host });
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
    console.error('fantasy-card: falling back to the static card', error && error.message);
    return fallback();
  }
};

export const config = { path: '/api/fantasy-card' };
