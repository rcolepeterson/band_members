// Bands the game never deals, offers or accepts, while the explorer keeps
// them (Cole, 2026-10-09).
//
// Some entries are real but make confusing game options. "Supergroup A" and
// "Supergroup B" are the billed names of the all-star lineups at Ozzy's final
// "Back to the Beginning" concert (Villa Park, 2025-07-05): right for anyone
// exploring the graph, baffling as a multiple-choice answer.
//
// The list lives in the game_excluded_bands table, so the next one is a row,
// not a code change:
//
//   insert into game_excluded_bands (band_id, reason)
//   values ('<band uuid>', 'why it confuses the game');
//
// Warm function instances cache the game graph, so a new row takes effect as
// instances recycle (usually within minutes). Delete the row to undo.
//
// The two IDs below seed the table and are the fallback if it can't be read,
// so a database hiccup never puts them back in the game.

export const DEFAULT_GAME_EXCLUSIONS = Object.freeze([
  { band_id: '2cd5781b-959e-484b-be78-a37b851357e3', reason: 'Supergroup A: Back to the Beginning (2025) all-star lineup' },
  { band_id: 'b6fd7968-b428-407f-aab8-62dfd122fe60', reason: 'Supergroup B: Back to the Beginning (2025) all-star lineup' },
]);

export async function ensureGameExclusionsTable(sql) {
  await sql`
    create table if not exists game_excluded_bands (
      band_id uuid primary key,
      reason text,
      created_at timestamptz not null default now()
    )
  `;
  for (const { band_id, reason } of DEFAULT_GAME_EXCLUSIONS) {
    await sql`
      insert into game_excluded_bands (band_id, reason)
      values (${band_id}, ${reason})
      on conflict (band_id) do nothing
    `;
  }
}

function isMissingTable(error) {
  return Boolean(error && (error.code === '42P01' || /does not exist/i.test(String(error.message || ''))));
}

// A Set of band ids (strings). Never throws: on any failure it falls back to
// the defaults.
export async function loadGameExclusions(sql) {
  const ids = new Set(DEFAULT_GAME_EXCLUSIONS.map((e) => e.band_id));
  try {
    let rows;
    try {
      rows = await sql`select band_id from game_excluded_bands`;
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // First request after this shipped and before migrate.mjs ran.
      await ensureGameExclusionsTable(sql);
      rows = await sql`select band_id from game_excluded_bands`;
    }
    for (const r of rows || []) if (r && r.band_id) ids.add(String(r.band_id));
  } catch (error) {
    console.error('game exclusions: using the built-in list', error && error.message);
  }
  return ids;
}

// Drop excluded bands from the game's view of the memberships, so they can
// never be an option, a link in a route, a trap or an endpoint. The explorer
// reads its own queries and is untouched.
export function withoutExcludedBands(memberships, excluded) {
  if (!excluded || !excluded.size) return memberships;
  return (memberships || []).filter((m) => !excluded.has(String(m.band_id)));
}
