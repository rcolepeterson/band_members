// -----------------------------------------------------------------------
// Pure helpers for the ingestion pipeline. No I/O — everything here is
// synchronous, deterministic, and unit-testable in isolation.
//
// Kept separate from ingest-musicbrainz.mjs so tests never have to
// exercise the network layer.
// -----------------------------------------------------------------------

// Normalize a name for cross-source matching. MusicBrainz and Wikipedia
// disagree on trailing periods, "The " prefixes, and case in ~5% of
// entries. We normalize to a comparison key without altering the display
// name that goes into the CSV.
export function normalizeNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/[.,'"\u2018\u2019\u201C\u201D]/g, '')
    .replace(/\s+/g, ' ');
}

// Parse a MusicBrainz date into a display "yearsActive" string matching
// the format we ship in index.html:
//   { begin: '1990', end: '1994', ended: true }  -> "1990-1994"
//   { begin: '1990', end: null,   ended: false } -> "1990-present"
//   { begin: '1990-09-22', end: '1991-05-22' }   -> "1990-1991"  (year only)
//   { begin: '',    end: '',      ended: false } -> ""            (caller decides em-dash)
export function formatTenure({ begin = '', end = '', ended = false } = {}) {
  const b = extractYear(begin);
  const e = extractYear(end);
  if (!b && !e) return '';
  if (b && !e) return ended ? b : `${b}-present`;
  if (!b && e) return e;
  if (b === e) return b;
  return `${b}-${e}`;
}

function extractYear(v) {
  const m = /(\d{4})/.exec(String(v || ''));
  return m ? m[1] : '';
}

// -----------------------------------------------------------------------
// Confidence scoring for a candidate NEW band being proposed for merge.
//
// Signals (all boolean, additive):
//   - existingConnections >= 1:   bridge to existing graph. +2 (strong)
//   - existingConnections >= 3:   multiple bridges. +1 additional
//   - memberCount >= 3:           notability floor for MB entries. +2
//   - hasWikipediaArticle:        second-source confirmation. +2
//   - hasBeginArea:               city known (scene filter works). +1
//   - hasBeginYear:               band lifespan known. +1
//
// Total possible = 9. Tiers:
//   >= 7  -> "high"    (auto-merge candidate)
//   4-6   -> "medium"  (staging for human review)
//   <= 3  -> "low"     (rejected, logged for debugging)
// -----------------------------------------------------------------------
export function scoreCandidate({
  existingConnections = 0,
  memberCount = 0,
  hasWikipediaArticle = false,
  hasBeginArea = false,
  hasBeginYear = false,
} = {}) {
  const signals = {};
  let score = 0;
  if (existingConnections >= 1) { signals.bridge = true; score += 2; }
  if (existingConnections >= 3) { signals.multiBridge = true; score += 1; }
  if (memberCount >= 3) { signals.notability = true; score += 2; }
  if (hasWikipediaArticle) { signals.wikipedia = true; score += 2; }
  if (hasBeginArea) { signals.hasCity = true; score += 1; }
  if (hasBeginYear) { signals.hasYears = true; score += 1; }

  let tier = 'low';
  if (score >= 7) tier = 'high';
  else if (score >= 4) tier = 'medium';

  return { score, tier, signals };
}

// The threshold rules — exported so tests and the pipeline runner share
// one source of truth. Change the tier boundaries only here.
export const CONFIDENCE_TIERS = {
  high: { minScore: 7, action: 'auto-merge' },
  medium: { minScore: 4, action: 'stage-for-review' },
  low: { minScore: 0, action: 'reject-and-log' },
};

// CSV row escaper — MB names can contain commas, quotes, and (rarely)
// newlines. Keeps the pipeline output valid RFC 4180.
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[,"\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Emit one CSV row given a header array and a value object.
export function csvRow(headers, obj) {
  return headers.map(h => csvEscape(obj[h])).join(',');
}
