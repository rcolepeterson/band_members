// Game share cards.
//
// POST /api/game-share — stores a finished chain, returns a share URL.
//   body: { chain: [{ name, kind: 'band'|'member' }], mode, hops }
//   -> { ok: true, id, shareUrl: "https://<host>/?game=<id>" }
//
// GET /api/game-share?id=<id> — the 1200x630 PNG card (the og:image for the link).
// GET /api/game-share?id=<id>&meta=1 — JSON { first, last, hops, mode } for the
//   edge function that rewrites the link-preview tags.
//
// WHY THIS EXISTS
//
// "Share the chain" used to send bare text plus the site origin — no picture, no
// chain, nothing to tap. Aaron's call: the share output should look like the
// Six Degrees banner (QR, wordmark, tagline, the chain drawn as a node zigzag,
// footer URL), because a picture of YOUR chain is the lure and the QR is the door.
// Pasting the link unfurls the card; the QR opens the game directly (?game=1) so
// a new player lands mid-game, not on the homepage.
//
// WHY IT LOOKS THE WAY IT DOES
//
// Same renderer as the band link-preview cards (pureimage, vendored Lato, dark
// constellation palette) so a game share and a band share read as the same
// product in a feed. The chain is drawn as a zigzag rather than a radial burst:
// a chain IS a line, and the banner Aaron approved is the reference.
//
// WHY pureimage, WHY NEVER-ERROR
//
// Same constraints as og_image.mjs: crawlers need a real raster (no SVG), every
// obvious rasteriser is a native binary, and this runs in a bundled serverless
// function. A 500 here is a broken preview on somebody's post, which is worse
// than a generic one — every failure path redirects to the static og-image.png.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import * as PImage from 'pureimage';
import QRCode from 'qrcode';

import { getSql, isDbConfigured, ok, badRequest, notFound, serverError } from './_db.mjs';
import { clientIp, consume, tooManyRequests } from './_rate_limit.mjs';

const WIDTH = 1200;
const HEIGHT = 630;

const COLORS = {
  background: '#070b10',
  edge: '#2dd4bf',
  band: '#8fe8f6',
  member: '#c9b6f0',
  label: '#dbe6f2',
  wordmark: '#e9eef6',
  muted: 'rgba(184,202,220,0.92)',
  gold: '#d9b36c',
  strip: '#0a1016',
};

const MODES = new Set(['head-to-head', 'solo', 'chaos']);
const MAX_CHAIN = 12;
const MAX_NAME = 80;

// Same font plumbing as og_image.mjs: esbuild inlines JS, not binaries, so the
// TTF ships via netlify.toml included_files and is read from disk at runtime.
const FONT_FAMILY = 'OgSans';
const FONT_CANDIDATES = [
  'vendor/fonts/og/Lato-Medium.ttf',
  './vendor/fonts/og/Lato-Medium.ttf',
  join(process.cwd(), 'vendor/fonts/og/Lato-Medium.ttf'),
  '/var/task/vendor/fonts/og/Lato-Medium.ttf',
];

let fontReady = false;
function ensureFont() {
  if (fontReady) return true;
  const found = FONT_CANDIDATES.find((path) => {
    try { return existsSync(path); } catch (_) { return false; }
  });
  if (!found) {
    console.error('game-share: no font found; tried', FONT_CANDIDATES);
    return false;
  }
  const scratch = join(tmpdir(), 'rbft-og-font.ttf');
  try {
    if (!existsSync(scratch)) writeFileSync(scratch, readFileSync(found));
    PImage.registerFont(scratch, FONT_FAMILY).loadSync();
    fontReady = true;
    return true;
  } catch (error) {
    console.error('game-share: font failed to load', error && error.message);
    return false;
  }
}

const fallback = () =>
  new Response(null, {
    status: 302,
    headers: {
      location: '/og-image.png',
      'cache-control': 'no-store',
    },
  });

function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
}

export function validChain(chain) {
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > MAX_CHAIN) return null;
  const nodes = [];
  for (const item of chain) {
    if (!item || typeof item !== 'object') return null;
    const name = cleanName(item.name);
    const kind = item.kind === 'band' ? 'band' : item.kind === 'member' ? 'member' : null;
    if (!name || !kind) return null;
    nodes.push({ name, kind });
  }
  return nodes;
}

