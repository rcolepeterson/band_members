// Daily Chain core logic tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSeed,
  mulberry32,
  pacificDate,
  validChainDate,
  dayDiff,
  addDays,
  buildBandAdj,
  bfsDist,
  bfsPath,
  pickDailyPair,
  optionsFor,
  pickColor,
  sharePicks,
  dailyShareText,
  hintsFor,
  applyCompletion,
  currentStreak,
  scoreRun,
  HINT_COST,
  ESCAPE_COST,
  MIN_HOPS,
  MAX_HOPS,
} from '../netlify/functions/_daily.mjs';

// --- economy constants -------------------------------------------------------

test('escape costs 5x a hint', () => {
  assert.equal(ESCAPE_COST, HINT_COST * 5);
});

test('hintsFor is floor(optimal/2): 5 hops -> 2 hints', () => {
  assert.equal(hintsFor(5), 2);
  assert.equal(hintsFor(3), 1);
  assert.equal(hintsFor(6), 3);
  assert.equal(hintsFor(4), 2);
});

// --- seeded PRNG determinism -------------------------------------------------

test('same seed -> same sequence; different seed -> different', () => {
  const a = mulberry32(hashSeed('2026-10-01'));
  const b = mulberry32(hashSeed('2026-10-01'));
  const c = mulberry32(hashSeed('2026-10-02'));
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

// --- dates -------------------------------------------------------------------

test('validChainDate accepts real dates, rejects garbage', () => {
  assert.equal(validChainDate('2026-10-01'), '2026-10-01');
  assert.equal(validChainDate('2026-02-30'), null); // impossible date
  assert.equal(validChainDate('not-a-date'), null);
  assert.equal(validChainDate('2026-13-01'), null);
  assert.equal(validChainDate(null), null);
});

test('dayDiff counts whole days', () => {
  assert.equal(dayDiff('2026-10-01', '2026-10-01'), 0);
  assert.equal(dayDiff('2026-10-01', '2026-10-03'), 2);
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
});

test('pacificDate returns YYYY-MM-DD', () => {
  assert.match(pacificDate(new Date('2026-10-01T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

// --- graph -------------------------------------------------------------------

// Toy graph: b1 -m1- b2 -m2- b3 -m3- b4  (linear, 3 hops b1->b4)
//            b2 -m4- b5 (side branch)
function toyMemberships() {
  return [
    { band_id: 'b1', member_id: 'm1' },
    { band_id: 'b2', member_id: 'm1' },
    { band_id: 'b2', member_id: 'm2' },
    { band_id: 'b3', member_id: 'm2' },
    { band_id: 'b3', member_id: 'm3' },
    { band_id: 'b4', member_id: 'm3' },
    { band_id: 'b2', member_id: 'm4' },
    { band_id: 'b5', member_id: 'm4' },
  ];
}

test('buildBandAdj links bands sharing a member', () => {
  const { adj, degree } = buildBandAdj(toyMemberships());
  assert.ok(adj.get('b1').has('b2'));
  assert.ok(adj.get('b2').has('b1') && adj.get('b2').has('b3') && adj.get('b2').has('b5'));
  assert.ok(!adj.get('b1').has('b3'));
  assert.equal(degree.get('b2'), 3);
  assert.equal(degree.get('b5'), 1);
});

test('bfsDist measures band hops from target', () => {
  const { adj } = buildBandAdj(toyMemberships());
  const dist = bfsDist(adj, 'b4');
  assert.equal(dist.get('b4'), 0);
  assert.equal(dist.get('b3'), 1);
  assert.equal(dist.get('b1'), 3);
  assert.equal(dist.get('b5'), 3); // b5-b2-b3-b4
});

// --- daily pair lottery --------------------------------------------------------

test('pickDailyPair is deterministic for a date seed', () => {
  const { adj } = buildBandAdj(toyMemberships());
  const ids = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const p1 = pickDailyPair({ bandIds: ids, adj, seed: '2026-10-01', minHops: 2, maxHops: 4 });
  const p2 = pickDailyPair({ bandIds: ids, adj, seed: '2026-10-01', minHops: 2, maxHops: 4 });
  assert.deepEqual(p1, p2);
  assert.ok(p1.hops >= 2 && p1.hops <= 4);
});

test('pickDailyPair respects the no-repeat exclusion set', () => {
  const { adj } = buildBandAdj(toyMemberships());
  const ids = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const first = pickDailyPair({ bandIds: ids, adj, seed: '2026-10-01', minHops: 2, maxHops: 4 });
  const key = first.a < first.b ? `${first.a}|${first.b}` : `${first.b}|${first.a}`;
  const second = pickDailyPair({
    bandIds: ids, adj, seed: '2026-10-01', minHops: 2, maxHops: 4,
    excludeKeys: new Set([key]),
  });
  // In this tiny graph the only 2-4 hop pairs may be exhausted; either we get
  // a different pair or null — never the excluded one.
  if (second) {
    const k2 = second.a < second.b ? `${second.a}|${second.b}` : `${second.b}|${second.a}`;
    assert.notEqual(k2, key);
  }
});

// --- options -----------------------------------------------------------------

function toyMeta() {
  return new Map([
    ['b1', { name: 'B1', genre: 'rock' }],
    ['b2', { name: 'B2', genre: 'rock' }],
    ['b3', { name: 'B3', genre: 'rock' }],
    ['b4', { name: 'B4', genre: 'rock' }],
    ['b5', { name: 'B5', genre: 'rock' }],
    ['b6', { name: 'B6', genre: 'rock' }], // isolated-ish trap: connected far away
  ]);
}

test('optionsFor includes an optimal pick and a dead end', () => {
  const { adj, degree } = buildBandAdj(toyMemberships());
  const dist = bfsDist(adj, 'b4'); // target b4; from b1 distance is 3
  const rng = mulberry32(42);
  const opts = optionsFor({ adj, dist, degree, meta: toyMeta(), currentId: 'b1', rng });
  assert.ok(opts.length >= 2);
  const kinds = new Set(opts.map((o) => o.kind));
  // b2 is the only neighbor of b1 and it's optimal (dist 2 = 3-1)
  assert.ok(kinds.has('optimal'));
  // b6 is not a neighbor -> dead end fills the slate
  assert.ok(kinds.has('deadend'));
  assert.ok(opts.every((o) => o.band_id && o.kind));
  assert.equal(new Set(opts.map((o) => o.band_id)).size, opts.length); // unique
});

test('optionsFor never offers the target as a dead end from far away', () => {
  const { adj, degree } = buildBandAdj(toyMemberships());
  const dist = bfsDist(adj, 'b4');
  const rng = mulberry32(7);
  // From b2 (dist 2): neighbors b1 (3), b3 (1, optimal), b5 (3)
  const opts = optionsFor({ adj, dist, degree, meta: toyMeta(), currentId: 'b2', rng });
  const byId = new Map(opts.map((o) => [o.band_id, o.kind]));
  assert.equal(byId.get('b3'), 'optimal');
  assert.ok(byId.get('b5') === 'solid' || byId.get('b5') === 'obscure');
});

test('the target is never dealt as a dead-end trap', () => {
  const { adj, degree } = buildBandAdj(toyMemberships());
  const dist = bfsDist(adj, 'b4');
  // From b1 (dist 3): b4 is not a neighbor — without the guard it could be a trap.
  for (let seed = 1; seed <= 20; seed++) {
    const opts = optionsFor({
      adj, dist, degree, meta: toyMeta(), currentId: 'b1',
      rng: mulberry32(seed), trapExcludeIds: new Set(['b4']),
    });
    const trap = opts.find((o) => o.band_id === 'b4');
    assert.ok(!trap || trap.kind !== 'deadend', `seed ${seed}: target dealt as trap`);
  }
});

// --- pick colors ----------------------------------------------------------------

test('pickColor maps kinds to gold/robin/black', () => {
  assert.equal(pickColor('optimal'), 'gold');
  assert.equal(pickColor('solid'), 'robin');
  assert.equal(pickColor('obscure'), 'robin');
  assert.equal(pickColor('deadend'), 'black');
});

test('sharePicks renders one square per pick in order', () => {
  const picks = [{ kind: 'optimal' }, { kind: 'solid' }, { kind: 'deadend' }, { kind: 'obscure' }];
  assert.equal(sharePicks(picks), '🟨🟦⬛🟦');
});

test('dailyShareText frames the constellation, names the void', () => {
  const text = dailyShareText({
    date: '2026-10-01', handle: 'rawker1', hopsUsed: 4, par: 3, streak: 12,
    picks: [{ kind: 'optimal' }, { kind: 'deadend' }, { kind: 'solid' }, { kind: 'optimal' }],
  });
  assert.ok(text.includes('2026-10-01'));
  assert.ok(text.includes('4 hops (par 3)'));
  assert.ok(text.includes('Streak 12'));
  assert.ok(text.includes('rawker1'));
  assert.ok(text.includes('constellation'));
  assert.ok(text.includes('🟨⬛🟦🟨'));
});

// --- streaks --------------------------------------------------------------------

test('completing consecutive days extends the streak', () => {
  let r = applyCompletion({ dates: [], newDate: '2026-10-01' });
  assert.equal(r.streak, 1);
  assert.equal(r.freezeUsed, false);
  r = applyCompletion({ dates: r.dates, newDate: '2026-10-02' });
  assert.equal(r.streak, 2);
});

test('missing a day breaks the streak', () => {
  const r = applyCompletion({ dates: ['2026-10-01'], newDate: '2026-10-03' });
  assert.equal(r.streak, 1);
  assert.equal(r.freezeUsed, false);
});

test('Seattle Freeze bridges exactly one missed day', () => {
  const r = applyCompletion({ dates: ['2026-10-01'], newDate: '2026-10-03', freezeCount: 1 });
  assert.equal(r.freezeUsed, true);
  assert.equal(r.frozenDate, '2026-10-02');
  assert.equal(r.streak, 3);
});

test('freeze does not burn on a longer absence', () => {
  const r = applyCompletion({ dates: ['2026-10-01'], newDate: '2026-10-04', freezeCount: 1 });
  assert.equal(r.freezeUsed, false);
  assert.equal(r.streak, 1);
});

test('freeze does not burn on first play', () => {
  const r = applyCompletion({ dates: [], newDate: '2026-10-01', freezeCount: 1 });
  assert.equal(r.freezeUsed, false);
  assert.equal(r.streak, 1);
});

test('archive backfill repairs the streak', () => {
  // Played Mon, missed Tue, played Wed (streak reset to 1), then buys Tue.
  let r = applyCompletion({ dates: ['2026-09-29'], newDate: '2026-10-01' });
  assert.equal(r.streak, 1);
  r = applyCompletion({ dates: r.dates, newDate: '2026-09-30' });
  assert.equal(r.streak, 3);
  assert.deepEqual(r.dates, ['2026-09-29', '2026-09-30', '2026-10-01']);
});

test('re-completing the same day is idempotent', () => {
  const r = applyCompletion({ dates: ['2026-10-01'], newDate: '2026-10-01' });
  assert.equal(r.streak, 1);
});

test('currentStreak derives the trailing run', () => {
  assert.equal(currentStreak([]), 0);
  assert.equal(currentStreak(['2026-10-01', '2026-10-02', '2026-10-04']), 1);
  assert.equal(currentStreak(['2026-10-02', '2026-10-03', '2026-10-04']), 3);
});

test('MIN/MAX hops bound the daily deal', () => {
  assert.equal(MIN_HOPS, 3);
  assert.equal(MAX_HOPS, 6);
});

// --- replay economy ----------------------------------------------------------

test('scoreRun: first completion pays 20, +10 on par', () => {
  assert.deepEqual(scoreRun({ isFirst: true, hopsUsed: 6, par: 4, prevBest: null }), { reward: 20, beatTree: false, newPar: 4 });
  assert.deepEqual(scoreRun({ isFirst: true, hopsUsed: 4, par: 4, prevBest: null }), { reward: 30, beatTree: false, newPar: 4 });
});

test('scoreRun: replays pay only for beating your best (5/hop)', () => {
  assert.deepEqual(scoreRun({ isFirst: false, hopsUsed: 6, par: 4, prevBest: 13 }), { reward: 35, beatTree: false, newPar: 4 });
  assert.deepEqual(scoreRun({ isFirst: false, hopsUsed: 13, par: 4, prevBest: 13 }), { reward: 0, beatTree: false, newPar: 4 });
  assert.deepEqual(scoreRun({ isFirst: false, hopsUsed: 15, par: 4, prevBest: 13 }), { reward: 0, beatTree: false, newPar: 4 });
  assert.deepEqual(scoreRun({ isFirst: false, hopsUsed: 4, par: 4, prevBest: 6 }), { reward: 10, beatTree: false, newPar: 4 });
});

test('scoreRun: beating the tree pays the bounty and lowers par', () => {
  assert.deepEqual(scoreRun({ isFirst: true, hopsUsed: 3, par: 4, prevBest: null }), { reward: 70, beatTree: true, newPar: 3 });
  assert.deepEqual(scoreRun({ isFirst: false, hopsUsed: 3, par: 4, prevBest: 13 }), { reward: 100, beatTree: true, newPar: 3 });
});

test('dailyShareText has a beat-the-tree variant', () => {
  const text = dailyShareText({ date: '2026-10-01', handle: 'aaron', hopsUsed: 3, par: 4, streak: 5, picks: [], beatTree: true });
  assert.match(text, /I BEAT THE TREE in 3 hops \(par was 4\)/);
});

// --- give-up reveal ------------------------------------------------------------

test('bfsPath returns the shortest route as node ids', () => {
  const adj = new Map([
    ['a', ['b', 'd']],
    ['b', ['a', 'c']],
    ['c', ['b']],
    ['d', ['a', 'c']],
  ]);
  assert.deepEqual(bfsPath(adj, 'a', 'c'), ['a', 'b', 'c']);
  assert.deepEqual(bfsPath(adj, 'a', 'a'), ['a']);
  assert.equal(bfsPath(new Map([['a', []]]), 'a', 'c'), null);
});

test('dailyShareText has a give-up variant', () => {
  const text = dailyShareText({ date: '2026-10-01', handle: 'aaron', hopsUsed: 17, par: 4, streak: 0, picks: [], gaveUp: true });
  assert.match(text, /The tree beat me today/);
  assert.match(text, /par was 4/);
  assert.match(text, /17 hops deep/);
});
