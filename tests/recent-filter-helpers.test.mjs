// Unit tests for scripts/recent-filter-helpers.mjs — the pure logic behind
// the Recently-added toolbar filter.
//
// index.html carries a hand-synced inline copy of this module (see the
// "Recently-added filter helpers" comment there). tests/recent-filter-ui.test.mjs
// pins that the two copies stay in agreement on the constants and the cascade;
// this file exercises the behavior.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_WINDOW_DAYS,
  RECENT_FALLBACK_WINDOW_DAYS,
  RECENT_FALLBACK_COUNT,
  parseCreatedAt,
  countDatedBands,
  selectRecentBandIds,
  describeRecentSelection,
} from '../scripts/recent-filter-helpers.mjs';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

// Band node in the shape buildMasterGraph() produces, `daysAgo` days old.
function band(id, daysAgo) {
  return {
    id,
    type: 'band',
    createdAt: daysAgo === null ? '' : new Date(NOW - daysAgo * DAY).toISOString(),
  };
}

function person(id) {
  return { id, type: 'person' };
}

function idsOf(selection) {
  return [...selection.ids].sort();
}

// ---- parseCreatedAt ---------------------------------------------------------

test('parseCreatedAt accepts ISO strings, Date objects and epoch millis', () => {
  const iso = '2026-07-01T00:00:00.000Z';
  const expected = Date.parse(iso);
  assert.equal(parseCreatedAt(iso), expected);
  assert.equal(parseCreatedAt(new Date(iso)), expected);
  assert.equal(parseCreatedAt(expected), expected);
});

test('parseCreatedAt returns null for missing or unparseable values', () => {
  for (const value of [null, undefined, '', 'not a date', {}, NaN]) {
    assert.equal(parseCreatedAt(value), null, `expected null for ${String(value)}`);
  }
});

// ---- countDatedBands --------------------------------------------------------

test('countDatedBands counts only band nodes with a usable timestamp', () => {
  const nodes = [band('A', 1), band('B', null), person('P'), { id: 'C', type: 'band', createdAt: 'nope' }];
  assert.equal(countDatedBands(nodes), 1);
});

test('countDatedBands is zero for a CSV-fallback graph (no timestamps at all)', () => {
  const nodes = [band('A', null), band('B', null), person('P')];
  assert.equal(countDatedBands(nodes), 0);
});

// ---- selectRecentBandIds: primary window -----------------------------------

test('selectRecentBandIds keeps bands inside the 30-day window and drops older ones', () => {
  const nodes = [band('Fresh', 2), band('AlsoFresh', 29), band('Stale', 45), person('P')];
  const selection = selectRecentBandIds(nodes, { now: NOW });
  assert.equal(selection.mode, 'window');
  assert.equal(selection.windowDays, RECENT_WINDOW_DAYS);
  assert.equal(selection.count, 2);
  assert.deepEqual(idsOf(selection), ['AlsoFresh', 'Fresh']);
});

test('selectRecentBandIds ignores person nodes entirely', () => {
  const selection = selectRecentBandIds(
    [band('B', 1), { id: 'P', type: 'person', createdAt: new Date(NOW).toISOString() }],
    { now: NOW }
  );
  assert.deepEqual(idsOf(selection), ['B']);
});

test('selectRecentBandIds treats the window boundary as inclusive', () => {
  const selection = selectRecentBandIds([band('Edge', RECENT_WINDOW_DAYS)], { now: NOW });
  assert.equal(selection.mode, 'window');
  assert.deepEqual(idsOf(selection), ['Edge']);
});

// ---- selectRecentBandIds: fallback cascade ---------------------------------

test('selectRecentBandIds falls back to the 90-day window when 30 days is empty', () => {
  const nodes = [band('SixtyDays', 60), band('Ancient', 400)];
  const selection = selectRecentBandIds(nodes, { now: NOW });
  assert.equal(selection.mode, 'fallback-window');
  assert.equal(selection.windowDays, RECENT_FALLBACK_WINDOW_DAYS);
  assert.deepEqual(idsOf(selection), ['SixtyDays']);
});

test('selectRecentBandIds falls back to the newest N bands when both windows are empty', () => {
  // 12 bands, all older than 90 days, 200..211 days back.
  const nodes = Array.from({ length: 12 }, (_, i) => band(`B${i}`, 200 + i));
  const selection = selectRecentBandIds(nodes, { now: NOW });
  assert.equal(selection.mode, 'fallback-count');
  assert.equal(selection.windowDays, null);
  assert.equal(selection.count, RECENT_FALLBACK_COUNT);
  // Newest first means the lowest daysAgo values: B0..B9.
  assert.deepEqual(idsOf(selection), ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']);
});

test('selectRecentBandIds count fallback returns everything when there are fewer than N bands', () => {
  const nodes = [band('A', 300), band('B', 500)];
  const selection = selectRecentBandIds(nodes, { now: NOW });
  assert.equal(selection.mode, 'fallback-count');
  assert.equal(selection.count, 2);
  assert.deepEqual(idsOf(selection), ['A', 'B']);
});

test('selectRecentBandIds reports mode "unavailable" when no band carries a timestamp', () => {
  const selection = selectRecentBandIds([band('A', null), person('P')], { now: NOW });
  assert.equal(selection.mode, 'unavailable');
  assert.equal(selection.count, 0);
  assert.deepEqual(idsOf(selection), []);
});

test('selectRecentBandIds handles an empty or missing node list', () => {
  for (const nodes of [[], null, undefined]) {
    assert.equal(selectRecentBandIds(nodes, { now: NOW }).mode, 'unavailable');
  }
});

test('selectRecentBandIds honors overridden window sizes', () => {
  const nodes = [band('A', 5), band('B', 20)];
  const selection = selectRecentBandIds(nodes, { now: NOW, windowDays: 7 });
  assert.equal(selection.windowDays, 7);
  assert.deepEqual(idsOf(selection), ['A']);
});

// A band whose created_at is in the future (clock skew between the DB and the
// browser) must not fall out of the window — it is trivially "recent".
test('selectRecentBandIds keeps bands with a future timestamp', () => {
  const selection = selectRecentBandIds([band('Skewed', -1)], { now: NOW });
  assert.equal(selection.mode, 'window');
  assert.deepEqual(idsOf(selection), ['Skewed']);
});

// ---- describeRecentSelection -----------------------------------------------

test('describeRecentSelection names the window that actually applied', () => {
  assert.equal(
    describeRecentSelection(selectRecentBandIds([band('A', 3)], { now: NOW })),
    `Recently added: last ${RECENT_WINDOW_DAYS} days`
  );
  assert.equal(
    describeRecentSelection(selectRecentBandIds([band('A', 60)], { now: NOW })),
    `Recently added: last ${RECENT_FALLBACK_WINDOW_DAYS} days`
  );
});

test('describeRecentSelection distinguishes the count fallback from a window', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => band(`B${i}`, 200 + i));
  assert.equal(
    describeRecentSelection(selectRecentBandIds(nodes, { now: NOW })),
    `Recently added: newest ${RECENT_FALLBACK_COUNT} bands`
  );
});

test('describeRecentSelection reports unavailability rather than a bogus window', () => {
  assert.equal(
    describeRecentSelection(selectRecentBandIds([band('A', null)], { now: NOW })),
    'Recently added: no dates available'
  );
  assert.equal(describeRecentSelection(null), 'Recently added: no dates available');
});
