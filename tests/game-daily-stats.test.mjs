// Wordle-style player stats (2026-10-08): played, win %, current and max
// streak, and a distribution of how close each win came to the shortest path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { liveStreak, maxStreak, statBucket, dailyStats } from '../netlify/functions/_daily.mjs';

test('statBucket: distance from the shortest path', () => {
  assert.equal(statBucket(3, 4), 'beat');
  assert.equal(statBucket(4, 4), 'par');
  assert.equal(statBucket(5, 4), 'plus1');
  assert.equal(statBucket(6, 4), 'plus2');
  assert.equal(statBucket(7, 4), 'plus3');
  assert.equal(statBucket(9, 4), 'plus3', 'anything past +3 (old runs before the move limit) lands in +3');
});

test('maxStreak: longest run of consecutive days', () => {
  assert.equal(maxStreak([]), 0);
  assert.equal(maxStreak(['2026-10-01']), 1);
  assert.equal(maxStreak(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06']), 3);
  assert.equal(maxStreak(['2026-10-06', '2026-10-05', '2026-10-05']), 2, 'order and duplicates do not matter');
});

test('liveStreak: a streak you stopped is not current', () => {
  const today = '2026-10-08';
  const dates = ['2026-10-04', '2026-10-05', '2026-10-06'];
  assert.equal(liveStreak(dates, today), 0, 'last played two days ago, no freeze: broken');
  assert.equal(liveStreak(dates, today, 1), 3, 'a freeze can still bridge yesterday');
  assert.equal(liveStreak([...dates, '2026-10-07'], today), 4, 'played yesterday: alive, today not played yet');
  assert.equal(liveStreak([...dates, '2026-10-07', today], today), 5);
  assert.equal(liveStreak([], today), 0);
});

test('dailyStats: first runs only, losses count as played, wins fill the distribution', () => {
  const stats = dailyStats({
    runs: [
      { chain_date: '2026-10-05', status: 'complete', hops_used: 4, par: 4 },
      { chain_date: '2026-10-06', status: 'complete', hops_used: 5, par: 4 },
      { chain_date: '2026-10-07', status: 'given_up', hops_used: 7, par: 4 },
      { chain_date: '2026-10-08', status: 'complete', hops_used: 3, par: 3 },
      { chain_date: '2026-10-09', status: 'active', hops_used: 1, par: 3 },
    ],
    completionDates: ['2026-10-05', '2026-10-06', '2026-10-08'],
    today: '2026-10-08',
  });
  assert.deepEqual(stats, {
    played: 4,
    wins: 3,
    win_pct: 75,
    current_streak: 1,
    max_streak: 2,
    distribution: { beat: 0, par: 2, plus1: 1, plus2: 0, plus3: 0 },
  });
});

test('the stats action reads first runs only and returns dailyStats', () => {
  const play = readFileSync(new URL('../netlify/functions/game_daily_play.mjs', import.meta.url), 'utf8');
  assert.match(play, /if \(action === 'stats'\) \{/);
  assert.match(play, /coalesce\(r\.run_number, 1\) = 1/);
  assert.match(play, /streak: liveStreak\(dates, pacificDate\(\), fresh\.freeze_count \?\? 0\)/, 'header streak is live too');
});
