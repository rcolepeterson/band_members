// GET /api/oauth/authorize?provider=google|facebook|instagram&return_to=/path
//
// Step 1 of the four-option sign-in: mints a one-shot OAuth `state`, stores it
// server-side (oauth_states — no cookies, no server sessions, per the existing
// bearer model), and hands the browser the provider's authorize URL to
// redirect to. Step 2 lands back at /api/oauth/callback.
import {
  getSql,
  isDbConfigured,
  ok,
  badRequest,
  serverError,
  dbUnavailable,
  methodNotAllowed,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests, LIMITS } from './_rate_limit.mjs';
import {
  OAUTH_PROVIDERS,
  getProviderConfig,
  buildAuthorizeUrl,
  newState,
  validateReturnTo,
} from './_oauth.mjs';

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const url = new URL(req.url);
  const provider = (url.searchParams.get('provider') || '').toLowerCase();
  if (!OAUTH_PROVIDERS.includes(provider)) {
    return badRequest('unknown provider');
  }
  const cfg = getProviderConfig(provider);
  if (!cfg) {
    return serverError(`Sign-in with ${provider} is not set up yet.`);
  }

  const ip = clientIp(req);
  const budget = await consume({
    sql: getSql(),
    bucket: `oauth-authorize:ip:${ip}`,
    ...LIMITS.oauthAuthorize,
  });
  if (!budget.allowed) {
    return tooManyRequests(
      'Too many sign-in attempts from this network. Try again shortly.',
      budget.retryAfterSeconds
    );
  }

  const returnTo = validateReturnTo(url.searchParams.get('return_to'));
  const sql = getSql();

  // Opportunistic sweep so abandoned states never pile up.
  await sql`delete from oauth_states where created_at < now() - interval '30 minutes'`;

  // One-shot state (24 random bytes — collision retry is cheap insurance).
  let state = null;
  for (let attempt = 0; attempt < 3 && !state; attempt++) {
    const candidate = newState();
    try {
      await sql`
        insert into oauth_states (state, provider, return_to)
        values (${candidate}, ${provider}, ${returnTo})
      `;
      state = candidate;
    } catch (err) {
      if (err && err.code !== '23505') throw err;
    }
  }
  if (!state) return serverError('Could not start sign-in. Please try again.');

  // redirect_uri is derived from the incoming request host, same as the
  // share-link origin in game_share.mjs — no extra env var to misconfigure.
  // It must be registered verbatim in the provider's dashboard.
  const redirectUri = `${url.protocol}//${url.host}/api/oauth/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    provider,
    clientId: cfg.clientId,
    redirectUri,
    state,
  });

  return ok({ url: authorizeUrl });
};

export const config = { path: '/api/oauth/authorize' };
