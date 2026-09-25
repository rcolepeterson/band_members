// Phase 3: social/streaming links for bands.
//
// Three layers:
//   1. _links.mjs pure units — domain validation per platform, input
//      normalization, diffing, write-query building, the creator/admin
//      permission rule.
//   2. Handler tests (bands_create / bands_edit / bands_neon / migrate)
//      through the neon stub in tests/helpers — the real request path
//      (auth, validation, permission, writes) with a fake Postgres.
//   3. Client tests — pure functions extracted from index.html by
//      brace-matching (the exact code that ships): the client-side domain
//      mirror (kept in sync with the server by a parity matrix), badge
//      SVG + rendering, the website name-link, and the link-row folding.
//      Plus structural guards that the nine form fields and the badge row
//      exist in the markup/CSS.
//
// Notify note: RESEND_API_KEY is unset here, so notifyBandTouched()
// short-circuits ("mailer not configured") without sending anything. The
// "links-only update notifies" assertion is behavioral: the link writes
// commit and the handler returns 200 through the code path that awaits
// notifyBandTouched() before responding.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// --- server: pure units (no DB, no stub needed) ------------------------------
import {
  LINK_PLATFORMS,
  PLATFORM_LABELS,
  validateLinkUrl,
  normalizeLinksInput,
  diffBandLinks,
  bandLinkWriteQueries,
  canManageBandLinks,
  requestHasAdminToken,
} from '../netlify/functions/_links.mjs';

// --- server: handlers, via the neon stub ------------------------------------
// register() must run before the handler modules load, so they are
// imported dynamically here (static imports above are stub-independent).
register('./helpers/neon-stub-hook.mjs', import.meta.url);
const { __setNeonStubState, freshStubState } = await import('./helpers/neon-stub.mjs');
const { default: bandsEdit } = await import('../netlify/functions/bands_edit.mjs');
const { default: bandsCreate } = await import('../netlify/functions/bands_create.mjs');
const { default: bandsNeon } = await import('../netlify/functions/bands_neon.mjs');
const { default: migrate } = await import('../netlify/functions/migrate.mjs');

// --- client: extract the exact shipping functions from index.html ------------
const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8'
);

