// Shared OAuth helpers for the four-option sign-in.
//
// Providers: Google, Facebook, and Instagram via Meta's "Instagram Login"
// product (NOT the retired Instagram Basic Display API — that was removed
// December 2024). Instagram Login runs on the SAME Meta app credentials as
// Facebook Login (one App ID / App Secret pair); it is a separate product to
// enable in the Meta app dashboard.
//
// What each provider gives us:
//   Google    -> sub, name, email, email_verified, picture (userinfo endpoint)
//   Facebook  -> id, name, email (only with the `email` permission; Facebook
//                verifies account emails, so a present email counts as verified),
//                picture
//   Instagram -> id, username, account_type. NO email address exists in the
//                Instagram API at all, so Instagram sign-ins can never link by
//                email — they link by (provider, provider_user_id) only, and new
//                rows get a synthetic placeholder email (see below).
//
// Instagram limitations worth knowing (product, not code):
//   - Instagram Login works for Business/Creator accounts only. Personal
//     Instagram accounts are rejected by Meta at the authorize step.
//   - Meta's API only ever returns friends who also authorized the app, so a
//     "challenge a Facebook friend" picker can only show mutual players — the
//     shareable challenge link remains the primary viral path regardless.
//
// Security model (deliberately boring):
//   - The OAuth `state` is a one-shot, 15-minute server-side row (oauth_states),
//     because there are no cookies or server sessions to bind it to.
//   - The browser never sees client secrets; the code exchange happens
//     server-side in oauth_callback.mjs.
//   - `return_to` is validated to a same-origin relative path (open-redirect
//     guard).
//   - Secrets, codes, and tokens are never logged.

export const OAUTH_PROVIDERS = ['google', 'facebook', 'instagram'];

// Meta Graph API version pinned for Facebook + Instagram calls. Verified
// against 2026-dated integrations; bump deliberately, not incidentally.
export const META_API_VERSION = 'v21.0';

// Instagram sign-ins have no email address to store, but users.email is
// NOT NULL. New Instagram rows get a deterministic placeholder under this
// domain — `.local` is not routable, so it can never receive mail, and
// _notify.mjs skips placeholder addresses as belt-and-suspenders (see
// isPlaceholderEmail). The placeholder is unique per provider user id, so
// the users_email_lower_idx uniqueness constraint still holds.
export const PLACEHOLDER_EMAIL_DOMAIN = 'instagram.local';

