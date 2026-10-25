// Rawkle share cards: result-code contract, card renderer, edge rewrite.
//
// Mirrors tests/game-share-card.test.mjs and tests/og-preview.test.mjs:
// the preview is the one part of the product nobody on the team ever sees
// while working on it (it renders on Facebook's servers), so its properties
// are checked here rather than trusted to a glance at a deploy.
//
// What this locks in:
//   1. The result code round-trips, and rejects codes that cannot be real.
//   2. The preview title reads "Rawkle #N · Solved in X tries" / "Not solved".
//   3. The card draws for a production-shaped result and comes back as a
//      valid PNG — and draws the same picture for the same code.
//   4. Every failure path returns the static-card redirect, never an error.
//   5. The edge function rewrites the preview for a share link, escapes
//      nothing it should not, and leaves ordinary visits untouched.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rawkleResultCode, parseRawkleResultCode, rawkleResultTitle,
} from '../scripts/rawkle-result.mjs';
import rawkleCard, { renderRawkleCard } from '../netlify/functions/rawkle_card.mjs';
import ogRawkle from '../netlify/edge-functions/og_rawkle.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CODE = '2-gbbbab.gbbbaa.bbbbbb.gggggggggg'; // a 4-try win, 4+6 board
const PAGE = [
  '<meta property="og:title" content="Rawkle by Six Degrees" />',
  '<meta property="og:description" content="Guess the band. One famous band a day, six tries." />',
  '<meta property="og:image" content="https://sixdegreesofrock.com/rawkle-og.png" />',
  '<meta property="og:url" content="https://sixdegreesofrock.com/rawkle" />',
  '<meta name="twitter:title" content="Rawkle by Six Degrees" />',
  '<meta name="twitter:description" content="Guess the band. One famous band a day, six tries." />',
  '<meta name="twitter:image" content="https://sixdegreesofrock.com/rawkle-og.png" />',
].join('\n');

test('result code round-trips and the title reads like Daily', () => {
  const code = rawkleResultCode(2, ['gbbbab', 'gbbbaa', 'bbbbbb', 'gggggggggg'], true);
  assert.equal(code, CODE);
  const back = parseRawkleResultCode(code);
  assert.equal(back.num, 2);
  assert.equal(back.won, true);
  assert.equal(back.rows.length, 4);
  assert.equal(rawkleResultTitle(back), 'Rawkle #2 · Solved in 4 tries');
  const loss = parseRawkleResultCode(rawkleResultCode(3, ['a', 'a', 'a', 'a', 'a', 'a'], false));
  assert.equal(loss.won, false);
  assert.equal(rawkleResultTitle(loss), 'Rawkle #3 · Not solved');
  const one = parseRawkleResultCode(rawkleResultCode(1, ['ggggggg'], true));
  assert.equal(rawkleResultTitle(one), 'Rawkle #1 · Solved in 1 try');
});

test('result code rejects what cannot be real', () => {
  for (const bad of ['2-zzz', '0-gb', '2-', '2-gb..gb', '', null, '2-g'.repeat(30)]) {
    assert.equal(parseRawkleResultCode(bad), null, JSON.stringify(bad));
  }
  assert.equal(rawkleResultCode(0, ['gb'], true), null);
  assert.equal(rawkleResultCode(2, [], true), null);
});

test('card draws a valid PNG for a production-shaped result', async () => {
  const png = await renderRawkleCard({ result: parseRawkleResultCode(CODE) });
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 10000, `expected a real card, got ${png.length} bytes`);
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  const again = await renderRawkleCard({ result: parseRawkleResultCode(CODE) });
  assert.ok(png.equals(again), 'same code must draw the same card');
});

test('card handler falls back to the static card on bad input', async () => {
  for (const r of [null, 'zzz', '']) {
    const res = await rawkleCard(new Request(`https://sixdegreesofrock.com/api/rawkle-card?r=${r || ''}`));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/rawkle-og.png');
  }
  const ok = await rawkleCard(new Request(`https://sixdegreesofrock.com/api/rawkle-card?r=${CODE}`));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
});

test('edge function rewrites a share link and passes ordinary visits through', async () => {
  const context = {
    next: async () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
  };
  const shared = await ogRawkle(
    new Request('https://sixdegreesofrock.com/rawkle?s=1&r=' + CODE), context
  );
  assert.ok(shared, 'expected a rewritten response');
  const html = await shared.text();
  assert.ok(html.includes('content="Rawkle #2 · Solved in 4 tries"'), 'title rewritten');
  assert.ok(html.includes(`content="https://sixdegreesofrock.com/api/rawkle-card?r=${CODE}"`), 'image rewritten');
  assert.ok(html.includes('content="https://sixdegreesofrock.com/rawkle?s=1&amp;r=' + CODE + '"'), 'url rewritten');
  assert.ok(!html.includes('rawkle-og.png'), 'no static image left in a share preview');

  const plain = await ogRawkle(new Request('https://sixdegreesofrock.com/rawkle'), context);
  assert.equal(plain, undefined, 'ordinary visit passes through untouched');
  const bad = await ogRawkle(new Request('https://sixdegreesofrock.com/rawkle?s=1&r=zzz'), context);
  assert.equal(bad, undefined, 'unparseable code passes through untouched');
});