function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found in index.html`);
  let depth = 0;
  let j = html.indexOf('{', start);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') {
      depth--;
      if (depth === 0) { j++; break; }
    }
  }
  return html.slice(start, j);
}

// Minimal DOM stub: createElement + textContent/innerHTML clearing semantics
// + setAttribute. Enough for renderBandBadges / renderBandNameLink.
function makeStubDocument() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      className: '',
      href: '',
      target: '',
      rel: '',
      title: '',
      _attrs: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
    };
    let text = '';
    Object.defineProperty(el, 'textContent', {
      get() { return text; },
      set(v) { text = String(v); el.children = []; },
    });
    let markup = '';
    Object.defineProperty(el, 'innerHTML', {
      get() { return markup; },
      set(v) { markup = String(v); },
    });
    return el;
  }
  return { createElement: makeEl };
}

const clientFactory = new Function(
  'document',
  [
    extract('linkUrlValidForPlatform'),
    extract('bandPlatformLabel'),
    extract('bandBadgeSvgFor'),
    extract('renderBandNameLink'),
    extract('renderBandBadges'),
    extract('buildBandLinksMap'),
  ].join('\n') +
  `\n; return {
    linkUrlValidForPlatform, bandPlatformLabel, bandBadgeSvgFor,
    renderBandNameLink, renderBandBadges, buildBandLinksMap,
  };`
);

function clientFns() {
  return clientFactory(makeStubDocument());
}

// ============================================================================
// 1. _links.mjs units
// ============================================================================

describe('platform allowlist', () => {
  it('covers exactly the nine designed platforms', () => {
    assert.deepEqual(LINK_PLATFORMS, [
      'spotify', 'apple_music', 'youtube', 'bandcamp',
      'instagram', 'tiktok', 'facebook', 'x', 'website',
    ]);
  });

  it('labels every platform', () => {
    for (const p of LINK_PLATFORMS) {
      assert.ok(PLATFORM_LABELS[p], `missing label for ${p}`);
    }
  });
});

const GOOD_URLS = {
  spotify: ['https://open.spotify.com/artist/abc123', 'https://spotify.com/artist/abc'],
  apple_music: ['https://music.apple.com/us/artist/name/12345'],
  youtube: [
    'https://www.youtube.com/@band',
    'https://youtube.com/channel/UCabc',
    'https://m.youtube.com/watch?v=abc',
    'https://youtu.be/abc123',
  ],
  bandcamp: ['https://bandname.bandcamp.com', 'https://bandname.bandcamp.com/album/x'],
  instagram: ['https://instagram.com/band', 'https://www.instagram.com/band/'],
  tiktok: ['https://tiktok.com/@band', 'https://www.tiktok.com/@band'],
  facebook: ['https://facebook.com/band', 'https://m.facebook.com/band', 'https://fb.com/band'],
  x: ['https://x.com/band', 'https://twitter.com/band', 'https://mobile.twitter.com/band'],
  website: ['https://band.example', 'http://band.example/page', 'https://sub.band.example/'],
};

const BAD_URLS = {
  spotify: [
    'https://open.spotify.com.evil.test/artist/x', // lookalike subdomain
    'https://notspotify.com/artist/x',
    'https://youtube.com/@band', // right shape, wrong platform
  ],
  apple_music: ['https://music.apple.com.evil.test/x', 'https://apple.com/x'],
  youtube: ['https://youtube.com.evil.test/@x', 'https://fakeyoutube.com/x'],
  bandcamp: ['https://bandcamp.com.evil.test/', 'https://notbandcamp.com/'],
  instagram: ['https://instagram.com.evil.test/band'],
  tiktok: ['https://tiktok.com.evil.test/@band'],
  facebook: ['https://facebook.com.evil.test/band', 'https://fb.com.evil.test/band'],
  x: ['https://x.com.evil.test/band', 'https://twitter.com.evil.test/band'],
  website: [],
};

describe('validateLinkUrl', () => {
  for (const [platform, urls] of Object.entries(GOOD_URLS)) {
    for (const url of urls) {
      it(`accepts ${platform}: ${url}`, () => {
        const r = validateLinkUrl(platform, url);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.url, url.trim());
      });
    }
  }

  for (const [platform, urls] of Object.entries(BAD_URLS)) {
    for (const url of urls) {
      it(`rejects ${platform}: ${url}`, () => {
        const r = validateLinkUrl(platform, url);
        assert.equal(r.ok, false, `expected rejection for ${url}`);
      });
    }
  }

  it('rejects cross-platform URLs in every slot (website excepted: any http(s) URL is valid there)', () => {
    const pairs = [
      ['spotify', 'https://open.spotify.com/artist/x'],
      ['youtube', 'https://youtube.com/@x'],
      ['instagram', 'https://instagram.com/x'],
    ];
    for (const platform of LINK_PLATFORMS) {
      if (platform === 'website') continue;
      for (const [other, url] of pairs) {
        if (other === platform) continue;
        assert.equal(validateLinkUrl(platform, url).ok, false,
          `${platform} should reject ${other}'s URL`);
      }
    }
  });

  it('rejects unknown platforms', () => {
    assert.equal(validateLinkUrl('myspace', 'https://myspace.com/x').ok, false);
  });

  it('treats empty/blank input as a valid removal (null)', () => {
    for (const raw of ['', '   ', null, undefined]) {
      const r = validateLinkUrl('spotify', raw);
      assert.equal(r.ok, true);
      assert.equal(r.url, null);
    }
  });

  it('rejects malformed, non-http, credentialed, and overlong URLs', () => {
    assert.equal(validateLinkUrl('spotify', 'not a url').ok, false);
    assert.equal(validateLinkUrl('spotify', 'ftp://open.spotify.com/x').ok, false);
    assert.equal(validateLinkUrl('spotify', 'javascript:alert(1)').ok, false);
    assert.equal(validateLinkUrl('spotify', 'https://user:pass@open.spotify.com/x').ok, false);
    assert.equal(validateLinkUrl('website', 'https://user:pass@band.example/').ok, false);
    assert.equal(validateLinkUrl('spotify', 'https://open.spotify.com/' + 'a'.repeat(600)).ok, false);
  });

  it('website accepts any http(s) host', () => {
    assert.equal(validateLinkUrl('website', 'https://totally-custom-domain.xyz/band').ok, true);
    assert.equal(validateLinkUrl('website', 'https://instagram.com/band').ok, true);
  });
});

