// ---------------------------------------------------------------------------
// "Recently added" graph filter helpers.
//
// This module is the canonical, unit-tested source for the pure logic behind
// the Recently-added toolbar filter: deciding which band nodes count as
// recent, and producing the human-readable label the graph HUD shows while
// the filter is on.
//
// index.html carries a hand-synced inline copy of this logic (same rationale
// as scripts/location-helpers.mjs and scripts/graph-render-helpers.mjs -- the
// page's main script is a classic, non-module script, so it can't `import`
// this file directly). If you change behavior here, mirror the change in
// index.html.
// ---------------------------------------------------------------------------

// Primary window. Chosen over a 7-day window because the beta has 6-12
// testers: a week of real activity is frequently zero bands, which would make
// the button look broken.
export const RECENT_WINDOW_DAYS = 30;

// First fallback window, used only when the primary window selects nothing.
export const RECENT_FALLBACK_WINDOW_DAYS = 90;

// Last-resort fallback: the N most recently created bands regardless of age.
// Guarantees the filter always has something to show as long as at least one
// band carries a usable timestamp.
export const RECENT_FALLBACK_COUNT = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Accepts the ISO strings /api/bands returns for bands.created_at, the
// Date objects the Neon driver hands back for timestamptz columns, and epoch
// millisecond numbers. Returns epoch ms, or null for anything unparseable
// (including the CSV fallback path, where bands carry no timestamp at all).
export function parseCreatedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Band nodes that carry a usable created-at timestamp, newest first.
function datedBandsNewestFirst(nodes) {
  return (nodes || [])
    .filter(node => node && node.type === 'band')
    .map(node => ({ id: node.id, createdAtMs: parseCreatedAt(node.createdAt) }))
    .filter(entry => entry.createdAtMs !== null)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

// How many band nodes the Recently-added filter has anything to say about.
// Zero means the filter cannot work at all (e.g. the CSV fallback path), which
// is what the UI uses to decide whether to disable the button.
export function countDatedBands(nodes) {
  return datedBandsNewestFirst(nodes).length;
}

// Picks the set of band ids the Recently-added filter should keep.
//
// Cascade, stopping at the first stage that selects at least one band:
//   1. bands created within `windowDays`                  -> mode 'window'
//   2. bands created within `fallbackWindowDays`          -> mode 'fallback-window'
//   3. the `fallbackCount` newest bands, at any age       -> mode 'fallback-count'
//   4. nothing datable                                    -> mode 'unavailable'
//
// Returns { ids, mode, windowDays, count }. `windowDays` is the window that
// actually applied (null for the count-based fallback) and `count` is the size
// of the selected set, so callers can render an accurate label without
// re-deriving any of it.
export function selectRecentBandIds(nodes, options = {}) {
  const {
    now = Date.now(),
    windowDays = RECENT_WINDOW_DAYS,
    fallbackWindowDays = RECENT_FALLBACK_WINDOW_DAYS,
    fallbackCount = RECENT_FALLBACK_COUNT,
  } = options;

  const dated = datedBandsNewestFirst(nodes);
  if (!dated.length) {
    return { ids: new Set(), mode: 'unavailable', windowDays: null, count: 0 };
  }

  for (const days of [windowDays, fallbackWindowDays]) {
    if (!Number.isFinite(days) || days <= 0) continue;
    const cutoff = now - days * MS_PER_DAY;
    const withinWindow = dated.filter(entry => entry.createdAtMs >= cutoff);
    if (withinWindow.length) {
      return {
        ids: new Set(withinWindow.map(entry => entry.id)),
        mode: days === windowDays ? 'window' : 'fallback-window',
        windowDays: days,
        count: withinWindow.length,
      };
    }
  }

  const newest = dated.slice(0, Math.max(1, fallbackCount));
  return {
    ids: new Set(newest.map(entry => entry.id)),
    mode: 'fallback-count',
    windowDays: null,
    count: newest.length,
  };
}

// Label for the graph stats HUD while the filter is on. Names the window that
// actually applied so a fallback never silently masquerades as the default.
export function describeRecentSelection(selection) {
  if (!selection || selection.mode === 'unavailable') return 'Recently added: no dates available';
  if (selection.mode === 'fallback-count') return `Recently added: newest ${selection.count} bands`;
  return `Recently added: last ${selection.windowDays} days`;
}
