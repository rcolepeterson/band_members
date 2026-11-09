// Fantasy Band Game share: result-code contract + share card.
//
// Mirrors tests/rawkle-share-card.test.mjs: the preview is the one part of
// the product nobody on the team ever sees while working on it (it renders
// on Facebook's servers), so its properties are checked here rather than
// trusted to a glance at a deploy.
//
// What this locks in:
//   1. The result code round-trips (win and loss), and the title reads
//      "Fantasy Band Game · <date> · <score> — beat / below the Gold line".
//   2. Malformed codes and inputs return null — wrong pick count, an
//      impossible date, a non-UUID pick, a garbage string.
//   3. An omitted `won` derives from the score against the locked Gold
//      line of 69 (strictly greater wins).
//   4. The card draws for a production-shaped win and loss code and comes
//      back as a valid 1200x630 PNG — and draws the same picture for the
//      same code.
//   5. Every failure path returns the static-card redirect, never an error.
//   6. The trading-card design itself: the lineup resolves names AND $
//      prices from the frozen pool (explicit names carry no price), the
//      frame is gold on the card's dark face, and the stamp is gold on a
//      win and grey on a loss.
//
// The card renderer needs pureimage, which is a production dependency, so
// this file runs where node_modules is installed (CI, or a scratch mirror
// with `npm install`); it does not run in a bare worktree checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import * as PImage from 'pureimage';

import {
  fantasyResultCode, parseFantasyResultCode, fantasyResultTitle,
} from '../scripts/fantasy-result.mjs';
import fantasyCard, { renderFantasyCard, resolveCardRows } from '../netlify/functions/fantasy_card.mjs';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Five real pool players in slot order V, G, B, D, W.
const pool = JSON.parse(readFileSync(new URL('../fantasy/pool.json', import.meta.url), 'utf8'));
const byName = Object.fromEntries(pool.map((p) => [p.name, p]));
const PICKS = [
  'David Lee Roth', 'Edward Van Halen', 'John Deacon', 'Neil Peart', 'Lindsey Buckingham',
].map((name) => byName[name].member_id);

const DATE = '2026-11-07';
const WIN_SCORE = 72.4;
const LOSS_SCORE = 64.9;

function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// --- result code ------------------------------------------------------------

test('result code round-trips for a win', () => {
  const code = fantasyResultCode({ date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS });
  assert.equal(code, `20261107-72.40-w-${PICKS.join('.')}`);
  const back = parseFantasyResultCode(code);
  assert.deepEqual(back, { date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS });
  assert.equal(
    fantasyResultTitle(back),
    'Fantasy Band Game · 2026-11-07 · 72.40 — beat the Gold line',
  );
});

test('result code round-trips for a loss', () => {
  const code = fantasyResultCode({ date: DATE, finalScore: LOSS_SCORE, won: false, picks: PICKS });
  assert.equal(code, `20261107-64.90-x-${PICKS.join('.')}`);
  const back = parseFantasyResultCode(code);
  assert.deepEqual(back, { date: DATE, finalScore: LOSS_SCORE, won: false, picks: PICKS });
  assert.equal(
    fantasyResultTitle(back),
    'Fantasy Band Game · 2026-11-07 · 64.90 — below the Gold line (69)',
  );
});

test('omitted won derives from the score against the Gold line of 69', () => {
  const win = fantasyResultCode({ date: DATE, finalScore: 70, picks: PICKS });
  assert.ok(win.includes('-w-'), '70 beats 69');
  assert.equal(parseFantasyResultCode(win).won, true);
  const edge = fantasyResultCode({ date: DATE, finalScore: 69, picks: PICKS });
  assert.ok(edge.includes('-x-'), 'exactly 69 does not beat the Gold line');
  assert.equal(parseFantasyResultCode(edge).won, false);
  const hair = fantasyResultCode({ date: DATE, finalScore: 69.01, picks: PICKS });
  assert.ok(hair.includes('-w-'), '69.01 beats the Gold line');
  // An explicit won still wins over the score — the caller's call.
  const explicit = fantasyResultCode({ date: DATE, finalScore: 70, won: false, picks: PICKS });
  assert.ok(explicit.includes('-x-'));
});

