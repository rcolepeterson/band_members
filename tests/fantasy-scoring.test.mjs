// Fantasy Band Game — pure-function tests (node --test).
// Imports the scoring/draft-rule functions from the page's own module
// (../fantasy/fantasy-game.mjs) and the shipped pool data, so the tests
// verify the exact code and data that ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GOLD_LINE, SALARY_CAP,
  connectionPairs, connectionBonus, provisionalScore, finalScore,
  isWin, capTotal, movePick, removePick, canFillSlot, validateDraft,
  canSubmit, sortLeaderboard, normalizeLeaderboard, playsLine, displayBands, tierFor,
  winsToNextTier, SLOTS,
} from '../fantasy/fantasy-game.mjs';

const pool = JSON.parse(readFileSync(new URL('../fantasy/pool.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(pool.map((p) => [p.member_id, p]));
const byName = Object.fromEntries(pool.map((p) => [p.name, p]));
const pick = (name) => byName[name];

// --- connection pairs -----------------------------------------------------

test('connectionPairs finds a shared band and names it', () => {
  const pairs = connectionPairs([
    pick('Chris Cornell'), pick('Eddie Vedder'), pick('John Bonham'),
  ]);
  // Cornell + Vedder share Temple of the Dog; Bonham shares nothing here.
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, 'Chris Cornell');
  assert.equal(pairs[0].b, 'Eddie Vedder');
  assert.equal(pairs[0].band, 'Temple of the Dog');
});

test('connectionPairs is empty when nobody played together', () => {
  const pairs = connectionPairs([
    pick('John Bonham'), pick('Neil Peart'), pick('Freddie Mercury'),
  ]);
  assert.deepEqual(pairs, []);
});

test('connectionPairs counts each pair once and picks the first shared band alphabetically', () => {
  // Page + Plant share Led Zeppelin, Jimmy Page & Robert Plant and more.
  const pairs = connectionPairs([pick('Jimmy Page'), pick('Robert Plant')]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].band, 'Jimmy Page & Robert Plant');
});

test('connectionBonus is +4 a pair, capped at +16', () => {
  assert.equal(connectionBonus([]), 0);
  assert.equal(connectionBonus([1, 2, 3].map((i) => ({ a: `a${i}`, b: `b${i}`, band: 'X' }))), 12);
  const ten = Array.from({ length: 10 }, (_, i) => ({ a: `a${i}`, b: `b${i}`, band: 'X' }));
  assert.equal(connectionBonus(ten), 16);
});

// --- provisional score ------------------------------------------------------

test('provisionalScore is sum(V) + bonus, with no crowd-split', () => {
  // Pearl Jam core: Vedder 21.16 + McCready 36.16 + Gossard 27.36 +
  // Ament 28.16 + Cameron 32.73 = 145.57. Every pair shares Pearl Jam
  // (10 pairs) so the bonus caps at +16, not +40.
  const five = ['Eddie Vedder', 'Mike McCready', 'Stone Gossard', 'Jeff Ament', 'Matt Cameron'].map(pick);
  const prov = provisionalScore(five);
  assert.equal(prov.value, 145.57);
  assert.equal(prov.pairs.length, 10);
  assert.equal(prov.connectionBonus, 16);
  assert.equal(prov.total, 161.57);
});

test('provisionalScore of five loners is just sum(V)', () => {
  const five = ['John Bonham', 'Neil Peart', 'Freddie Mercury', 'Jimi Hendrix', 'Lemmy Kilmister'].map(pick);
  const prov = provisionalScore(five);
  assert.equal(prov.pairs.length, 0);
  assert.equal(prov.connectionBonus, 0);
  assert.equal(prov.total, 63.07); // 15.11 + 6.95 + 10 + 16.6 + 14.41, rounded
});

// --- final score / crowd-split ---------------------------------------------

test('finalScore waters down a pick by 1 / (1 + 0.5 * share)', () => {
  const five = ['Neil Peart'].map(pick);
  // Peart V 6.95, picked by 60% of the day: 6.95 / 1.3 = 5.35 (rounded).
  const f = finalScore(five, { [pick('Neil Peart').member_id]: 0.6 });
  assert.equal(f.perPlayer[0].adjustedV, 5.35);
  assert.equal(f.crowdDelta, -1.6);
  assert.equal(f.final, 5.35);
});

test('finalScore with no shares equals the provisional score', () => {
  const five = ['Eddie Vedder', 'Mike McCready', 'Stone Gossard', 'Jeff Ament', 'Matt Cameron'].map(pick);
  const f = finalScore(five, {});
  assert.equal(f.final, 161.57);
  assert.equal(f.crowdDelta, 0);
});

test('finalScore applies the spec example: 60% pick keeps about 77% of value', () => {
  // Spec section 4: V 20 at 60% share keeps ~77% (20 / 1.3 = 15.38).
  const fake = [{ member_id: 'x', name: 'Fake', V: 20, all_bands: ['Solo'] }];
  const f = finalScore(fake, { x: 0.6 });
  assert.equal(f.perPlayer[0].adjustedV, 15.38);
});

test('finalScore: a pick nobody else took is untouched, a pick everyone took loses a third', () => {
  const fake = [
    { member_id: 'a', name: 'A', V: 10, all_bands: ['Band A'] },
    { member_id: 'b', name: 'B', V: 30, all_bands: ['Band B'] },
  ];
  const f = finalScore(fake, { a: 0, b: 1 });
  assert.equal(f.perPlayer[0].adjustedV, 10);
  assert.equal(f.perPlayer[1].adjustedV, 20); // 30 / 1.5
  assert.equal(f.final, 30);
});

test('win is strictly greater than 69', () => {
  assert.equal(isWin(69), false);
  assert.equal(isWin(69.01), true);
  assert.equal(isWin(68.99), false);
});

// --- cap and draft rules ----------------------------------------------------

test('capTotal sums prices; the all-star five cost $235', () => {
  const five = ['Mike McCready', 'Matt Cameron', 'Chris Cornell', 'Stone Gossard', 'Duff McKagan'].map(pick);
  assert.equal(capTotal(five), 235);
  assert.ok(capTotal(five) > SALARY_CAP);
});

test('movePick moves a player to the second slot — never duplicates', () => {
  let slots = { V: null, G: null, B: null, D: null, W: null };
  const cobain = pick('Kurt Cobain').member_id; // eligible G + V
  slots = movePick(slots, 'V', cobain);
  assert.equal(slots.V, cobain);
  slots = movePick(slots, 'G', cobain); // last choice wins
  assert.equal(slots.G, cobain);
  assert.equal(slots.V, null);
  const filled = Object.values(slots).filter(Boolean);
  assert.equal(new Set(filled).size, filled.length);
});

test('removePick clears only that slot', () => {
  const id = pick('Flea').member_id;
  const slots = removePick({ V: null, G: null, B: id, D: null, W: null }, 'B');
  assert.deepEqual(slots, { V: null, G: null, B: null, D: null, W: null });
});

test('canFillSlot: named slots need the letter, wild card takes anyone', () => {
  assert.equal(canFillSlot(pick('Neil Peart'), 'D'), true);
  assert.equal(canFillSlot(pick('Neil Peart'), 'V'), false);
  assert.equal(canFillSlot(pick('Neil Peart'), 'W'), true);
  assert.equal(canFillSlot(pick('Ray Manzarek'), 'W'), true);
  assert.equal(canFillSlot(pick('Ray Manzarek'), 'G'), false);
  assert.equal(canFillSlot(pick('Kurt Cobain'), 'G'), true);
  assert.equal(canFillSlot(pick('Kurt Cobain'), 'V'), true);
  assert.equal(canFillSlot(pick('Kurt Cobain'), 'B'), false);
});

test('validateDraft rejects an incomplete draft', () => {
  const slots = { V: pick('Robert Plant').member_id, G: null, B: null, D: null, W: null };
  const v = validateDraft(slots, byId);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /five slots/);
});

