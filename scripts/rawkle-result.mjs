// A Rawkle result as a short code for share links (mirror of daily-result.mjs).
//
// Facebook and Instagram drop pre-filled share text but always unfurl the
// link, so the score rides in it: /rawkle?s=1&r=2-gbbbab.gbbbaa... previews
// as "Rawkle #2 · Solved in 4 tries". The code is the puzzle number, an x if
// not solved, then one row per guess, tiles as letters: g = gold (right
// letter, right spot), b = blue (in the name, wrong spot), a = absent (not
// in the name at all). Rows are joined with dots.
//
// It's only a picture of a score, so a hand-edited code fakes nothing that
// matters — and it NEVER carries letters or the band name, so the card it
// draws stays spoiler-free, the same rule Daily's card follows.
//
// Its own small file so the edge function that writes the preview tags
// (netlify/edge-functions/og_rawkle.js) can use it without loading the game.
// The Rawkle page itself carries a small inline copy of the encoder (the
// page is a standalone file); the two must stay in step.

export const RAWKLE_RESULT_MAX_TRIES = 6;
export const RAWKLE_RESULT_MAX_TILES = 24;

export function rawkleResultCode(num, rows = [], won) {
  if (!num) return null;
  const clean = rows.slice(0, RAWKLE_RESULT_MAX_TRIES).map((r) =>
    String(r || '').replace(/[^gba]/g, '').slice(0, RAWKLE_RESULT_MAX_TILES)
  ).filter((r) => r.length > 0);
  if (!clean.length) return null;
  return `${num}${won ? '' : 'x'}-${clean.join('.')}`;
}

export function parseRawkleResultCode(code) {
  const m = /^(\d{1,4})(x?)-([gba.]{1,200})$/.exec(String(code || '').trim());
  if (!m || Number(m[1]) < 1) return null;
  const parts = m[3].split('.');
  if (parts.some((r) => r.length === 0)) return null; // no empty rows: a real code never has one
  const rows = parts;
  if (!rows.length || rows.length > RAWKLE_RESULT_MAX_TRIES) return null;
  if (rows.some((r) => r.length > RAWKLE_RESULT_MAX_TILES)) return null;
  return { num: Number(m[1]), won: !m[2], rows: rows.map((r) => r.split('')) };
}

// The preview title, shared by the link tags and the card picture.
export function rawkleResultTitle({ num, won, rows }) {
  const tries = rows.length;
  return `Rawkle #${num} · ${won ? `Solved in ${tries} ${tries === 1 ? 'try' : 'tries'}` : 'Not solved'}`;
}
