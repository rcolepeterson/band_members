// GET /api/daily-card?r=<code> — the picture in a shared 6° result's link preview.
//
// WHY THIS EXISTS (Cole, 2026-10-14: one-tap share)
//
// Facebook and Instagram drop any pre-filled text from a share, so a shared
// result used to arrive as a bare /game link and the player had to paste
// their score by hand. A link's preview is the one thing those apps always
// show, so the score now lives there: the share link carries a short result
// code (dailyResultCode in scripts/six-degrees-game.mjs), og_daily.js turns
// it into the preview title, and this draws the matching card: puzzle
// number, the result, one pick per move in that move's color, and the two
// bands.
//
// WHY IT IS CHEAP
//
// The score comes from the URL, so the only database read is the day's two
// band names (two tiny queries), and the CDN keeps each card for a week: a
// given code always draws the same picture.
//
// Same renderer, font and never-error rule as game_share.mjs: any failure
// redirects to the static /game card, so a share always unfurls into
// something.
import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';

import { getSql, isDbConfigured } from './_db.mjs';
import { pacificDate } from './_daily.mjs';
import {
  WIDTH, HEIGHT, SUPER, COLORS, FONT_FAMILY,
  ensureFont, measure, ellipsize, downscale2x,
} from './game_share.mjs';
import { DAILY_EPOCH } from '../../scripts/six-degrees-game.mjs';
import { parseDailyResultCode, dailyResultTitle } from '../../scripts/daily-result.mjs';

// Pick fills in brand colors (gold/silver/black), matching the board.
const STAR = {
  o: { fill: '#d9b36c', stroke: '#d9b36c' },
  s: { fill: '#c7ced8', stroke: '#c7ced8' },
  d: { fill: '#05080c', stroke: 'rgba(184,202,220,0.75)' },
};

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: { location: '/game-og.png?v=3', 'cache-control': 'no-store' },
  });

// The puzzle date for a puzzle number (#1 is DAILY_EPOCH).
export function dailyDateForNumber(num) {
  const [y, m, d] = DAILY_EPOCH.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + num - 1)).toISOString().slice(0, 10);
}

function drawPick(ctx, cx, cy, r, letter) {
  // Guitar pick shape: rounded teardrop, point down.
  const style = STAR[letter] || STAR.s;
  ctx.beginPath();
  // Top is wide and rounded, bottom comes to a soft point.
  ctx.moveTo(cx, cy + r);
  ctx.bezierCurveTo(cx - r * 1.1, cy + r * 0.3, cx - r * 0.9, cy - r, cx, cy - r);
  ctx.bezierCurveTo(cx + r * 0.9, cy - r, cx + r * 1.1, cy + r * 0.3, cx, cy + r);
  ctx.closePath();
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function centerText(ctx, text, size, y, color) {
  ctx.fillStyle = color;
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  ctx.fillText(text, (WIDTH - measure(ctx, text, size)) / 2, y);
}

export async function renderDailyCard({ result, start, target, host = 'sixdegreesofrock.com' } = {}) {
  if (!result || !ensureFont()) return null;
  const img = PImage.make(WIDTH * SUPER, HEIGHT * SUPER);
  const ctx = img.getContext('2d');
  ctx.scale(SUPER, SUPER);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Title and result: "6° Rock #14" then "Solved in 4 moves".
  const [head, score] = dailyResultTitle(result).split(' · ');
  centerText(ctx, head, 54, 150, COLORS.wordmark);
  centerText(ctx, score, 36, 222, result.won ? COLORS.gold : COLORS.muted);

  // One pick per move, shrinking to fit a long game.
  const n = result.kinds.length;
  if (n) {
    const gap = Math.min(96, (WIDTH - 180) / n);
    const r = Math.min(34, gap * 0.4);
    const left = (WIDTH - gap * (n - 1)) / 2;
    result.kinds.forEach((k, i) => drawPick(ctx, left + i * gap, 330, r, k));
  }

  // The two bands, when the day's chain could be looked up.
  if (start && target) {
    const line = ellipsize(ctx, `${start}  →  ${target}`, 26, WIDTH - 160);
    centerText(ctx, line, 26, 452, COLORS.label);
  }

  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  centerText(ctx, `Play today’s puzzle · ${host}/game`, 16, stripTop + 39, COLORS.gold);

  const card = downscale2x(img);
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await PImage.encodePNGToStream(card, sink);
  const png = Buffer.concat(chunks);
  return png.length ? png : null;
}

// The day's two band names. Only past and current days: a future number
// has no chain yet and must not deal one.
async function bandNamesFor(num) {
  if (!isDbConfigured()) return {};
  const date = dailyDateForNumber(num);
  if (date > pacificDate()) return {};
  const sql = getSql();
  const chains = await sql`select band_a, band_b from daily_chains where date = ${date} limit 1`;
  const chain = chains && chains[0];
  if (!chain) return {};
  const rows = await sql`select id, name from bands where id in (${chain.band_a}, ${chain.band_b})`;
  const name = new Map((rows || []).map((r) => [String(r.id), r.name]));
  return { start: name.get(String(chain.band_a)), target: name.get(String(chain.band_b)) };
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const result = parseDailyResultCode(url.searchParams.get('r'));
    if (!result) return fallback();
    let names = {};
    try { names = await bandNamesFor(result.num); } catch (error) {
      console.error('daily-card: band lookup failed', error && error.message);
    }
    const png = await renderDailyCard({ result, ...names, host: url.host });
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
    console.error('daily-card: falling back to the static card', error && error.message);
    return fallback();
  }
};

export const config = { path: '/api/daily-card' };