test('validateDraft rejects an over-cap draft', () => {
  const slots = {
    V: pick('Chris Cornell').member_id, // 45
    G: pick('Mike McCready').member_id, // 50
    B: pick('Jeff Ament').member_id, // 45
    D: pick('Matt Cameron').member_id, // 50
    W: pick('Dave Grohl').member_id, // 45
  };
  const v = validateDraft(slots, byId);
  assert.equal(v.ok, false);
  assert.equal(v.total, 235);
  assert.match(v.errors.join(' '), /over the \$100 cap/);
});

test('validateDraft rejects a player in a slot they cannot play', () => {
  const slots = {
    V: pick('Neil Peart').member_id, // drums only
    G: pick('Jimmy Page').member_id,
    B: pick('Flea').member_id,
    D: pick('John Bonham').member_id,
    W: pick('Dave Grohl').member_id,
  };
  const v = validateDraft(slots, byId);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /cannot play Vocalist/);
});

test('validateDraft accepts a legal $100-or-less draft', () => {
  // Plant 30 + Page 40 + Newsted 25 ... over; use a cheap legal five:
  // Roth 15 + EVH 15 + Deacon 10 + Peart 10 + Buckingham 10 = 60.
  const slots = {
    V: pick('David Lee Roth').member_id,
    G: pick('Edward Van Halen').member_id,
    B: pick('John Deacon').member_id,
    D: pick('Neil Peart').member_id,
    W: pick('Lindsey Buckingham').member_id,
  };
  const v = validateDraft(slots, byId);
  assert.equal(v.ok, true);
  assert.equal(v.total, 60);
});