// Short, URL-safe, unguessable-enough ids. 8 chars from 48 bits: ~280 trillion
// possibilities, and the insert retries on the (absurd) collision.
function newId() {
  return randomBytes(6).toString('base64url');
}

// --- card rendering ----------------------------------------------------------
// Draws the share card for one stored chain. Exported so it can be exercised
// against a fixture chain without a database or a deploy; the handler's only
// extra job is fetching the row and turning null into a redirect.

function measure(ctx, text, size) {
  ctx.font = `${size}pt ${FONT_FAMILY}`;
  let width;
  try { width = PImage.measureText(ctx, text).width; } catch (_) { width = text.length * size * 0.58; }
  if (!Number.isFinite(width) || width <= 0) width = text.length * size * 0.58;
  return width;
}

function ellipsize(ctx, text, size, maxWidth) {
  if (measure(ctx, text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && measure(ctx, t + '…', size) > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

// QR modules -> black squares on a white plate. qrcode.create gives the module
// matrix directly, so there is no PNG to decode — the plate is drawn first with
// a 4-module quiet zone, then the dark modules on top of it.
function drawQr(ctx, text, x, y, px) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const cell = px / (n + quiet * 2);
  const total = cell * (n + quiet * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, total, total);
  ctx.fillStyle = '#0a0a0a';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.5, cell + 0.5);
      }
    }
  }
  return total;
}

