// Unit tests for the pure OAuth helpers in netlify/functions/_oauth.mjs.
// Everything covered here is dependency-free (no DB, no network): the
// identity-linking rule, the return_to guard, authorize-URL construction,
// and the placeholder-email scheme. Provider HTTP (exchangeCodeForProfile)
// is intentionally not covered — it needs live provider credentials.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OAUTH_PROVIDERS,
  META_API_VERSION,
  PLACEHOLDER_EMAIL_DOMAIN,
  placeholderEmail,
  isPlaceholderEmail,
  getProviderConfig,
  newState,
  buildAuthorizeUrl,
  validateReturnTo,
  decideIdentity,
} from '../netlify/functions/_oauth.mjs';

// --- decideIdentity: the critical linking rule --------------------------------
// THE RULE: an OAuth identity may link to an existing email row ONLY when the
// provider asserts a VERIFIED email match. Never on an unverified email.

const uidRow = { id: 'row-uid', provider: 'google', provider_user_id: 'g123' };
const emailRow = { id: 'row-email', provider: 'email', email: 'fan@example.com' };

test('known (provider, provider_user_id) returns that row — no email involved', () => {
  const d = decideIdentity({
    provider: 'google',
    providerUserId: 'g123',
    email: 'different@example.com',
    emailVerified: true,
    rowByProviderUid: uidRow,
    rowByEmail: emailRow,
  });
  assert.equal(d.action, 'return');
  assert.equal(d.user, uidRow);
});

test('verified email match links the OAuth identity to the existing row', () => {
  const d = decideIdentity({
    provider: 'google',
    providerUserId: 'g999',
    email: 'fan@example.com',
    emailVerified: true,
    rowByProviderUid: null,
    rowByEmail: emailRow,
  });
  assert.equal(d.action, 'link');
  assert.equal(d.user, emailRow);
});

test('UNVERIFIED email match does NOT link — creates a fresh row instead', () => {
  // This is the account-takeover guard: the email flow is unverified by
  // design, so an unverified provider email must never merge into it.
  const d = decideIdentity({
    provider: 'google',
    providerUserId: 'g999',
    email: 'fan@example.com',
    emailVerified: false,
    rowByProviderUid: null,
    rowByEmail: emailRow,
  });
  assert.equal(d.action, 'create');
  assert.equal(d.user, null);
});

test('no email from the provider (Instagram) never links — creates a fresh row', () => {
  const d = decideIdentity({
    provider: 'instagram',
    providerUserId: 'ig123',
    email: null,
    emailVerified: false,
    rowByProviderUid: null,
    rowByEmail: emailRow,
  });
  assert.equal(d.action, 'create');
  assert.equal(d.user, null);
});

test('verified email with no matching row creates a fresh row', () => {
  const d = decideIdentity({
    provider: 'facebook',
    providerUserId: 'fb123',
    email: 'new@example.com',
    emailVerified: true,
    rowByProviderUid: null,
    rowByEmail: null,
  });
  assert.equal(d.action, 'create');
  assert.equal(d.user, null);
});

// --- validateReturnTo: open-redirect guard ------------------------------------

test('validateReturnTo accepts same-origin relative paths', () => {
  assert.equal(validateReturnTo('/game'), '/game');
  assert.equal(validateReturnTo('/'), '/');
  assert.equal(validateReturnTo('/game?band=abc&x=1'), '/game?band=abc&x=1');
});

test('validateReturnTo rejects absolute and protocol-relative URLs', () => {
  assert.equal(validateReturnTo('https://evil.example/'), '/');
  assert.equal(validateReturnTo('//evil.example/'), '/');
  assert.equal(validateReturnTo('javascript:alert(1)'), '/');
});

test('validateReturnTo rejects backslashes, whitespace, and non-strings', () => {
  assert.equal(validateReturnTo('/\\evil.example'), '/');
  assert.equal(validateReturnTo('/game x'), '/');
  assert.equal(validateReturnTo(''), '/');
  assert.equal(validateReturnTo(null), '/');
  assert.equal(validateReturnTo(undefined), '/');
});

// --- buildAuthorizeUrl ----------------------------------------------------------

