// One-tap share (Cole, 2026-10-14): Facebook and Instagram drop pre-filled
// share text, so the score rides in the link and shows in its preview.
// scripts/daily-result.mjs (the code), og_daily.js (the preview tags),
// daily_card.mjs (the picture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resultCode, parseDailyResultCode, dailyResultTitle } from '../scripts/daily-result.mjs';
import { dailyShareLink } from '../scripts/six-degrees-game.mjs';
import ogDaily from '../netlify/edge-functions/og_daily.js';
import { renderDailyCard, dailyDateForNumber } from '../netlify/functions/daily_card.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const picks = [{ kind: 'optimal' }, { kind: 'deadend' }, { kind: 'solid' }, { kind: 'optimal' }];

test('a result becomes a short code and back', () => {
  assert.equal(resultCode(15, picks, true), '15-odso');
  assert.equal(resultCode(15, picks, false), '15x-odso');
  assert.deepEqual(parseDailyResultCode('15-odso'), { num: 15, won: true, kinds: ['o', 'd', 's', 'o'] });
  assert.deepEqual(parseDailyResultCode('15x-'), { num: 15, won: false, kinds: [] });
  assert.equal(dailyResultTitle(parseDailyResultCode('15-odso')), '6° Rock #15 · Solved in 4 moves');
  assert.equal(dailyResultTitle(parseDailyResultCode('15-o')), '6° Rock #15 · Solved in 1 move');
  assert.equal(dailyResultTitle(parseDailyResultCode('15x-ds')), '6° Rock #15 · Not solved');
});

test('anything else in the code is rejected, so nothing from the URL reaches the page', () => {
  for (const bad of ['', '0-o', '15', '15-oz', '15-<b>', '15-o"', 'abc-o', '12345-o', `15-${'o'.repeat(21)}`]) {
    assert.equal(parseDailyResultCode(bad), null, bad);
  }
});

test('the share link carries the code and keeps ?s=1 for analytics', () => {
  assert.equal(dailyShareLink({ date: '2026-10-14', picks, won: true }), 'https://sixdegreesofrock.com/game?s=1&r=15-odso');
  assert.equal(dailyShareLink({}), 'https://sixdegreesofrock.com/game?s=1');
  assert.equal(dailyDateForNumber(15), '2026-10-14');
  assert.equal(dailyDateForNumber(1), '2026-09-30');
});

const gamePage = read('../game/index.html');
const ctx = { next: async () => new Response(gamePage, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };

test('a shared result previews its score, picture and own link', async () => {
  const res = await ogDaily(new Request('https://sixdegreesofrock.com/game/?s=1&r=15-odso'), ctx);
  const html = await res.text();
  assert.match(html, /<meta property="og:title" content="6° Rock #15 · Solved in 4 moves"/);
  assert.match(html, /<meta name="twitter:title" content="6° Rock #15 · Solved in 4 moves"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/sixdegreesofrock\.com\/api\/daily-card\?r=15-odso"/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/sixdegreesofrock\.com\/api\/daily-card\?r=15-odso"/);
  // Its own og:url, or Facebook folds it back into the generic /game preview.
  assert.match(html, /<meta property="og:url" content="https:\/\/sixdegreesofrock\.com\/game\/\?s=1&amp;r=15-odso"/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
});

test('an ordinary /game visit, or a bad code, is passed through untouched', async () => {
  assert.equal(await ogDaily(new Request('https://sixdegreesofrock.com/game/'), ctx), undefined);
  assert.equal(await ogDaily(new Request('https://sixdegreesofrock.com/game/?s=1'), ctx), undefined);
  assert.equal(await ogDaily(new Request('https://sixdegreesofrock.com/game/?r=%22%3E%3Cscript%3E'), ctx), undefined);
  assert.match(read('../netlify/edge-functions/og_daily.js'), /export const config = \{ path: '\/game\/' \};/);
});

test('the card draws a PNG, and ships with its font', async () => {
  const png = await renderDailyCard({ result: parseDailyResultCode('15-odso'), start: 'Ramones', target: 'Velvet Revolver' });
  assert.ok(png && png.length > 1000);
  assert.deepEqual([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  assert.equal(await renderDailyCard({ result: null }), null);
  assert.match(read('../netlify.toml'), /\[functions\.daily_card\]\n[^[]*included_files = \["vendor\/fonts\/og\/\*\*"\]/);
});

test('the card only reads the day\'s two band names, and never deals a future day', () => {
  const src = read('../netlify/functions/daily_card.mjs');
  assert.match(src, /if \(date > pacificDate\(\)\) return \{\};/);
  assert.match(src, /select band_a, band_b from daily_chains where date = \$\{date\} limit 1/);
  assert.match(src, /select id, name from bands where id in \(\$\{chain\.band_a\}, \$\{chain\.band_b\}\)/);
  assert.match(src, /'cache-control': 'public, max-age=86400, s-maxage=604800'/);
});

test('every share button sends the score link', () => {
  const src = read('../scripts/six-degrees-game.mjs');
  assert.equal((src.match(/shareDailyText\([^)]*\), dailyResultShareLink\(/g) || []).length, 2, 'win and loss boards');
  assert.ok(src.includes('shareDailyText(shareBtn, text, dailyResultShareLink(won, completed))'), 'results modal');
  assert.ok(src.includes("await navigator.share({ title: '6° Rock', text, url: shareUrl });"));
});
