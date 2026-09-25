// Redirect target for tests/helpers/neon-stub-hook.mjs: stands in for
// `@neondatabase/serverless` in handler tests so the full request path
// (auth, validation, permission, writes) runs without a live Postgres.
//
// The stub's `neon()` returns a template-tag function that routes every
// sql`` call by its leading text and resolves canned rows. Tests install a
// fresh state object before each case via __setNeonStubState(); the tag
// dereferences the CURRENT state on every call (not the state from
// creation time), because _db.mjs caches the client across calls.
//
// Every query's normalized head is appended to state.queries, and every
// band_links write is recorded in state.linkWrites as
// { op: 'upsert'|'delete', platform, url? } — assertions target those.

let current = null;

export function __setNeonStubState(state) {
  current = state;
}

export function freshStubState(overrides = {}) {
  return {
    queries: [],
    linkWrites: [],
    memberSeq: 0,
    usersByToken: {},
    bandNameCandidates: [],
    existingBand: null,
    currentLinks: [],
    newBand: null,
    updatedBand: null,
    bands: [],
    members: [],
    memberships: [],
    linkRows: [],
    ...overrides,
  };
}

function route(state, head, values) {
  // findUserByToken: select id, email, name, token, ... from users where token = $1
  if (head.startsWith('select id, email, name, token')) {
    const user = state.usersByToken[values[0]];
    return user ? [user] : [];
  }
  // _rate_limit COUNT_SQL
  if (head.startsWith('insert into rate_limits')) {
    return [{ hits: 1, window_start: new Date().toISOString() }];
  }
  // createBandInNeon identity check
  if (head.startsWith('select id, name, city, country from bands where lower(name)')) {
    return state.bandNameCandidates;
  }
  // bands_edit existing-band fetch
  if (head.startsWith('select * from bands where id')) {
    return state.existingBand ? [state.existingBand] : [];
  }
  // bands_edit current-links fetch
  if (head.startsWith('select platform, url from band_links')) {
    return state.currentLinks;
  }
  // createBandInNeon transaction 1: band insert
  if (head.startsWith('insert into bands')) {
    const band = state.newBand || { id: 'band-new', name: 'New Band' };
    return [band];
  }
  // createBandInNeon transaction 1: member upserts (one fresh id each)
  if (head.startsWith('insert into band_members')) {
    state.memberSeq += 1;
    return [{ id: `member-${state.memberSeq}` }];
  }
  if (head.startsWith('insert into memberships')) return [{}];
  // bands_edit band update (metadata path or link-only attribution)
  if (head.startsWith('update bands set')) {
    return [state.updatedBand || state.existingBand || { id: 'band-1', name: 'Test Band' }];
  }
  if (head.startsWith('insert into contributions')) return [{}];
  if (head.startsWith('update users set')) return [{}];
  // band_links writes (both createBandInNeon tx2 and bands_edit tx)
  if (head.startsWith('insert into band_links')) {
    state.linkWrites.push({ op: 'upsert', platform: values[1], url: values[2] });
    return [{}];
  }
  if (head.startsWith('delete from band_links')) {
    state.linkWrites.push({ op: 'delete', platform: values[1] });
    return [{}];
  }
  // bands_neon.mjs read path
  if (head.startsWith('select id, name, city, state')) return state.bands || [];
  if (head.startsWith('select id, name, city, state, country, instrument1')) return state.members || [];
  if (head.startsWith('select id, band_id, member_id')) return state.memberships || [];
  if (head.startsWith('select band_id, platform, url')) return state.linkRows || [];
  // Anything else (notify internals, etc.) resolves empty and harmless.
  return [];
}

function makeTag() {
  const tag = (strings, ...values) => {
    if (!current) throw new Error('neon stub: __setNeonStubState() was not called');
    const head = String(strings[0] || '').replace(/\s+/g, ' ').trim().toLowerCase();
    current.queries.push(head);
    return Promise.resolve(route(current, head, values));
  };
  // bands_edit builds its dynamic SET clause with sql.unsafe(field); the
  // stub doesn't need real composition — routing only reads strings[0].
  tag.unsafe = (s) => s;
  tag.transaction = (queries) => Promise.all(queries);
  return tag;
}

export function neon(_url) {
  return makeTag();
}