export function placeholderEmail(providerUserId) {
  return `ig-${String(providerUserId).toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email) {
  return (
    typeof email === 'string' &&
    email.toLowerCase().endsWith('@' + PLACEHOLDER_EMAIL_DOMAIN)
  );
}

// Credentials come from the environment only — never hardcoded, never logged.
// Instagram Login reuses the Meta (Facebook) app's ID and secret.
export function getProviderConfig(provider) {
  if (provider === 'google') {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) return null;
    return { provider, clientId, clientSecret };
  }
  if (provider === 'facebook' || provider === 'instagram') {
    const clientId = (process.env.FACEBOOK_APP_ID || '').trim();
    const clientSecret = (process.env.FACEBOOK_APP_SECRET || '').trim();
    if (!clientId || !clientSecret) return null;
    return { provider, clientId, clientSecret };
  }
  return null;
}

export function isProviderConfigured(provider) {
  return getProviderConfig(provider) !== null;
}

// One-shot CSRF token for the OAuth round-trip. 24 random bytes, hex-encoded.
export function newState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Build the provider's authorize URL. Pure — no network, no secrets beyond
// the public client_id.
export function buildAuthorizeUrl({ provider, clientId, redirectUri, state }) {
  const q = (params) => new URLSearchParams(params).toString();
  if (provider === 'google') {
    return (
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      q({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
      })
    );
  }
  if (provider === 'facebook') {
    return (
      `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?` +
      q({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: 'email,public_profile',
      })
    );
  }
  if (provider === 'instagram') {
    // enable_fb_login=0 forces the pure Instagram consent screen instead of
    // a Facebook/Instagram chooser. If Meta ever drops the parameter, the
    // chooser appears — a graceful degradation, not a break.
    return (
      'https://www.instagram.com/oauth/authorize?' +
      q({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'instagram_business_basic',
        state,
        enable_fb_login: '0',
      })
    );
  }
  throw new Error(`unknown oauth provider: ${provider}`);
}

// Only a same-origin relative path may be used as the post-login landing
// page. Anything else (absolute URL, protocol-relative, backslashes, control
// characters) falls back to '/'. This is the open-redirect guard for the
// `return_to` parameter that rides along in oauth_states.
export function validateReturnTo(raw) {
  if (typeof raw !== 'string' || !raw) return '/';
  if (!/^\/[^\s\\]*$/.test(raw)) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

// ---------------------------------------------------------------------------
// Identity resolution — the critical security rule lives here.
//
// The site's email signup is deliberately unverified: anyone who types an
// address gets that address's account. OAuth must therefore NEVER link to an
// existing email row on the strength of an unverified provider email —
// otherwise typing victim@example.com into a provider flow (or a provider
// that doesn't verify) would hand over the victim's account and token.
//
// THE RULE: an OAuth identity may attach to an existing email row ONLY when
// the provider asserts a VERIFIED email that matches it. In every other
// case (no email from the provider, or an unverified one) the sign-in mints
// a fresh row keyed by (provider, provider_user_id). Provider identity always
// wins outright: a (provider, provider_user_id) match returns that row no
// matter what email it carries.
//
// Pure function of the two DB lookups the callback performs, so the rule is
// unit-testable without a database (see tests/oauth-linking.test.mjs).
// ---------------------------------------------------------------------------
export function decideIdentity({
  provider,
  providerUserId,
  email,
  emailVerified,
  rowByProviderUid,
  rowByEmail,
}) {
  if (rowByProviderUid) return { action: 'return', user: rowByProviderUid };
  if (email && emailVerified && rowByEmail) return { action: 'link', user: rowByEmail };
  return { action: 'create', user: null };
}

// --- Provider HTTP ---------------------------------------------------------

function providerError(data) {
  // Meta: { error: { message, type, code } }. Google: { error, error_description }.
  // Error bodies never contain secrets; still, keep only a short message.
  const raw =
    (data && data.error && data.error.message) ||
    (data && data.error_description) ||
    (data && data.error) ||
    'provider request failed';
  const err = new Error('oauth provider error');
  err.providerMessage = String(raw).slice(0, 200);
  return err;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw providerError(data);
  return data;
}

async function getJson(url, accessToken) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw providerError(data);
  return data;
}

// Exchange the authorize code and fetch the profile. Returns a normalized
// profile: { providerUserId, email|null, emailVerified, name, avatarUrl|null }.
// Throws with err.providerMessage on any provider-side failure. Never logs
// codes, tokens, or secrets — callers must uphold that too.
export async function exchangeCodeForProfile({ provider, code, redirectUri }) {
  const cfg = getProviderConfig(provider);
  if (!cfg) throw new Error(`oauth provider not configured: ${provider}`);

  if (provider === 'google') {
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!tok.access_token) throw new Error('oauth provider error');
    const me = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', tok.access_token);
    const providerUserId = String(me.sub || '');
    if (!providerUserId) throw new Error('oauth provider error');
    return {
      providerUserId,
      email: typeof me.email === 'string' ? me.email : null,
      emailVerified: me.email_verified === true,
      name:
        typeof me.name === 'string' && me.name
          ? me.name
          : typeof me.email === 'string'
            ? me.email
            : 'Google user',
      avatarUrl: typeof me.picture === 'string' ? me.picture : null,
    };
  }

  if (provider === 'facebook') {
    const v = META_API_VERSION;
    const tokUrl =
      `https://graph.facebook.com/${v}/oauth/access_token?` +
      new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        client_secret: cfg.clientSecret,
        code,
      }).toString();
    const tokRes = await fetch(tokUrl, { signal: AbortSignal.timeout(15000) });
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok) throw providerError(tok);
    if (!tok.access_token) throw new Error('oauth provider error');
    const me = await getJson(
      `https://graph.facebook.com/${v}/me?` +
        new URLSearchParams({ fields: 'id,name,email,picture.type(large)' }).toString(),
      tok.access_token
    );
    const providerUserId = String(me.id || '');
    if (!providerUserId) throw new Error('oauth provider error');
    // Facebook verifies account emails, and the `email` field is only returned
    // when the user grants the email permission — a present email therefore
    // counts as verified for the linking rule in decideIdentity.
    const email = typeof me.email === 'string' ? me.email : null;
    return {
      providerUserId,
      email,
      emailVerified: email !== null,
      name: typeof me.name === 'string' && me.name ? me.name : 'Facebook user',
      avatarUrl:
        me && me.picture && me.picture.data && typeof me.picture.data.url === 'string'
          ? me.picture.data.url
          : null,
    };
  }

  if (provider === 'instagram') {
    const tok = await postForm('https://api.instagram.com/oauth/access_token', {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    if (!tok.access_token) throw new Error('oauth provider error');
    const me = await getJson(
      `https://graph.instagram.com/${META_API_VERSION}/me?` +
        new URLSearchParams({ fields: 'id,username,account_type' }).toString(),
      tok.access_token
    );
    const providerUserId = String(me.id || '');
    if (!providerUserId) throw new Error('oauth provider error');
    return {
      providerUserId,
      email: null,
      emailVerified: false,
      name:
        typeof me.username === 'string' && me.username ? `@${me.username}` : 'Instagram user',
      avatarUrl: null,
    };
  }

  throw new Error(`unknown oauth provider: ${provider}`);
}
