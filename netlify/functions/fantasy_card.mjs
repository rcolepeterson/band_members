// GET /api/fantasy-card?r=<code> — the picture in a shared Fantasy Band Game
// result's link preview.
//
// Mirror of rawkle_card.mjs, for a fantasy draft instead of a guess grid.
// Facebook and Instagram drop any pre-filled text from a share, so a shared
// result used to arrive as a bare /fantasy link. A link's preview is the one
// thing those apps always show, so the score now lives there: the share link
// carries a short result code (fantasyResultCode in scripts/fantasy-result.mjs),
// og_fantasy.js turns it into the preview title, and this draws the matching
// card: game name and date, the settled score against the Gold line of 69,
// and the five drafted players in slot order.
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

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: { location: '/game-og.png?v=3', 'cache-control': 'no-store' },
  });

function centerText(ctx, text, size, y, color) {
  ctx.fillStyle = color;
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  ctx.fillText(text, (WIDTH - measure(ctx, text, size)) / 2, y);
}

export async function renderFantasyCard({ result, names, host = 'sixdegreesofrock.com' } = {}) {
  if (!result || !ensureFont()) return null;
  const img = PImage.make(WIDTH * SUPER, HEIGHT * SUPER);
  const ctx = img.getContext('2d');
  ctx.scale(SUPER, SUPER);
  ctx.fillStyle = '#0c1a2e'; // midnight space blue (brand), as on Daily's and Rawkle's cards
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Title and result: "Fantasy Band Game · 2026-11-07" then
  // "72.40 — beat the Gold line of 69".
  const [head, date] = fantasyResultTitle(result).split(' · ');
  centerText(ctx, `${head} · ${date}`, 48, 116, COLORS.wordmark);
  const scoreLine = `${result.finalScore.toFixed(2)} — ${result.won ? 'beat' : 'below'} the Gold line of 69`;
  centerText(ctx, scoreLine, 34, 184, result.won ? COLORS.gold : COLORS.muted);

  // The five drafted players, one per row in slot order, resolved from the
  // pool. An unknown UUID never crashes the card — it draws as Unknown player.
  const rows = (Array.isArray(names) && names.length === 5 ? names : result.picks.map((id) => {
    const player = poolPlayer(id);
    return player ? player.name : 'Unknown player';
  }));
  const rowTop = 252;
  const rowH = 54;
  rows.forEach((name, i) => {
    const y = rowTop + i * rowH;
    ctx.fillStyle = COLORS.gold;
    ctx.font = `26pt ${FONT_FAMILY}`;
    ctx.fillText(SLOTS[i], 120, y);
    const line = ellipsize(ctx, String(name || 'Unknown player'), 26, WIDTH - 300);
    ctx.fillStyle = COLORS.label;
    ctx.font = `26pt ${FONT_FAMILY}`;
    ctx.fillText(line, 180, y);
  });

  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  centerText(ctx, `Play today's game · ${host}/fantasy`, 16, stripTop + 39, COLORS.gold);

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