describe('normalizeLinksInput', () => {
  it('passes through null/undefined as "no link changes"', () => {
    assert.deepEqual(normalizeLinksInput(null), { ok: true, links: {} });
    assert.deepEqual(normalizeLinksInput(undefined), { ok: true, links: {} });
  });

  it('maps blank strings to null (removal)', () => {
    const r = normalizeLinksInput({ spotify: '   ', youtube: 'https://youtube.com/@x' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.links, { spotify: null, youtube: 'https://youtube.com/@x' });
  });

  it('rejects unknown platform keys', () => {
    const r = normalizeLinksInput({ myspace: 'https://myspace.com/x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown platform/);
  });

  it('rejects non-object input', () => {
    assert.equal(normalizeLinksInput('https://x.com').ok, false);
    assert.equal(normalizeLinksInput(['x']).ok, false);
  });

  it('rejects non-string values instead of coercing them into deletions', () => {
    for (const raw of [123, true, { url: 'x' }, ['x']]) {
      const r = normalizeLinksInput({ spotify: raw });
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
      assert.equal(r.field, 'links.spotify');
    }
  });

  it('reports the failing platform as the field', () => {
    const r = normalizeLinksInput({ spotify: 'https://evil.test/x' });
    assert.equal(r.ok, false);
    assert.equal(r.field, 'links.spotify');
  });
});

describe('diffBandLinks', () => {
  it('detects add, replace, and remove', () => {
    assert.deepEqual(
      diffBandLinks([], { spotify: 'https://open.spotify.com/artist/new' }),
      { spotify: 'https://open.spotify.com/artist/new' }
    );
    assert.deepEqual(
      diffBandLinks(
        [{ platform: 'spotify', url: 'https://open.spotify.com/artist/old' }],
        { spotify: 'https://open.spotify.com/artist/new' }
      ),
      { spotify: 'https://open.spotify.com/artist/new' }
    );
    assert.deepEqual(
      diffBandLinks(
        [{ platform: 'spotify', url: 'https://open.spotify.com/artist/old' }],
        { spotify: null }
      ),
      { spotify: null }
    );
  });

  it('returns {} for identical resubmissions and empty desired maps', () => {
    const current = [{ platform: 'spotify', url: 'https://open.spotify.com/artist/x' }];
    assert.deepEqual(
      diffBandLinks(current, { spotify: 'https://open.spotify.com/artist/x' }),
      {}
    );
    assert.deepEqual(diffBandLinks(current, {}), {});
  });

  it('ignores unknown platforms defensively', () => {
    assert.deepEqual(diffBandLinks([], { myspace: 'https://myspace.com/x' }), {});
  });
});

describe('bandLinkWriteQueries', () => {
  const fakeSql = (strings, ...values) => ({ head: strings[0].trim().split('\n')[0], values });

  it('builds upserts for values and deletes for nulls', () => {
    const qs = bandLinkWriteQueries(fakeSql, 'band-1', {
      spotify: 'https://open.spotify.com/artist/x',
      youtube: null,
    });
    assert.equal(qs.length, 2);
    assert.match(qs[0].head, /insert into band_links/);
    assert.deepEqual(qs[0].values.slice(0, 3), ['band-1', 'spotify', 'https://open.spotify.com/artist/x']);
    assert.match(qs[1].head, /delete from band_links/);
  });

  it('returns [] for empty input and skips unknown platforms', () => {
    assert.deepEqual(bandLinkWriteQueries(fakeSql, 'band-1', {}), []);
    assert.deepEqual(bandLinkWriteQueries(fakeSql, 'band-1', { myspace: 'x' }), []);
  });
});

describe('link permission rule', () => {
  const noTokenReq = { headers: new Headers() };

  it('lets the band creator manage links', () => {
    assert.equal(
      canManageBandLinks({ bandAddedBy: 'user-1', userId: 'user-1', req: noTokenReq }),
      true
    );
  });

  it('rejects a signed-in stranger', () => {
    assert.equal(
      canManageBandLinks({ bandAddedBy: 'user-1', userId: 'user-2', req: noTokenReq }),
      false
    );
  });

  it('rejects anonymous callers', () => {
    assert.equal(
      canManageBandLinks({ bandAddedBy: 'user-1', userId: null, req: noTokenReq }),
      false
    );
  });

  it('lets legacy bands (null added_by) be managed only via admin token', () => {
    assert.equal(
      canManageBandLinks({ bandAddedBy: null, userId: 'user-1', req: noTokenReq }),
      false
    );
  });

  it('requestHasAdminToken checks the x-admin-token header against env', () => {
    const before = process.env.ADMIN_TOKEN;
    try {
      process.env.ADMIN_TOKEN = 'secret-123';
      const good = { headers: new Headers({ 'x-admin-token': 'secret-123' }) };
      const bad = { headers: new Headers({ 'x-admin-token': 'nope' }) };
      const missing = { headers: new Headers() };
      assert.equal(requestHasAdminToken(good), true);
      assert.equal(requestHasAdminToken(bad), false);
      assert.equal(requestHasAdminToken(missing), false);
      delete process.env.ADMIN_TOKEN;
      assert.equal(requestHasAdminToken(good), false);
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  });

  it('grants admin-token holders regardless of creator', () => {
    const before = process.env.ADMIN_TOKEN;
    try {
      process.env.ADMIN_TOKEN = 'secret-123';
      const adminReq = { headers: new Headers({ 'x-admin-token': 'secret-123' }) };
      assert.equal(canManageBandLinks({ bandAddedBy: 'user-1', userId: null, req: adminReq }), true);
      assert.equal(canManageBandLinks({ bandAddedBy: null, userId: 'user-9', req: adminReq }), true);
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  });
});

// ============================================================================
// 2. Handler tests through the neon stub
// ============================================================================

process.env.NETLIFY_DATABASE_URL = 'postgres://stub/stub';
process.env.ADMIN_TOKEN = 'test-admin-token';

const CREATOR = { id: 'user-creator', email: 'creator@example.test', name: 'Creator', token: 'creator-token' };
const STRANGER = { id: 'user-stranger', email: 'stranger@example.test', name: 'Stranger', token: 'stranger-token' };
const BAND = {
  id: 'band-1', name: 'Test Band', city: 'Seattle', state: 'WA', country: 'USA',
  added_by: 'user-creator', edited_by: null,
};

function patchBandsEdit({ token, adminToken, body, id = 'band-1' }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = 'Bearer ' + token;
  if (adminToken) headers['x-admin-token'] = adminToken;
  return bandsEdit(
    new Request(`https://example.test/api/bands/${id}`, {
      method: 'PATCH',
      headers: new Headers(headers),
      body: JSON.stringify(body),
    }),
    { params: { id } }
  );
}

function postBandsCreate({ token, body }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = 'Bearer ' + token;
  return bandsCreate(
    new Request('https://example.test/api/bands', {
      method: 'POST',
      headers: new Headers(headers),
      body: JSON.stringify(body),
    }),
    {}
  );
}

function baseEditState(overrides = {}) {
  const state = freshStubState({
    usersByToken: { 'creator-token': CREATOR, 'stranger-token': STRANGER },
    existingBand: { ...BAND },
    currentLinks: [],
    ...overrides,
  });
  __setNeonStubState(state);
  return state;
}

describe('bands_edit link permissions', () => {
  it('creator link edit allowed: writes links, returns them', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { spotify: 'https://open.spotify.com/artist/abc' } },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.links, { spotify: 'https://open.spotify.com/artist/abc' });
    assert.deepEqual(state.linkWrites, [
      { op: 'upsert', platform: 'spotify', url: 'https://open.spotify.com/artist/abc' },
    ]);
  });

  it('stranger link edit rejected with 403 and writes nothing', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      token: 'stranger-token',
      body: { links: { spotify: 'https://open.spotify.com/artist/abc' } },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.deepEqual(state.linkWrites, []);
    assert.ok(!state.queries.some((q) => q.startsWith('update bands set')),
      'no band UPDATE should run for a rejected link edit');
  });

  it('anonymous link edit rejected with 401', async () => {
    baseEditState();
    const res = await patchBandsEdit({
      body: { links: { spotify: 'https://open.spotify.com/artist/abc' } },
    });
    assert.equal(res.status, 401);
  });

  it('admin token (no bearer) can edit links', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      adminToken: 'test-admin-token',
      body: { links: { youtube: 'https://youtube.com/@testband' } },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(state.linkWrites, [
      { op: 'upsert', platform: 'youtube', url: 'https://youtube.com/@testband' },
    ]);
  });

  it('admin token (no bearer) cannot edit metadata — links only', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      adminToken: 'test-admin-token',
      body: { label: 'Sub Pop', links: { youtube: 'https://youtube.com/@testband' } },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.deepEqual(state.linkWrites, []);
    assert.ok(!state.queries.some((q) => q.startsWith('update bands set')),
      'no band UPDATE should run for a rejected metadata edit');
  });

  it('admin token (no bearer) with unchanged metadata values still edits links', async () => {
    const state = baseEditState({ existingBand: { ...BAND, label: 'Sub Pop' } });
    const res = await patchBandsEdit({
      adminToken: 'test-admin-token',
      body: { label: 'Sub Pop', links: { youtube: 'https://youtube.com/@testband' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.linkWrites, [
      { op: 'upsert', platform: 'youtube', url: 'https://youtube.com/@testband' },
    ]);
  });

  it('wrong admin token is rejected', async () => {
    baseEditState();
    const res = await patchBandsEdit({
      adminToken: 'wrong-token',
      body: { links: { youtube: 'https://youtube.com/@testband' } },
    });
    assert.equal(res.status, 401);
  });

  it('stranger can still edit plain metadata (no links key)', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      token: 'stranger-token',
      body: { label: 'Sub Pop' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.changes.label.new, 'Sub Pop');
    assert.deepEqual(state.linkWrites, []);
  });
});

describe('bands_edit link write semantics', () => {
  it('empty string removes a link', async () => {
    const state = baseEditState({
      currentLinks: [{ platform: 'spotify', url: 'https://open.spotify.com/artist/abc' }],
    });
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { spotify: '' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.linkWrites, [{ op: 'delete', platform: 'spotify' }]);
  });

  it('replaces an existing link via upsert', async () => {
    const state = baseEditState({
      currentLinks: [{ platform: 'spotify', url: 'https://open.spotify.com/artist/old' }],
    });
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { spotify: 'https://open.spotify.com/artist/new' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.linkWrites, [
      { op: 'upsert', platform: 'spotify', url: 'https://open.spotify.com/artist/new' },
    ]);
  });

  it('links-only resubmission with no changes is a true no-op', async () => {
    const state = baseEditState({
      currentLinks: [{ platform: 'spotify', url: 'https://open.spotify.com/artist/abc' }],
    });
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { spotify: 'https://open.spotify.com/artist/abc' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.linkWrites, []);
    assert.ok(!state.queries.some((q) => q.startsWith('update bands set')),
      'no band UPDATE on a no-op');
    assert.ok(!state.queries.some((q) => q.startsWith('insert into contributions')),
      'no contribution on a no-op');
  });

  it('links-only change still runs the write path (which awaits notify)', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { instagram: 'https://instagram.com/testband' } },
    });
    assert.equal(res.status, 200);
    // The handler awaits notifyBandTouched() after this transaction and
    // before responding; the stub mailer short-circuits (no RESEND_API_KEY).
    assert.ok(state.queries.some((q) => q.startsWith('update bands set')),
      'link-only edit attributes the touch via a band UPDATE');
    assert.deepEqual(state.linkWrites, [
      { op: 'upsert', platform: 'instagram', url: 'https://instagram.com/testband' },
    ]);
  });

  it('invalid link URL is a 400 and writes nothing', async () => {
    const state = baseEditState();
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { spotify: 'https://youtube.com/@testband' } },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.field, 'links.spotify');
    assert.deepEqual(state.linkWrites, []);
  });

  it('unknown platform key is a 400', async () => {
    baseEditState();
    const res = await patchBandsEdit({
      token: 'creator-token',
      body: { links: { myspace: 'https://myspace.com/x' } },
    });
    assert.equal(res.status, 400);
  });
});

