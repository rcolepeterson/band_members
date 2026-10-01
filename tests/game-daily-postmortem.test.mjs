// Post-mortem date gate — the answer must never leak while a day is live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { postmortemOpen } from '../netlify/functions/game_daily_postmortem.mjs';

test('postmortemOpen: today and yesterday stay closed', () => {
  assert.equal(postmortemOpen('2026-10-01', '2026-10-01'), false);
  assert.equal(postmortemOpen('2026-09-30', '2026-10-01'), false);
});

test('postmortemOpen: two days out and older open', () => {
  assert.equal(postmortemOpen('2026-09-29', '2026-10-01'), true);
  assert.equal(postmortemOpen('2026-09-20', '2026-10-01'), true);
});

test('postmortemOpen: future dates stay closed', () => {
  assert.equal(postmortemOpen('2026-10-02', '2026-10-01'), false);
});

test('postmortemOpen: holds across a month boundary', () => {
  assert.equal(postmortemOpen('2026-09-29', '2026-10-01'), true);
  assert.equal(postmortemOpen('2026-09-30', '2026-10-01'), false);
});
