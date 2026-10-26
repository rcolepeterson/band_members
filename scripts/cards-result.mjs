// Shared parser + title for the 6* Card Game result code (mirror of
// scripts/daily-result.mjs and scripts/rawkle-result.mjs).
//
// The share link carries /cards?s=1&r=<code> where code is:
//   winner-turns-chain-stalls-ricky-freeze-closing
// winner: Y (you) / M (Mara) / D (Dev) / K (Kit)
// turns, chain, stalls, ricky, freeze: integers, game totals (they match the
//   card's stat row; the copied text's freeze clause is the player's own)
// closing: closing band name, encodeURIComponent'd, LAST field. It may itself
//   contain dashes or dots, so it is decoded from everything after the 6th
//   dash rather than from a single segment.
// The code carries summary numbers only — no chain contents — so the card it
// draws is spoiler-free. (A card game has no hidden answer; the chain IS the
// result, and only its length travels.)
export const WINNER_NAMES = { Y: 'You', M: 'Mara', D: 'Dev', K: 'Kit' };

const MAX_CLOSING = 80;

function isInt(s, max) {
  return /^\d+$/.test(s) && Number(s) <= max;
}

export function parseCardsResultCode(code) {
  if (!code || typeof code !== 'string') return null;
  const parts = code.split('-');
  if (parts.length < 7) return null;
  const [winner, turns, chain, stalls, ricky, freeze] = parts;
  if (!WINNER_NAMES[winner]) return null;
  if (!isInt(turns, 999) || !isInt(chain, 999) || !isInt(stalls, 999)) return null;
  if (!isInt(ricky, 99) || !isInt(freeze, 99)) return null;
  let closing;
  try {
    closing = decodeURIComponent(parts.slice(6).join('-'));
  } catch (_) {
    return null;
  }
  closing = closing.trim().replace(/[\x00-\x1f\x7f]/g, '');
  if (!closing || closing.length > MAX_CLOSING) return null;
  return {
    winner,
    won: winner === 'Y',
    turns: Number(turns),
    chain: Number(chain),
    stalls: Number(stalls),
    ricky: Number(ricky),
    freeze: Number(freeze),
    closing,
  };
}

export function cardsResultTitle(result) {
  const turns = `${result.turns} turn${result.turns === 1 ? '' : 's'}`;
  return result.won
    ? `You beat Mara, Dev, and Kit — ${turns}`
    : `${WINNER_NAMES[result.winner]} takes the game — ${turns}`;
}
