// GET /api/oauth/callback?code=...&state=...
//
// Step 2 of the four-option sign-in. The provider redirects here after the
// user consents. This endpoint:
//   1. Consumes the one-shot `state` (15-minute TTL) to recover the provider
//      and return_to — the provider name is never trusted from a query param.
//   2. Exchanges the code server-side and fetches the provider profile
//      (client secrets never touch the browser).
//   3. Resolves the identity via decideIdentity() in _oauth.mjs — the rule
//      there is load-bearing: link to an existing email row ONLY on a
//      provider-verified email match, never otherwise.
//   4. Renders a same-origin HTML page that stores the user object in
//      localStorage under `bmft-user` (the existing key) and redirects to
//      return_to. The bearer model is unchanged: token from generateToken(),
//      /api/me validates it, no cookies, no server sessions.
import {
  getSql,
  isDbConfigured,
  generateToken,
  normalizeEmail,
  methodNotAllowed,
  dbUnavailable,
} from './_db.mjs';
import { clientIp, consume, tooManyRequests, LIMITS } from './_rate_limit.mjs';
import {
  getProviderConfig,
  exchangeCodeForProfile,
  decideIdentity,
  placeholderEmail,
} from './_oauth.mjs';

function pageShell({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Six Degrees of Rock</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d12; color: #e8e6e1;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px; box-sizing: border-box;
  }
  .card {
    max-width: 420px; text-align: center;
    border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
    padding: 40px 32px; background: rgba(255,255,255,.02);
  }
  .card h1 { font-size: 20px; margin: 0 0 12px; font-weight: 600; }
  .card p { font-size: 14px; line-height: 1.6; color: #a7a49d; margin: 0 0 20px; }
  .card a {
    display: inline-block; padding: 12px 28px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.2); color: #e8e6e1;
    text-decoration: none; font-size: 14px; font-weight: 600;
  }
  .card a:hover { border-color: rgba(82,174,182,.6); }
  .spinner {
    width: 28px; height: 28px; margin: 0 auto 20px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.15); border-top-color: #52aeb6;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<main class="card">${body}</main>
</body>
</html>`;
}

function errorPage(message, returnTo) {
  const safeReturn = returnTo && returnTo.startsWith('/') ? returnTo : '/';
  // returnTo was validated server-side when the state row was minted; the
  // startsWith('/') check above is belt-and-suspenders for the href.
  const body = `<h1>Sign-in didn't complete</h1><p>${message}</p><a href="${safeReturn}">Back to the site</a>`;
  return new Response(pageShell({ title: 'Sign-in', body }), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function successPage(user, returnTo) {
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    token: user.token,
    bands_added: user.bands_added,
    bands_edited: user.bands_edited,
    created_at: user.created_at,
    city: user.city,
    state: user.state,
    country: user.country,
    instrument: user.instrument,
  };
  // Embedded as a JS literal: escape `<` so a hostile display name can't
  // break out of the script block (e.g. `</script>` in a name).
  const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
  const safeReturn = JSON.stringify(returnTo).replace(/</g, '\\u003c');
  const body = `<div class="spinner" aria-hidden="true"></div><h1>You're signed in</h1><p>Taking you back…</p><noscript><p>JavaScript is required to finish signing in.</p><a href="/">Back to the site</a></noscript>
<script>
  try {
    localStorage.setItem('bmft-user', JSON.stringify(${safePayload}));
  } catch (e) {}
  location.replace(${safeReturn});
</script>`;
  return new Response(pageShell({ title: 'Signed in', body }), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isDbConfigured()) return dbUnavailable();

  const url = new URL(req.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const denied = url.searchParams.get('error');

  const ip = clientIp(req);
  const budget = await consume({
    sql: getSql(),
    bucket: `oauth-callback:ip:${ip}`,
    ...LIMITS.oauthCallback,
  });
  if (!budget.allowed) {
    return tooManyRequests(
      'Too many sign-in attempts from this network. Try again shortly.',
      budget.retryAfterSeconds
    );
  }

  const sql = getSql();

  // One-shot consume: only an unconsumed row younger than 15 minutes counts.
  // The provider is recovered from the state row, never from a query param.
  const stateRows = await sql`
    delete from oauth_states
    where state = ${state}
      and created_at > now() - interval '15 minutes'
    returning provider, return_to
  `;
  const st = stateRows[0];
  if (!st) {
    return errorPage(
      'That sign-in link expired or was already used. Please try again.',
      '/'
    );
  }
  if (denied || !code) {
    return errorPage(
      'Sign-in was cancelled before it finished. No account was created or changed.',
      st.return_to
    );
  }

  const provider = st.provider;
  if (!getProviderConfig(provider)) {
    return errorPage(`Sign-in with ${provider} is not set up yet.`, st.return_to);
  }

  const redirectUri = `${url.protocol}//${url.host}/api/oauth/callback`;
  let profile;
  try {
    profile = await exchangeCodeForProfile({ provider, code, redirectUri });
  } catch (err) {
    // Log the provider's short error message only — never the code, which
    // was already consumed above and must not be retried.
    console.error('oauth callback exchange failed', {
      provider,
      reason: (err && err.providerMessage) || (err && err.message) || 'unknown',
    });
    return errorPage(
      'The sign-in provider did not complete the request. Please try again.',
      st.return_to
    );
  }
  if (!profile.providerUserId) {
    console.error('oauth callback missing provider user id', { provider });
    return errorPage('The sign-in provider returned an incomplete profile.', st.return_to);
  }

  // --- Identity resolution -------------------------------------------------
  // THE RULE (see decideIdentity in _oauth.mjs): link to an existing email
  // row ONLY on a provider-verified email match. Never on an unverified
  // email, never on provider_user_id alone (that's the 'return' path).
  const byUid = await sql`
    select id, email, name, token, bands_added, bands_edited, created_at,
      city, state, country, instrument, provider, provider_user_id,
      avatar_url, email_verified
    from users
    where provider = ${provider} and provider_user_id = ${profile.providerUserId}
    limit 1
  `;
  let byEmail = [];
  if (profile.email && profile.emailVerified) {
    byEmail = await sql`
      select id, email, name, token, bands_added, bands_edited, created_at,
        city, state, country, instrument, provider, provider_user_id,
        avatar_url, email_verified
      from users
      where lower(email) = lower(${profile.email})
      limit 1
    `;
  }
  const decision = decideIdentity({
    provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    emailVerified: profile.emailVerified,
    rowByProviderUid: byUid[0] || null,
    rowByEmail: byEmail[0] || null,
  });

  let user;
  if (decision.action === 'return' || decision.action === 'link') {
    const target = decision.user;
    if (decision.action === 'link') {
      // Verified email match: attach this OAuth identity to the existing row.
      // The row keeps its bearer token, its name, and its history — only the
      // provider linkage is added. (Name is set at creation and never
      // overwritten, so an email signup's chosen name survives linking.)
      const updated = await sql`
        update users
        set provider = ${provider},
            provider_user_id = ${profile.providerUserId},
            avatar_url = coalesce(${profile.avatarUrl}, avatar_url),
            email_verified = true,
            updated_at = now()
        where id = ${target.id}
        returning id, email, name, token, bands_added, bands_edited, created_at,
          city, state, country, instrument, provider, provider_user_id,
          avatar_url, email_verified
      `;
      user = updated[0];
    } else {
      // Known OAuth identity: refresh what the provider owns, keep the rest.
      const updated = await sql`
        update users
        set avatar_url = coalesce(${profile.avatarUrl}, avatar_url),
            email_verified = ${profile.emailVerified},
            updated_at = now()
        where id = ${target.id}
        returning id, email, name, token, bands_added, bands_edited, created_at,
          city, state, country, instrument, provider, provider_user_id,
          avatar_url, email_verified
      `;
      user = updated[0];
    }
  } else {
    // Fresh row keyed by (provider, provider_user_id). Instagram has no
    // email, so it gets the synthetic placeholder (never routable, never
    // mailed — see _notify.mjs).
    const email = profile.email || placeholderEmail(profile.providerUserId);
    const token = generateToken();
    try {
      const inserted = await sql`
        insert into users
          (email, name, token, provider, provider_user_id, avatar_url, email_verified)
        values
          (${normalizeEmail(email)}, ${profile.name}, ${token},
           ${provider}, ${profile.providerUserId}, ${profile.avatarUrl},
           ${profile.emailVerified})
        returning id, email, name, token, bands_added, bands_edited, created_at,
          city, state, country, instrument, provider, provider_user_id,
          avatar_url, email_verified
      `;
      user = inserted[0];
    } catch (err) {
      // Lost a race with a concurrent callback for the same identity:
      // the unique index did its job — just return the row that won.
      if (err && err.code === '23505') {
        const winner = await sql`
          select id, email, name, token, bands_added, bands_edited, created_at,
            city, state, country, instrument, provider, provider_user_id,
            avatar_url, email_verified
          from users
          where provider = ${provider} and provider_user_id = ${profile.providerUserId}
          limit 1
        `;
        user = winner[0];
      } else {
        throw err;
      }
    }
  }

  if (!user) {
    console.error('oauth callback resolved no user', { provider });
    return errorPage('Something went wrong finishing sign-in. Please try again.', st.return_to);
  }
  return successPage(user, st.return_to);
};

export const config = { path: '/api/oauth/callback' };
