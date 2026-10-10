// Tests for the Neon-transfer Blobs version cache (_graph_cache.mjs).
//
// The core logic takes `sql` and `store` as parameters, so these tests pass
// in-memory mocks — no live DB, no Blobs, no network.
//
// Covered:
//  - unchanged version -> Blob served, buildPayload (the big Neon queries)
//    never runs;
//  - changed version -> buildPayload runs, new Blob saved, served;
//  - Blob read error -> falls back to Neon, serves fresh payload;
//  - Blob write error -> still serves the fresh payload (best effort);
//  - version query failure -> straight to Neon, no Blob involvement;
//  - blobKeyFor is stable for the same version and differs across versions;
//  - getDataVersion issues the lazy updated_at ALTER before reading.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BANDS_TABLES,
  GAME_TABLES,
  MAX_BLOB_AGE_MS,
  blobKeyFor,
  getDataVersion,
  serveCachedGraph,
} from '../netlify/functions/_graph_cache.mjs';

// --- Mocks -----------------------------------------------------------------

// Minimal mock of the Neon sql tag: records every query string it sees and
// returns canned rows. Supports sql.unsafe(name) for identifier interpolation
// (returns the name as-is, like the real driver's unsafe helper).
function makeMockSql({ versionRows, alterSeen = [] } = {}) {
  const seen = [];
  const unsafe = (s) => s;
  const tag = (strings, ...values) => {
    const text = strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? values[i] : ''), '');
    seen.push(text);
    if (/alter table/i.test(text)) {
      alterSeen.push(text);
      return Promise.resolve([]);
    }
    if (/max\(updated_at\)/i.test(text)) {
      return Promise.resolve(versionRows || [{ max_updated: new Date('2026-10-10T12:00:00Z'), n: '10' }]);
    }
    return Promise.resolve([]);
  };
  tag.unsafe = unsafe;
  tag.seen = seen;
  tag.alterSeen = alterSeen;
  return tag;
}

function makeMockStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    failGet: false,
    failSet: false,
    gets: [],
    sets: [],
    async get(key) {
      this.gets.push(key);
      if (this.failGet) throw new Error('blob read failed');
      const v = data[key];
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    },
    async setJSON(key, value) {
      this.sets.push(key);
      if (this.failSet) throw new Error('blob write failed');
      data[key] = JSON.parse(JSON.stringify(value));
    },
  };
}

const PAYLOAD = { ok: true, bands: [{ id: 'b1' }], members: [], memberships: [], band_links: [] };

function toResponse(payload) {
  return { payload, headers: { 'content-type': 'application/json' } };
}

// --- blobKeyFor --------------------------------------------------------------

test('blobKeyFor is stable for the same version and differs across versions', () => {
  const v1 = 'bands:2026-10-10T12:00:00.000Z:3023|band_members:2026-10-10T11:00:00.000Z:13419';
  const v2 = 'bands:2026-10-10T13:00:00.000Z:3023|band_members:2026-10-10T11:00:00.000Z:13419';
  assert.equal(blobKeyFor('api-bands', v1), blobKeyFor('api-bands', v1));
  assert.notEqual(blobKeyFor('api-bands', v1), blobKeyFor('api-bands', v2));
  assert.ok(blobKeyFor('api-bands', v1).startsWith('api-bands-v'));
});

test('BANDS_TABLES includes band_links; GAME_TABLES does not', () => {
  assert.deepEqual([...BANDS_TABLES].sort(), ['band_links', 'band_members', 'bands', 'memberships']);
  assert.deepEqual([...GAME_TABLES].sort(), ['band_members', 'bands', 'memberships']);
  assert.equal(MAX_BLOB_AGE_MS, 24 * 60 * 60 * 1000);
});

// --- getDataVersion ------------------------------------------------------------

test('getDataVersion runs the lazy updated_at ALTER before the version query', async () => {
  const alterSeen = [];
  const sql = makeMockSql({ alterSeen });
  const version = await getDataVersion(sql, ['bands']);
  assert.ok(alterSeen.length >= 1, 'expected at least one ALTER TABLE');
  assert.ok(/updated_at/.test(alterSeen[0]), 'ALTER should add updated_at');
  assert.ok(version.startsWith('bands:'), `unexpected version: ${version}`);
});

// --- serveCachedGraph ----------------------------------------------------------