describe('bands_create links', () => {
  const newBandBody = (links) => ({
    name: 'Brand New Band',
    city: 'Seattle',
    country: 'USA',
    members: [{ name: 'Alice Player', instrument1: 'Bass' }],
    links,
  });

  it('writes links atomically with the new band', async () => {
    const state = freshStubState({
      usersByToken: { 'creator-token': CREATOR },
      newBand: { id: 'band-new', name: 'Brand New Band' },
    });
    __setNeonStubState(state);
    const res = await postBandsCreate({
      token: 'creator-token',
      body: newBandBody({
        spotify: 'https://open.spotify.com/artist/abc',
        website: 'https://brandnewband.example',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(state.linkWrites, [
      { op: 'upsert', platform: 'spotify', url: 'https://open.spotify.com/artist/abc' },
      { op: 'upsert', platform: 'website', url: 'https://brandnewband.example' },
    ]);
  });

  it('rejects a bad link with 400 and creates nothing', async () => {
    const state = freshStubState({
      usersByToken: { 'creator-token': CREATOR },
      newBand: { id: 'band-new', name: 'Brand New Band' },
    });
    __setNeonStubState(state);
    const res = await postBandsCreate({
      token: 'creator-token',
      body: newBandBody({ spotify: 'https://evil.test/x' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.field, 'links.spotify');
    assert.deepEqual(state.linkWrites, []);
    assert.ok(!state.queries.some((q) => q.startsWith('insert into bands')),
      'no band INSERT after link validation fails');
  });

  it('omitting links still creates the band', async () => {
    const state = freshStubState({
      usersByToken: { 'creator-token': CREATOR },
      newBand: { id: 'band-new', name: 'Brand New Band' },
    });
    __setNeonStubState(state);
    const body = newBandBody(undefined);
    delete body.links;
    const res = await postBandsCreate({ token: 'creator-token', body });
    assert.equal(res.status, 200);
    assert.deepEqual(state.linkWrites, []);
  });
});

describe('bands_neon read path', () => {
  it('returns band_links as a fourth array', async () => {
    const state = freshStubState({
      bands: [{ id: 'band-1', name: 'Test Band' }],
      members: [],
      memberships: [],
      linkRows: [
        { band_id: 'band-1', platform: 'spotify', url: 'https://open.spotify.com/artist/abc' },
        { band_id: 'band-1', platform: 'website', url: 'https://testband.example' },
      ],
    });
    __setNeonStubState(state);
    const res = await bandsNeon(new Request('https://example.test/api/bands', { method: 'GET' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.band_links, state.linkRows);
  });
});

describe('migrate', () => {
  it('creates the band_links table + index idempotently', async () => {
    const state = freshStubState();
    __setNeonStubState(state);
    const res = await migrate(
      new Request('https://example.test/api/migrate', {
        method: 'POST',
        headers: new Headers({ 'x-admin-token': 'test-admin-token' }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.steps.includes('table band_links ready'));
    assert.ok(body.steps.includes('index band_links_band_id_idx ready'));
    assert.ok(body.steps.includes('trigger band_links_set_updated_at ready'));
  });

  it('rejects migrate without the admin token', async () => {
    __setNeonStubState(freshStubState());
    const res = await migrate(new Request('https://example.test/api/migrate', { method: 'POST' }));
    assert.equal(res.status, 401);
  });
});

// ============================================================================
// 3. Client tests (extracted from index.html)
// ============================================================================

describe('client/server domain parity', () => {
  it('client mirror agrees with the server on every good/bad URL', () => {
    const { linkUrlValidForPlatform } = clientFns();
    for (const [platform, urls] of Object.entries(GOOD_URLS)) {
      for (const url of urls) {
        assert.equal(linkUrlValidForPlatform(platform, url), true,
          `client should accept ${platform}: ${url}`);
      }
    }
    for (const [platform, urls] of Object.entries(BAD_URLS)) {
      for (const url of urls) {
        assert.equal(linkUrlValidForPlatform(platform, url), false,
          `client should reject ${platform}: ${url}`);
      }
    }
    // Credentialed + overlong + non-http, mirrored from the server tests.
    assert.equal(linkUrlValidForPlatform('spotify', 'https://user:pass@open.spotify.com/x'), false);
    assert.equal(linkUrlValidForPlatform('spotify', 'ftp://open.spotify.com/x'), false);
    assert.equal(linkUrlValidForPlatform('spotify', 'https://open.spotify.com/' + 'a'.repeat(600)), false);
    assert.equal(linkUrlValidForPlatform('myspace', 'https://myspace.com/x'), false);
  });
});

describe('bandBadgeSvgFor', () => {
  it('returns an inline SVG for each badge platform', () => {
    const { bandBadgeSvgFor } = clientFns();
    for (const p of ['spotify', 'apple_music', 'youtube', 'bandcamp', 'instagram', 'tiktok', 'facebook', 'x']) {
      const svg = bandBadgeSvgFor(p);
      assert.match(svg, /^<svg viewBox="0 0 24 24"/, p);
      assert.ok(!svg.includes('#'), `${p}: no hard-coded brand colors allowed`);
    }
  });

  it('returns empty string for unknown platforms', () => {
    const { bandBadgeSvgFor } = clientFns();
    assert.equal(bandBadgeSvgFor('myspace'), '');
  });
});

describe('renderBandNameLink', () => {
  it('makes the band name a new-tab noopener website link', () => {
    const { renderBandNameLink } = clientFns();
    const nameEl = makeStubDocument().createElement('div');
    renderBandNameLink(nameEl, 'Test Band', 'https://testband.example');
    assert.equal(nameEl.children.length, 1);
    const a = nameEl.children[0];
    assert.equal(a.tagName, 'A');
    assert.equal(a.className, 'band-website-link');
    assert.equal(a.textContent, 'Test Band');
    assert.equal(a.href, 'https://testband.example');
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener');
  });

  it('keeps plain text when there is no website', () => {
    const { renderBandNameLink } = clientFns();
    for (const website of [null, undefined, '']) {
      const nameEl = makeStubDocument().createElement('div');
      renderBandNameLink(nameEl, 'Test Band', website);
      assert.equal(nameEl.textContent, 'Test Band');
      assert.equal(nameEl.children.length, 0);
    }
  });

  it('clears a previous link when switching nodes', () => {
    const { renderBandNameLink } = clientFns();
    const doc = makeStubDocument();
    const nameEl = doc.createElement('div');
    renderBandNameLink(nameEl, 'Band A', 'https://a.example');
    renderBandNameLink(nameEl, 'Band B', null);
    assert.equal(nameEl.textContent, 'Band B');
    assert.equal(nameEl.children.length, 0);
  });
});

describe('renderBandBadges', () => {
  const ORDER = ['spotify', 'apple_music', 'youtube', 'bandcamp', 'instagram', 'tiktok', 'facebook', 'x'];

  it('renders one badge per linked platform, in order', () => {
    const { renderBandBadges } = clientFns();
    const doc = makeStubDocument();
    const el = doc.createElement('div');
    renderBandBadges(el, {
      youtube: 'https://youtube.com/@x',
      spotify: 'https://open.spotify.com/artist/x',
    }, ORDER);
    assert.equal(el.children.length, 2);
    assert.equal(el.children[0].getAttribute('aria-label'), 'Spotify');
    assert.equal(el.children[1].getAttribute('aria-label'), 'YouTube');
  });

  it('badges open in a new tab with rel=noopener and carry the URL', () => {
    const { renderBandBadges } = clientFns();
    const doc = makeStubDocument();
    const el = doc.createElement('div');
    renderBandBadges(el, { x: 'https://x.com/band' }, ORDER);
    const badge = el.children[0];
    assert.equal(badge.className, 'social-badge');
    assert.equal(badge.href, 'https://x.com/band');
    assert.equal(badge.target, '_blank');
    assert.equal(badge.rel, 'noopener');
    assert.ok(badge.innerHTML.includes('<svg'), 'badge carries its icon');
  });

  it('renders nothing for missing links and never for website', () => {
    const { renderBandBadges } = clientFns();
    const doc = makeStubDocument();
    const el = doc.createElement('div');
    renderBandBadges(el, {
      website: 'https://band.example',
      spotify: 'https://open.spotify.com/artist/x',
    }, ORDER);
    assert.equal(el.children.length, 1);
    assert.equal(el.children[0].getAttribute('aria-label'), 'Spotify');
  });

  it('renders nothing for empty/missing link maps', () => {
    const { renderBandBadges } = clientFns();
    const doc = makeStubDocument();
    for (const links of [{}, null, undefined]) {
      const el = doc.createElement('div');
      renderBandBadges(el, links, ORDER);
      assert.equal(el.children.length, 0);
    }
  });

  it('clears previous badges when switching nodes', () => {
    const { renderBandBadges } = clientFns();
    const doc = makeStubDocument();
    const el = doc.createElement('div');
    renderBandBadges(el, { spotify: 'https://open.spotify.com/artist/x' }, ORDER);
    renderBandBadges(el, {}, ORDER);
    assert.equal(el.children.length, 0);
  });
});

describe('buildBandLinksMap', () => {
  it('folds link rows into band_id -> { platform: url }', () => {
    const { buildBandLinksMap } = clientFns();
    const map = buildBandLinksMap([
      { band_id: 'b1', platform: 'spotify', url: 'https://open.spotify.com/artist/x' },
      { band_id: 'b1', platform: 'website', url: 'https://x.example' },
      { band_id: 'b2', platform: 'youtube', url: 'https://youtube.com/@y' },
    ]);
    assert.deepEqual(map.get('b1'), {
      spotify: 'https://open.spotify.com/artist/x',
      website: 'https://x.example',
    });
    assert.deepEqual(map.get('b2'), { youtube: 'https://youtube.com/@y' });
    assert.equal(map.get('b3'), undefined);
  });

  it('skips malformed rows and handles empty input', () => {
    const { buildBandLinksMap } = clientFns();
    const map = buildBandLinksMap([null, {}, { band_id: 'b1' }, { platform: 'x' }]);
    assert.equal(map.size, 0);
    assert.equal(buildBandLinksMap(null).size, 0);
    assert.equal(buildBandLinksMap([]).size, 0);
  });
});

describe('markup + CSS structure', () => {
  const ADD_IDS = ['spotify', 'apple_music', 'youtube', 'bandcamp', 'instagram', 'tiktok', 'facebook', 'x', 'website'];

  it('add-band form has all nine link fields', () => {
    for (const id of ADD_IDS) {
      assert.ok(html.includes(`id="link-${id}"`), `missing add-band field link-${id}`);
    }
  });

  it('edit-band form has all nine link fields', () => {
    for (const id of ADD_IDS) {
      assert.ok(html.includes(`id="edit-link-${id}"`), `missing edit-band field edit-link-${id}`);
    }
  });

  it('node card has the badge row below the name', () => {
    assert.ok(html.includes('id="node-card-badges"'), 'missing #node-card-badges');
    const nameIdx = html.indexOf('id="node-card-name"');
    const badgesIdx = html.indexOf('id="node-card-badges"');
    const subIdx = html.indexOf('id="node-card-sub"');
    assert.ok(nameIdx < badgesIdx && badgesIdx < subIdx, 'badge row must sit between the name and the sub line');
  });

  it('badge diameter is locked to the verification pill height via one variable', () => {
    assert.ok(html.includes('--badge-size: calc(var(--text-xs) + 6px)'),
      'missing shared --badge-size (text-xs + 2*2px padding + 2*1px border)');
    assert.ok(html.includes('.social-badge') && html.includes('width: var(--badge-size)'),
      '.social-badge must size from --badge-size');
  });

  it('bio URL rejection is untouched', () => {
    assert.ok(html.includes('Bio must be plain text only'), 'bio no-URL message missing');
    assert.ok(html.includes('function bioContainsBlockedLink'), 'bioContainsBlockedLink missing');
  });
});