export async function renderGameCard({ chain, hops, host = 'sixdegreesofrock.com' } = {}) {
  if (!ensureFont()) return null;
  const nodes = validChain(chain);
  if (!nodes) return null;
  const hopCount = Number.isFinite(Number(hops)) ? Math.max(1, Math.min(10, Math.round(Number(hops)))) : nodes.length - 1;

  const img = PImage.make(WIDTH, HEIGHT);
  const ctx = img.getContext('2d');
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // --- header: QR, wordmark, tagline, hop badge -------------------------------
  const gameUrl = `https://${host}/?game=1`;
  const qrSize = drawQr(ctx, gameUrl, 88, 92, 168);

  ctx.fillStyle = COLORS.wordmark;
  ctx.font = `30pt ${FONT_FAMILY}`;
  ctx.fillText('SIX DEGREES OF ROCK', 300, 168);

  ctx.fillStyle = COLORS.muted;
  ctx.font = `16pt ${FONT_FAMILY}`;
  ctx.fillText('Explore how bands and musicians connect across scenes and decades', 300, 208);

  ctx.fillStyle = COLORS.gold;
  ctx.font = `22pt ${FONT_FAMILY}`;
  const hopText = `${hopCount} HOP${hopCount === 1 ? '' : 'S'}`;
  const hopW = measure(ctx, hopText, 22);
  ctx.fillText(hopText, WIDTH - 90 - hopW, 168);

  // --- chain zigzag ------------------------------------------------------------
  // The banner's shape: nodes alternate between two rows, teal edges between
  // them, names riding above the top row and below the bottom row. Deterministic
  // placement — a chain is a line, so there is nothing to collide with except
  // long names, which get ellipsized to the lane width.
  const n = nodes.length;
  const left = 110;
  const right = WIDTH - 110;
  const spacing = n > 1 ? (right - left) / (n - 1) : 0;
  const rowY = [352, 452];
  const pts = nodes.map((node, i) => ({
    x: n > 1 ? left + i * spacing : (left + right) / 2,
    y: rowY[i % 2],
    node,
  }));

  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 3;
  for (let i = 1; i < pts.length; i++) {
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  pts.forEach((p, i) => {
    const isBand = p.node.kind === 'band';
    ctx.fillStyle = isBand ? COLORS.band : COLORS.member;
    ctx.beginPath();
    ctx.arc(p.x, p.y, isBand ? 10 : 8, 0, Math.PI * 2);
    ctx.fill();

    const size = 15;
    const label = ellipsize(ctx, p.node.name, size, Math.max(spacing * 1.7, 120));
    const w = measure(ctx, label, size);
    ctx.fillStyle = COLORS.label;
    ctx.font = `${size}pt ${FONT_FAMILY}`;
    // Top-row names sit above their dot, bottom-row names below — the zigzag's
    // own rhythm keeps every label clear of every other.
    const ly = i % 2 === 0 ? p.y - 22 : p.y + 36;
    ctx.fillText(label, p.x - w / 2, ly);
  });

  // --- footer strip -------------------------------------------------------------
  const stripTop = HEIGHT - 62;
  ctx.fillStyle = COLORS.strip;
  ctx.fillRect(0, stripTop, WIDTH, 62);
  ctx.fillStyle = COLORS.gold;
  ctx.font = `16pt ${FONT_FAMILY}`;
  ctx.fillText(host, 90, stripTop + 39);

  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await PImage.encodePNGToStream(img, sink);
  const png = Buffer.concat(chunks);
  if (!png.length) return null;
  return png;
}

// --- request handler ------------------------------------------------------------

export default async (req) => {
  const url = new URL(req.url);

  // --- GET: the card image, or its metadata -------------------------------------
  if (req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').slice(0, 32);
    if (!id || !isDbConfigured()) return fallback();
    try {
      const sql = getSql();
      const rows = await sql`select chain, hops, mode from shared_chains where id = ${id} limit 1`;
      const row = rows && rows[0];
      if (!row) return fallback();

      // Metadata for the edge function: what the link-preview title is built from.
      if (url.searchParams.get('meta') === '1') {
        const chain = validChain(row.chain) || [];
        return new Response(
          JSON.stringify({
            ok: true,
            first: chain.length ? chain[0].name : '',
            last: chain.length ? chain[chain.length - 1].name : '',
            hops: row.hops,
            mode: row.mode,
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
        );
      }

      const png = await renderGameCard({ chain: row.chain, hops: row.hops, host: url.host });
      if (!png || !png.length) return fallback();
      return new Response(png, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          // One id is one immutable card. Cache it hard: a crawler swarm hitting
          // the same fresh link should be answered from the edge, not re-rendered.
          'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
        },
      });
    } catch (error) {
      console.error('game-share: falling back to the static card', error && error.message);
      return fallback();
    }
  }

  // --- POST: store a chain, hand back the share URL ------------------------------
  if (req.method === 'POST') {
    if (!isDbConfigured()) return serverError('sharing is unavailable right now');
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest('expected a JSON body');
    }
    const chain = validChain(body && body.chain);
    if (!chain) return badRequest('chain must be 2–12 named bands/members');
    const mode = MODES.has(body && body.mode) ? body.mode : 'head-to-head';
    const hops = Number.isFinite(Number(body && body.hops))
      ? Math.max(1, Math.min(10, Math.round(Number(body.hops))))
      : chain.length - 1;

    // Sharing is the abusable half of this endpoint (a bot could mint unlimited
    // rows). Per-IP budget, generous enough that a table full of friends sharing
    // all night never notices it. Fail-open: if the limiter itself errors, the
    // request still goes through.
    const ip = clientIp(req);
    const budget = await consume({
      sql: getSql(),
      bucket: `game-share:ip:${ip}`,
      limit: 60,
      windowSeconds: 3600,
    });
    if (!budget.allowed) {
      return tooManyRequests('Too many shares from this network. Try again shortly.', budget.retryAfterSeconds);
    }

    try {
      const sql = getSql();
      let id = null;
      for (let attempt = 0; attempt < 3 && !id; attempt++) {
        const candidate = newId();
        try {
          await sql`insert into shared_chains (id, chain, mode, hops)
                     values (${candidate}, ${JSON.stringify(chain)}::jsonb, ${mode}, ${hops})`;
          id = candidate;
        } catch (error) {
          // Unique violation on the id: try another. Anything else is real.
          if (error && error.code !== '23505') throw error;
        }
      }
      if (!id) return serverError('could not save the chain');
      const origin = `${url.protocol}//${url.host}`;
      return ok({ id, shareUrl: `${origin}/?game=${encodeURIComponent(id)}` });
    } catch (error) {
      console.error('game-share: store failed', error && error.message);
      return serverError('could not save the chain');
    }
  }

  return new Response(JSON.stringify({ ok: false, error: 'method not allowed' }), {
    status: 405,
    headers: { 'content-type': 'application/json' },
  });
};

export const config = { path: '/api/game-share' };
