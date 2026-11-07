// A Fantasy Band Game result as a short code for share links (mirror of
// daily-result.mjs / rawkle-result.mjs).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the score rides in it: /fantasy?s=1&r=20261107-72.40-w-<uuids>
// previews as "Fantasy Band Game · 2026-11-07 · 72.40 — beat the Gold line".
// The code is the play date (YYYYMMDD), the settled FINAL score with two
// decimals, a w if the score beat the Gold line (69) or an x if it did not,
// then the five drafted member UUIDs in slot order V, G, B, D, W, joined
// with dots.
//
// Fantasy results spoil nothing — there is no hidden answer, the band is the
// player's own draft — so the code may carry the score and the win plainly.
// It's still only a picture of a score, so a hand-edited code fakes nothing
// that matters.
//
// Its own small file so the edge function that writes the preview tags
// (netlify/edge-functions/og_fantasy.js) and the card function
// (netlify/functions/fantasy_card.mjs) can use it without loading the game.
// The Fantasy page itself imports this module; the three must stay in step:
// if the format changes here, the page, the edge function and the card all
// change with it.

// Gold line, LOCKED (Aaron, 2026-11-07). Hardcoded here, same value as the
// page's GOLD_LINE in fantasy/fantasy-game.mjs — do not invent another number.
const GOLD_LINE = 69;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validDateString(date) {
  if (typeof date !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  // Last day of the month: day 0 of the next month.
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

export function fantasyResultCode({ date, finalScore, won, picks } = {}) {
  if (!validDateString(date)) return null;
  if (typeof finalScore !== 'number' || !Number.isFinite(finalScore) || finalScore < 0) return null;
  if (won !== undefined && typeof won !== 'boolean') return null;
  if (!Array.isArray(picks) || picks.length !== 5) return null;
  if (picks.some((p) => typeof p !== 'string' || !UUID_RE.test(p))) return null;
  // won is the caller's call (the page computes finalScore > 69); when it is
  // omitted, derive it from the score so the code can never contradict it.
  const w = typeof won === 'boolean' ? won : finalScore > GOLD_LINE;
  const yyyymmdd = date.replaceAll('-', '');
  return `${yyyymmdd}-${finalScore.toFixed(2)}-${w ? 'w' : 'x'}-${picks.join('.')}`;
}

export function parseFantasyResultCode(code) {
  const m = /^(\d{8})-(\d+\.\d{2})-([wx])-([0-9a-fA-F-]{36}(?:\.[0-9a-fA-F-]{36}){4})$/.exec(
    String(code || '').trim()
  );
  if (!m) return null;
  const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  if (!validDateString(date)) return null;
  const finalScore = Number(m[2]);
  if (!Number.isFinite(finalScore) || finalScore < 0) return null;
  const picks = m[4].split('.');
  if (picks.some((p) => !UUID_RE.test(p))) return null;
  return { date, finalScore, won: m[3] === 'w', picks };
}

// The preview title, shared by the link tags and the card picture.
export function fantasyResultTitle({ date, finalScore, won } = {}) {
  const score = typeof finalScore === 'number' && Number.isFinite(finalScore)
    ? finalScore.toFixed(2)
    : String(finalScore ?? '');
  const w = typeof won === 'boolean' ? won : (typeof finalScore === 'number' && finalScore > GOLD_LINE);
  return `Fantasy Band Game · ${date} · ${score} — ${w ? 'beat the Gold line' : 'below the Gold line (69)'}`;
}
