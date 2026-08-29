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
// The `origin` parameter distinguishes two ingestion paths:
//   - 'bridge-fill'   (default): candidate was discovered because an
//                     existing seed person is a member. Requires >=1
//                     bridge to score any bridge points — that's the
//                     whole reason it was discovered.
//   - 'direct-ingest': operator explicitly named this band in the
//                      config. It's INCLUDED BY REQUEST, so it gets
//                      the bridge points automatically (as an 'operator
//                      bridge'). Otherwise obviously-wanted iconic bands
//                      like Oasis/Blur would score lower than obscure
//                      side projects.
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
  origin = 'bridge-fill',
} = {}) {
  const signals = {};
  let score = 0;
  // The operator explicitly asked for direct-ingest bands, so we treat
  // the request itself as the "bridge" signal. A direct-ingest band with
  // real graph overlap still gets the multi-bridge bonus if applicable.
  const isDirectIngest = origin === 'direct-ingest' || origin === 'direct-ingest+bridge';
  if (isDirectIngest) {
    signals.bridge = true;
    signals.operatorRequested = true;
    score += 2;
  } else if (existingConnections >= 1) {
    signals.bridge = true;
    score += 2;
  }
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

// -----------------------------------------------------------------------
// Membership role and instruments, from MusicBrainz relationship attributes
//
// A "member of band" relation carries a flat attribute list that mixes the
// role marker in with the instruments played:
//
//   Ben Weinman / The Dillinger Escape Plan
//     ["guitar", "keyboard", "original", "piano"]
//
// `original` is MusicBrainz's founding-member marker, and it is the field
// that answers the question the graph could not answer: 387 of 499 bands in
// the seed have no founder recorded at all — Black Sabbath, Iron Maiden and
// King Crimson among them — because proposedRowsForBand hardcoded weight: 2
// for every imported membership. The signal was in the payload the importer
// was already holding; it was thrown away.
//
// The instruments were thrown away in the same place: every imported row
// writes four empty Intrument columns while MB is handing over "guitar",
// "keyboard" and "piano" in that same array.
// -----------------------------------------------------------------------

// Attributes that describe the ROLE rather than an instrument. MB has no
// touring marker on this relationship — weight 3 stays a human judgement made
// through the add-band form, which is why this maps to founder-or-member only
// and never proposes a downgrade.
export const MB_ROLE_ATTRIBUTES = Object.freeze(['original']);

/**
 * Founder (1) or plain member (2), from a relation's attribute list.
 *
 * Deliberately never returns 3: MusicBrainz does not model touring membership
 * on "member of band", so inferring it would be inventing data. A row that a
 * human marked 3 is left alone by the enrichment pass.
 */
export function weightFromMbAttributes(attributes = []) {
  const list = Array.isArray(attributes) ? attributes : [];
  const isFounder = list.some(
    a => MB_ROLE_ATTRIBUTES.includes(String(a || '').trim().toLowerCase()),
  );
  return isFounder ? 1 : 2;
}

/**
 * The instruments from a relation's attribute list, cleaned for the CSV's four
 * Intrument columns (the column name's missing 's' is load-bearing — it is the
 * spelling the live data and the add-band form already use).
 *
 * MB writes a disambiguating parenthetical on some instruments —
 * "drums (drum set)" — which is noise in a chip beside a musician's name, so
 * it is stripped. Order is preserved: MB lists the primary instrument first.
 */
export function instrumentsFromMbAttributes(attributes = [], limit = 4) {
  const list = Array.isArray(attributes) ? attributes : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) continue;
    if (MB_ROLE_ATTRIBUTES.includes(value)) continue;
    const cleaned = value.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Spread instruments across the CSV's four Intrument columns, filling the rest
 * with '' so every emitted row keeps an identical column set.
 */
export function instrumentColumns(instruments = [], limit = 4) {
  const cols = {};
  for (let i = 0; i < limit; i += 1) {
    cols[`Intrument ${i + 1}`] = instruments[i] || '';
  }
  return cols;
}