test('canSubmit (ghosted-submit rule): false until five filled within $100', () => {
  const empty = { V: null, G: null, B: null, D: null, W: null };
  assert.equal(canSubmit(empty, byId), false);
  const four = {
    V: pick('David Lee Roth').member_id, G: pick('Edward Van Halen').member_id,
    B: pick('John Deacon').member_id, D: pick('Neil Peart').member_id, W: null,
  };
  assert.equal(canSubmit(four, byId), false);
  const legal = { ...four, W: pick('Lindsey Buckingham').member_id };
  assert.equal(canSubmit(legal, byId), true);
  const over = {
    V: pick('Chris Cornell').member_id, G: pick('Mike McCready').member_id,
    B: pick('Jeff Ament').member_id, D: pick('Matt Cameron').member_id,
    W: pick('Dave Grohl').member_id,
  };
  assert.equal(canSubmit(over, byId), false);
});

// --- leaderboard order ------------------------------------------------------

test('sortLeaderboard: score desc, then connection bonus, then earliest submission', () => {
  const entries = [
    { name: 'Late', score: 70, connectionBonus: 8, submittedAt: '2026-11-07T18:00:00Z' },
    { name: 'Early', score: 70, connectionBonus: 8, submittedAt: '2026-11-07T09:00:00Z' },
    { name: 'Connected', score: 70, connectionBonus: 16, submittedAt: '2026-11-07T19:00:00Z' },
    { name: 'Top', score: 71, connectionBonus: 0, submittedAt: '2026-11-07T19:00:00Z' },
    { name: 'Bottom', score: 60, connectionBonus: 16, submittedAt: '2026-11-07T08:00:00Z' },
  ];
  const ranked = sortLeaderboard(entries).map((e) => e.name);
  assert.deepEqual(ranked, ['Top', 'Connected', 'Early', 'Late', 'Bottom']);
});

// --- card display -----------------------------------------------------------