test('result code rejects what cannot be real', () => {
  const four = PICKS.slice(0, 4);
  const six = [...PICKS, PICKS[0]];
  const badPick = [...PICKS];
  badPick[2] = 'not-a-uuid';
  for (const args of [
    { date: DATE, finalScore: WIN_SCORE, won: true, picks: four },
    { date: DATE, finalScore: WIN_SCORE, won: true, picks: six },
    { date: DATE, finalScore: WIN_SCORE, won: true, picks: badPick },
    { date: '2026-02-30', finalScore: WIN_SCORE, won: true, picks: PICKS }, // Feb 30
    { date: '2026-13-01', finalScore: WIN_SCORE, won: true, picks: PICKS }, // month 13
    { date: '2026-11-7', finalScore: WIN_SCORE, won: true, picks: PICKS }, // not YYYY-MM-DD
    { date: DATE, finalScore: -1, won: true, picks: PICKS },
    { date: DATE, finalScore: Number.NaN, won: true, picks: PICKS },
    { date: DATE, finalScore: WIN_SCORE, won: 'yes', picks: PICKS },
    { finalScore: WIN_SCORE, won: true, picks: PICKS }, // no date
  ]) {
    assert.equal(fantasyResultCode(args), null, JSON.stringify(args));
  }

  const good = fantasyResultCode({ date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS });
  const fourUuidCode = `20261107-72.40-w-${PICKS.slice(0, 4).join('.')}`;
  const badDateCode = `20260230-72.40-w-${PICKS.join('.')}`;
  const badPickCode = good.replace(PICKS[2], 'not-a-uuid');
  const badFlagCode = good.replace('-w-', '-y-');
  const oneDpCode = good.replace('72.40', '72.4');
  for (const bad of [fourUuidCode, badDateCode, badPickCode, badFlagCode, oneDpCode, 'zzz', '', null, undefined, '20261107-72.40-w-']) {
    assert.equal(parseFantasyResultCode(bad), null, JSON.stringify(bad));
  }
});

// --- card -------------------------------------------------------------------

test('card draws a valid 1200x630 PNG for a win and a loss', async () => {
  for (const [label, score, won] of [['win', WIN_SCORE, true], ['loss', LOSS_SCORE, false]]) {
    const result = parseFantasyResultCode(
      fantasyResultCode({ date: DATE, finalScore: score, won, picks: PICKS }),
    );
    const png = await renderFantasyCard({ result });
    assert.ok(Buffer.isBuffer(png), `${label}: expected a Buffer`);
    assert.ok(png.length > 10000, `${label}: expected a real card, got ${png.length} bytes`);
    assert.ok(png.subarray(0, 8).equals(PNG_SIG), `${label}: PNG signature`);
    assert.deepEqual(pngSize(png), { width: 1200, height: 630 }, `${label}: dimensions`);
    const again = await renderFantasyCard({ result });
    assert.ok(png.equals(again), `${label}: same code must draw the same card`);
  }
});

test('card draws with explicit names instead of pool lookup', async () => {
  const result = parseFantasyResultCode(
    fantasyResultCode({ date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS }),
  );
  const png = await renderFantasyCard({
    result,
    names: ['Vocals One', 'Guitar Two', 'Bass Three', 'Drums Four', 'Wild Five'],
  });
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  assert.deepEqual(pngSize(png), { width: 1200, height: 630 });
});

test('card handler falls back to the static card on bad input', async () => {
  for (const r of [null, 'zzz', '']) {
    const res = await fantasyCard(new Request(`https://sixdegreesofrock.com/api/fantasy-card?r=${r || ''}`));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/game-og.png?v=3');
  }
  const winCode = fantasyResultCode({ date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS });
  const lossCode = fantasyResultCode({ date: DATE, finalScore: LOSS_SCORE, won: false, picks: PICKS });
  for (const code of [winCode, lossCode]) {
    const ok = await fantasyCard(new Request(`https://sixdegreesofrock.com/api/fantasy-card?r=${code}`));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
  }
});