test('google authorize URL hits the Google endpoint with the right params', () => {
  const u = new URL(
    buildAuthorizeUrl({
      provider: 'google',
      clientId: 'CID',
      redirectUri: 'https://sixdegreesofrock.com/api/oauth/callback',
      state: 'ST',
    })
  );
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'CID');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://sixdegreesofrock.com/api/oauth/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'ST');
  assert.ok(u.searchParams.get('scope').includes('openid'));
  assert.ok(u.searchParams.get('scope').includes('email'));
});

test('facebook authorize URL hits the versioned Meta dialog endpoint', () => {
  const u = new URL(
    buildAuthorizeUrl({
      provider: 'facebook',
      clientId: 'CID',
      redirectUri: 'https://sixdegreesofrock.com/api/oauth/callback',
      state: 'ST',
    })
  );
  assert.equal(
    u.origin + u.pathname,
    `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`
  );
  assert.equal(u.searchParams.get('client_id'), 'CID');
  assert.equal(u.searchParams.get('state'), 'ST');
  assert.ok(u.searchParams.get('scope').includes('email'));
});

test('instagram authorize URL uses Instagram Login with the business scope', () => {
  const u = new URL(
    buildAuthorizeUrl({
      provider: 'instagram',
      clientId: 'CID',
      redirectUri: 'https://sixdegreesofrock.com/api/oauth/callback',
      state: 'ST',
    })
  );
  assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'CID');
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic');
  assert.equal(u.searchParams.get('state'), 'ST');
});

test('buildAuthorizeUrl throws on an unknown provider', () => {
  assert.throws(() =>
    buildAuthorizeUrl({ provider: 'myspace', clientId: 'x', redirectUri: 'y', state: 'z' })
  );
});

// --- placeholder emails ---------------------------------------------------------

test('placeholderEmail is deterministic, non-routable, and detectable', () => {
  const p = placeholderEmail('987654321');
  assert.equal(p, `ig-987654321@${PLACEHOLDER_EMAIL_DOMAIN}`);
  assert.ok(isPlaceholderEmail(p));
  assert.ok(isPlaceholderEmail(p.toUpperCase()));
});

test('isPlaceholderEmail rejects real addresses and non-strings', () => {
  assert.equal(isPlaceholderEmail('fan@example.com'), false);
  assert.equal(isPlaceholderEmail(''), false);
  assert.equal(isPlaceholderEmail(null), false);
  assert.equal(isPlaceholderEmail(undefined), false);
});

// --- newState ---------------------------------------------------------------------

test('newState returns a 48-char hex string', () => {
  const s = newState();
  assert.match(s, /^[0-9a-f]{48}$/);
  assert.notEqual(newState(), s);
});

// --- getProviderConfig --------------------------------------------------------------

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('getProviderConfig reads Google credentials from the environment', () => {
  withEnv({ GOOGLE_CLIENT_ID: 'gcid', GOOGLE_CLIENT_SECRET: 'gsec' }, () => {
    const cfg = getProviderConfig('google');
    assert.equal(cfg.clientId, 'gcid');
    assert.equal(cfg.clientSecret, 'gsec');
  });
});

test('getProviderConfig returns null when Google credentials are missing', () => {
  withEnv({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }, () => {
    assert.equal(getProviderConfig('google'), null);
  });
});

test('instagram uses its own Instagram app credentials', () => {
  withEnv(
    {
      FACEBOOK_APP_ID: 'fbid',
      FACEBOOK_APP_SECRET: 'fbsec',
      INSTAGRAM_APP_ID: 'igid',
      INSTAGRAM_APP_SECRET: 'igsec',
    },
    () => {
      const fb = getProviderConfig('facebook');
      const ig = getProviderConfig('instagram');
      assert.equal(fb.clientId, 'fbid');
      assert.equal(fb.clientSecret, 'fbsec');
      assert.equal(ig.clientId, 'igid');
      assert.equal(ig.clientSecret, 'igsec');
    }
  );
});

test('getProviderConfig returns null for an unknown provider', () => {
  assert.equal(getProviderConfig('myspace'), null);
});

test('OAUTH_PROVIDERS lists exactly the three supported providers', () => {
  assert.deepEqual([...OAUTH_PROVIDERS].sort(), ['facebook', 'google', 'instagram']);
});