test('unchanged version serves the Blob without running the big queries', async () => {
  const sql = makeMockSql();
  let built = 0;
  const buildPayload = async () => { built++; return PAYLOAD; };

  // Pre-populate the store as if a previous run saved this exact version.
  const version = await getDataVersion(sql, BANDS_TABLES);
  const store = makeMockStore();
  const key = blobKeyFor('api-bands', version);
  store.data[key] = PAYLOAD;
  store.data['api-bands-meta'] = { version, builtAt: Date.now() };

  const res = await serveCachedGraph({
    sql, store, tables: BANDS_TABLES, prefix: 'api-bands',
    buildPayload, toResponse,
  });
  assert.equal(built, 0, 'buildPayload must not run when the Blob hits');
  assert.deepEqual(res.payload, PAYLOAD);
  // The version query runs (cheap); the big build queries must not.
  assert.ok(sql.seen.some((q) => /max\(updated_at\)/i.test(q)));
});

test('changed version rebuilds from Neon and saves the new Blob', async () => {
  const sql = makeMockSql();
  let built = 0;
  const buildPayload = async () => { built++; return { ...PAYLOAD, rebuilt: true }; };

  // Store holds a copy for an OLD version only.
  const store = makeMockStore();
  store.data[blobKeyFor('api-bands', 'old-version')] = PAYLOAD;
  store.data['api-bands-meta'] = { version: 'old-version', builtAt: Date.now() };

  const res = await serveCachedGraph({
    sql, store, tables: BANDS_TABLES, prefix: 'api-bands',
    buildPayload, toResponse,
  });
  assert.equal(built, 1, 'buildPayload must run when the version changed');
  assert.equal(res.payload.rebuilt, true);
  const version = await getDataVersion(sql, BANDS_TABLES);
  const newKey = blobKeyFor('api-bands', version);
  assert.ok(store.sets.includes(newKey), 'new version Blob should be saved');
  assert.ok(store.sets.includes('api-bands-meta'), 'meta should be saved');
});

test('stale Blob (older than 24h) triggers a rebuild', async () => {
  const sql = makeMockSql();
  let built = 0;
  const buildPayload = async () => { built++; return PAYLOAD; };

  const version = await getDataVersion(sql, BANDS_TABLES);
  const store = makeMockStore();
  store.data[blobKeyFor('api-bands', version)] = PAYLOAD;
  store.data['api-bands-meta'] = { version, builtAt: Date.now() - MAX_BLOB_AGE_MS - 1000 };

  await serveCachedGraph({
    sql, store, tables: BANDS_TABLES, prefix: 'api-bands',
    buildPayload, toResponse,
  });
  assert.equal(built, 1, 'stale copy must be rebuilt');
});

test('Blob read error falls back to Neon and serves fresh data', async () => {
  const sql = makeMockSql();
  let built = 0;
  const buildPayload = async () => { built++; return PAYLOAD; };

  const store = makeMockStore();
  store.failGet = true; // reads throw

  const res = await serveCachedGraph({
    sql, store, tables: BANDS_TABLES, prefix: 'api-bands',
    buildPayload, toResponse,
  });
  assert.equal(built, 1, 'Neon fallback must run the build queries');
  assert.deepEqual(res.payload, PAYLOAD);
});

test('Blob write error still serves the fresh Neon payload', async () => {
  const sql = makeMockSql();
  const buildPayload = async () => PAYLOAD;
  const store = makeMockStore();
  store.failSet = true; // writes throw; reads fine (empty)

  const res = await serveCachedGraph({
    sql, store, tables: BANDS_TABLES, prefix: 'api-bands',
    buildPayload, toResponse,
  });
  assert.deepEqual(res.payload, PAYLOAD, 'response must succeed despite write failure');
});

test('version query failure goes straight to Neon', async () => {
  const badSql = new Proxy(() => {}, {
    apply(_t, _thisArg, args) {
      // sql(table) identifier passthrough must not be a rejected promise;
      // only the template-tag query itself fails.
      if (args.length === 1 && typeof args[0] === 'string') return args[0];
      return Promise.reject(new Error('db down'));
    },
  });
  let built = 0;
  const buildPayload = async () => { built++; return PAYLOAD; };
  const store = makeMockStore();

  const res = await serveCachedGraph({
    sql: badSql, store, tables: BANDS_TABLES, prefix: 'api-bands',
    buildPayload, toResponse,
  });
  assert.equal(built, 1);
  assert.deepEqual(res.payload, PAYLOAD);
  assert.equal(store.gets.length, 0, 'no Blob reads when version query fails');
});
