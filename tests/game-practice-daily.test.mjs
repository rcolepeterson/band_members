// Practice on /daily/ (Aaron, 2026-11-04): after the Oct 24 /game ->
// /daily migration, ?practice=1 silently served the daily endpoint and
// the 'Play a practice puzzle' button just re-showed the completed
// daily. Root cause: isArenaPage() still tests /game/ only, and
// practiceMode required it. The fix is surgical: practiceMode also
// accepts the /daily/ path, while isArenaPage() itself is deliberately
// left alone — it also drives sign-in routing, the front door, and
// challenge queues, and widening it would change all of those too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');
const dailyHtml = readFileSync(join(root, 'daily/index.html'), 'utf8');
const practice = src.slice(src.indexOf('const practiceMode ='), src.indexOf('function practicePath'));
const arena = src.slice(src.indexOf('function isArenaPage()'), src.indexOf('async function isMyChallenge'));

test('practiceMode accepts /daily/ as well as the old /game/ arena page', () => {
  assert.ok(practice.includes("get('practice') === '1'"), 'still gated on ?practice=1');
  assert.ok(practice.includes('daily'), 'daily path recognised');
  assert.match(practice, /daily\\\/\?\$/, 'daily pathname test present');
  assert.ok(practice.includes('isArenaPage()'), 'old /game/ route still works');
});

test('isArenaPage() itself is untouched: still /game/ only', () => {
  assert.ok(arena.includes('/(^|\\/)game\\/?$/'), 'arena helper unchanged');
  assert.ok(!arena.includes('daily'), 'no daily widening leaked into the shared helper');
});

test('practice still routes to the Solo endpoint and the buttons still link here', () => {
  assert.ok(src.includes("return practiceMode ? '/api/game-solo/play' : dailyPath;"), 'practice hits Solo, daily hits daily');
  assert.ok(src.includes("href=\"/daily/?practice=1\""), 'warm-up link points at /daily/?practice=1');
  assert.ok(src.includes("window.location.href = '/daily/?practice=1';"), 'results button points at /daily/?practice=1');
  assert.ok(dailyHtml.includes('[?&](practice|invite|match|game)(=|&|$)'), 'front door still skipped for practice links');
});