test('playsLine comes from real slot eligibility', () => {
  assert.equal(playsLine(pick('Jason Newsted')), 'Bass · Vocals');
  assert.equal(playsLine(pick('Kurt Cobain')), 'Guitar · Vocals');
  assert.equal(playsLine(pick('John Paul Jones')), 'Bass · Guitar');
  assert.equal(playsLine(pick('Neil Peart')), 'Drums');
  // Wild-card-only Ray Manzarek (keyboards) shows his instrument.
  assert.equal(playsLine(pick('Ray Manzarek')), 'Keyboards');
});

test('displayBands appends Newsted (Founder) as a 4th line', () => {
  const lines = displayBands(pick('Jason Newsted'));
  assert.equal(lines.length, 4);
  assert.equal(lines[3], 'Newsted (Founder)');
  assert.deepEqual(lines.slice(0, 3), [
    'Metallica (Member)', 'Echobrain (Founder)', 'Flotsam and Jetsam (Founder)',
  ]);
});

test('displayBands does not duplicate an own band already in the top 3', () => {
  const lines = displayBands(pick('Stevie Nicks'));
  assert.equal(lines.length, 3);
  assert.ok(lines.includes('Stevie Nicks (Founder)'));
});

test('displayBands appends an own band for exactly one player in the pool', () => {
  const appended = pool.filter((p) => displayBands(p).length > (p.top3 || []).length).map((p) => p.name);
  assert.deepEqual(appended, ['Jason Newsted']);
});

// --- tiers ------------------------------------------------------------------

test('tiers: Gold at 10 wins, Platinum at 25', () => {
  assert.equal(tierFor(0), null);
  assert.equal(tierFor(9), null);
  assert.equal(tierFor(10), 'Gold');
  assert.equal(tierFor(24), 'Gold');
  assert.equal(tierFor(25), 'Platinum');
  assert.equal(winsToNextTier(0), 10);
  assert.equal(winsToNextTier(10), 15);
  assert.equal(winsToNextTier(25), 0);
});

// --- shipped pool data ------------------------------------------------------

test('pool.json: 100 players, 20 per primary slot, unique ids', () => {
  assert.equal(pool.length, 100);
  const bySlot = {};
  for (const p of pool) bySlot[p.slot] = (bySlot[p.slot] || 0) + 1;
  assert.deepEqual(bySlot, { V: 20, G: 20, B: 20, D: 20, W: 20 });
  assert.equal(new Set(pool.map((p) => p.member_id)).size, 100);
});

test('pool.json: prices in $5 steps; top-5 sum is $235', () => {
  for (const p of pool) {
    assert.equal(p.price0 % 5, 0, `${p.name} price ${p.price0} is not a $5 step`);
    assert.ok(p.price0 >= 5 && p.price0 <= 50, `${p.name} price ${p.price0} out of range`);
  }
  const top5 = [...pool].map((p) => p.price0).sort((a, b) => b - a).slice(0, 5);
  assert.deepEqual(top5, [50, 50, 45, 45, 45]);
  assert.equal(top5.reduce((a, b) => a + b, 0), 235);
});

test('pool.json: every row has the fields the page needs', () => {
  for (const p of pool) {
    for (const key of ['name', 'V', 'price0', 'top3', 'all_bands', 'eligible', 'member_id', 'inst', 'slot']) {
      assert.ok(key in p, `${p.name} missing ${key}`);
    }
    assert.ok(p.V > 0, `${p.name} has no value`);
    assert.ok(Array.isArray(p.top3) && p.top3.length >= 1, `${p.name} has no top bands`);
    assert.ok((p.eligible || []).every((letter) => ['V', 'G', 'B', 'D', 'W'].includes(letter)));
  }
});

test('pool.json: the two Roger Taylors are separate nodes with separate prices', () => {
  const queen = pick('Roger Taylor (Queen)');
  const duran = pick('Roger Taylor (Duran Duran)');
  assert.notEqual(queen.member_id, duran.member_id);
  assert.equal(queen.price0, 25);
  assert.equal(duran.price0, 20);
  assert.deepEqual(queen.all_bands, ['Band Aid 30', 'Hale & Pace and the Stonkers', 'Queen', 'Queen + Paul Rodgers', 'The Cross']);
  assert.deepEqual(duran.all_bands, ['Arcadia', 'Duran Duran']);
});