// --- trading-card design ----------------------------------------------------

const byId = Object.fromEntries(pool.map((p) => [p.member_id, p]));

test('lineup rows resolve names and $ prices from the pool', () => {
  const result = parseFantasyResultCode(
    fantasyResultCode({ date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS }),
  );
  const rows = resolveCardRows(result);
  assert.deepEqual(rows.map((r) => r.slot), ['V', 'G', 'B', 'D', 'W']);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['David Lee Roth', 'Edward Van Halen', 'John Deacon', 'Neil Peart', 'Lindsey Buckingham'],
  );
  assert.deepEqual(rows.map((r) => r.price), PICKS.map((id) => byId[id].price0));
  // Explicit names carry no price — the card omits it rather than guessing.
  const named = resolveCardRows(result, ['Vocals One', 'Guitar Two', 'Bass Three', 'Drums Four', 'Wild Five']);
  assert.deepEqual(named.map((r) => r.name), ['Vocals One', 'Guitar Two', 'Bass Three', 'Drums Four', 'Wild Five']);
  assert.deepEqual(named.map((r) => r.price), [null, null, null, null, null]);
  // An unknown UUID never crashes the card — it draws as Unknown player.
  const unknown = resolveCardRows({
    ...result,
    picks: ['00000000-0000-0000-0000-000000000000', ...PICKS.slice(1)],
  });
  assert.equal(unknown[0].name, 'Unknown player');
  assert.equal(unknown[0].price, null);
});

async function decode(png) {
  return PImage.decodePNGFromStream(Readable.from(png));
}

function px(img, x, y) {
  const v = img.getPixelRGBA(x, y);
  return { r: (v >>> 24) & 0xff, g: (v >>> 16) & 0xff, b: (v >>> 8) & 0xff };
}

// Gold #d9b36c: red-dominant, warm. Grey-blue stamp #8a97a5: blue-dominant.
const isGold = ({ r, g, b }) => r >= 170 && g >= 130 && b <= 170 && r > b;
const isGrey = ({ r, g, b }) => r >= 100 && r <= 180 && g >= 115 && g <= 190 && b >= 130 && b <= 205 && b > r;

test('card is a gold-framed trading card, stamp gold on a win and grey on a loss', async () => {
  const winPng = await renderFantasyCard({
    result: parseFantasyResultCode(
      fantasyResultCode({ date: DATE, finalScore: WIN_SCORE, won: true, picks: PICKS }),
    ),
  });
  const lossPng = await renderFantasyCard({
    result: parseFantasyResultCode(
      fantasyResultCode({ date: DATE, finalScore: LOSS_SCORE, won: false, picks: PICKS }),
    ),
  });
  assert.ok(!winPng.equals(lossPng), 'win and loss draw different cards');
  const win = await decode(winPng);
  const loss = await decode(lossPng);
  for (const img of [win, loss]) {
    // Gold frame on the top and left edges (sampled across the stroke, so a
    // one-pixel raster shift cannot fail the test).
    assert.ok([22, 23, 24, 25, 26].some((y) => isGold(px(img, 600, y))), 'gold frame on the top edge');
    assert.ok([26, 27, 28, 29, 30].some((x) => isGold(px(img, x, 300))), 'gold frame on the left edge');
    // Dark card face between the header rule and the first lineup row.
    const face = px(img, 600, 135);
    assert.ok(face.r < 50 && face.g < 70 && face.b >= 20 && face.b <= 100, `dark face, got ${JSON.stringify(face)}`);
  }
  // Stamp top edge: gold WIN, grey LOSS.
  assert.ok([398, 399, 400, 401, 402].some((y) => isGold(px(win, 938, y))), 'gold WIN stamp');
  assert.ok([398, 399, 400, 401, 402].some((y) => isGrey(px(loss, 938, y))), 'grey LOSS stamp');
});
