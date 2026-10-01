// Credit packs (real money) — STUB.
//
// POST /api/game-credits/purchase — body { pack }
//   -> { ok: false, error: 'Credit packs are coming soon.' }
//
// Real-money packs arrive with Google Play Billing via the TWA wrapper.
// Until then the client surfaces this message instead of a dead button —
// free players always get the full daily game, and every helper is
// earnable through play.

import {
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  methodNotAllowed,
  extractBearerToken,
  findUserByToken,
  getSql,
} from './_db.mjs';

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();
  const sql = getSql();
  const me = await findUserByToken(sql, extractBearerToken(req));
  if (!me) return unauthorized('sign in to buy credits');
  return ok({ ok: false, error: 'Credit packs are coming soon.' });
};

export const config = { path: '/api/game-credits/purchase' };