test('GOLD_LINE is the locked 69', () => {
  assert.equal(GOLD_LINE, 69);
  assert.equal(SLOTS.length, 5);
});

// --- normalizeLeaderboard: the pills regression ---------------------------
// fantasy-play GET returns leaderboard as an OBJECT {scope, date, total,
// entries}; loadToday used to hand that object straight to
// sortLeaderboard, whose [...entries] threw "entries is not iterable"
// — loadToday's catch wrote "Leaderboard unavailable" into BOTH boards
// and loadWeekly() never ran, so the pills looked dead.

test('normalizeLeaderboard unwraps the fantasy-play GET object shape', () => {
  const entries = [
    { name: 'A', score: 50, connectionBonus: 4, submittedAt: '2026-11-08T10:00:00Z' },
    { name: 'B', score: 72.4, connectionBonus: 8, submittedAt: '2026-11-08T09:00:00Z' },
  ];
  const shaped = { scope: 'daily', date: '2026-11-08', total: 2, entries };
  assert.deepEqual(normalizeLeaderboard(shaped), entries);
});

test('normalizeLeaderboard passes an entries array through untouched', () => {
  const entries = [{ name: 'A', score: 50 }];
  assert.equal(normalizeLeaderboard(entries), entries);
});

test('normalizeLeaderboard tolerates null, undefined, and objects without entries', () => {
  assert.deepEqual(normalizeLeaderboard(null), []);
  assert.deepEqual(normalizeLeaderboard(undefined), []);
  assert.deepEqual(normalizeLeaderboard({}), []);
  assert.deepEqual(normalizeLeaderboard({ scope: 'daily', total: 0 }), []);
  assert.deepEqual(normalizeLeaderboard('nope'), []);
});

test('the old repro now sorts fine: GET-shaped daily board ranks by score', () => {
  // The exact shape fantasy-play GET returns, with the weekly board's
  // different entries beside it — the two boards must come out different.
  const daily = normalizeLeaderboard({
    scope: 'daily', date: '2026-11-08', total: 2,
    entries: [
      { name: 'Low', score: 41.57, connectionBonus: 0, submittedAt: '2026-11-07T10:00:00Z' },
      { name: 'High', score: 72.4, connectionBonus: 12, submittedAt: '2026-11-08T10:00:00Z' },
    ],
  });
  const weekly = normalizeLeaderboard([
    { name: 'Week', score: 60.1, connectionBonus: 4, submittedAt: '2026-11-02T10:00:00Z' },
  ]);
  const rankedDaily = sortLeaderboard(daily);
  assert.equal(rankedDaily[0].name, 'High');
  assert.equal(rankedDaily[1].name, 'Low');
  assert.notDeepEqual(
    sortLeaderboard(weekly).map((e) => e.name),
    rankedDaily.map((e) => e.name),
  );
});

test('sortLeaderboard never sees a bare object from the page anymore', () => {
  // Pin the call sites: loadToday, loadWeekly, and the submit handler
  // all normalize before rendering — no renderBoards call passes a
  // raw data.leaderboard object.
  const body = readFileSync(new URL('../fantasy/fantasy-game.mjs', import.meta.url), 'utf8');
  assert.ok(body.includes('renderBoards(normalizeLeaderboard(data.leaderboard))'));
  assert.ok(body.includes("renderBoards(normalizeLeaderboard(data.leaderboard || data.entries || data), 'weekly')"));
  assert.ok(body.includes('renderBoards(normalizeLeaderboard(data.leaderboard))'));
  assert.ok(!body.includes('renderBoards(data.leaderboard || [])'), 'the throwing call site must be gone');
});
