// A 6° result as a short code for share links (Cole, 2026-10-14: one-tap share).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the score rides in it: /game?s=1&r=14-osdo previews as
// "6° Rock #14 · Solved in 4 moves". The code is the puzzle number, an x if
// not solved, then one letter per move: o = on the shortest path (gold),
// s = connects (silver), d = dead end. It's only a picture of a score, so a
// hand-edited code fakes nothing that matters.
//
// Its own small file so the edge function that writes the preview tags
// (netlify/edge-functions/og_daily.js) can use it without loading the game.

export const DAILY_RESULT_MAX_MOVES = 20;
const KIND_LETTER = { optimal: 'o', deadend: 'd' };

export function resultCode(num, picks = [], won) {
  if (!num) return null;
  const kinds = picks.slice(0, DAILY_RESULT_MAX_MOVES).map((p) => KIND_LETTER[p.kind] || 's').join('');
  return `${num}${won ? '' : 'x'}-${kinds}`;
}

export function parseDailyResultCode(code) {
  const m = /^(\d{1,4})(x?)-([osd]{0,20})$/.exec(String(code || '').trim());
  if (!m || Number(m[1]) < 1) return null;
  return { num: Number(m[1]), won: !m[2], kinds: m[3].split('').filter(Boolean) };
}

// The preview title, shared by the link tags and the card picture.
export function dailyResultTitle({ num, won, kinds }) {
  const moves = kinds.length;
  return `6° Rock #${num} · ${won ? `Solved in ${moves} ${moves === 1 ? 'move' : 'moves'}` : 'Not solved'}`;
}
