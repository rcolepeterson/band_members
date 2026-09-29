// Tests for the band hard-delete endpoint (netlify/functions/bands_delete.mjs).
//
// Strategy: `canDeleteBand` is pure and tested directly; `deleteBandById`
// takes an explicit `sql` argument (same technique as runBatch in
// cron-verify-stale-bands.test.mjs), so tests pass a hand-written fake `sql`
// tagged-template function — no real Postgres, no Neon HTTP mocking. The
// HTTP wrapper's method guard and admin-token auth are tested through the
// default export without a DB.

import test from 'node:test';
import assert from 'node:assert/strict';

import deleteBand, { canDeleteBand, deleteBandById } from '../netlify/functions/bands_delete.mjs';

const BAND_ID = '9dcd9cd0-a34b-4304-ba75-cd38139c5e30'; // the Sep-2026 Sweet Water dup

function req(method, headers = {}) {
  return new Request(`https://example.test/api/bands/${BAND_ID}`, {
    method,
    headers: new Headers(headers),
  });
}

function withAdminToken(token, fn) {
  return async () => {
    const before = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = token;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  };
}

// Fake `sql`: the band-select returns the configured band row (or nothing
// when bandRow is null), the memberships count returns the configured
// count, and sql.transaction maps each queued query to a { count } result.
function makeFakeSql({ bandRow, memberCount = 0 } = {}) {
  const calls = [];
  const row = bandRow === undefined
    ? { id: BAND_ID, name: 'Sweet Water', city: null, state: null, country: null }
    : bandRow;
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('from bands where id')) {
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes('from memberships')) {
      return Promise.resolve([{ n: memberCount }]);
    }
    return Promise.resolve([{ count: 0 }]);
  };
  sql.calls = calls;
  sql.transaction = (queries) => Promise.resolve(queries.map(() => ({ count: 0 })));
  return sql;
}

test('canDeleteBand: an empty band (the Sweet Water dup) is deletable', () => {
  assert.deepEqual(canDeleteBand({ memberCount: 0 }), { ok: true });
});

test('canDeleteBand: any membership blocks deletion', () => {
  for (const n of [1, 2, 40]) {
    const guard = canDeleteBand({ memberCount: n });
    assert.equal(guard.ok, false);
    assert.match(guard.reason, /member/i);
  }
});

test('canDeleteBand: a missing band is not deletable', () => {
  const guard = canDeleteBand({ memberCount: 0, exists: false });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /not found/i);
});

test('deleteBandById: deletes the empty duplicate and reports row counts', async () => {
  const sql = makeFakeSql({ memberCount: 0 });
  const result = await deleteBandById(sql, BAND_ID);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.deleted_band_id, BAND_ID);
  assert.equal(result.body.deleted_band_name, 'Sweet Water');
  // Five deletes in one transaction: 4 dependents + the band row itself.
  assert.equal(sql.calls.filter((c) => c.text.includes('delete from')).length, 5);
  assert.ok(sql.calls.some((c) => c.text.includes('delete from band_links')));
  assert.ok(sql.calls.some((c) => c.text.includes('delete from bands where id')));
});

test('deleteBandById: a missing band returns 404 without deleting anything', async () => {
  const sql = makeFakeSql({ bandRow: null });
  const result = await deleteBandById(sql, BAND_ID);
  assert.equal(result.status, 404);
  assert.equal(result.body.ok, false);
  assert.equal(sql.calls.filter((c) => c.text.includes('delete from')).length, 0);
});

test('deleteBandById: a band with members returns 409 and deletes nothing', async () => {
  const sql = makeFakeSql({ memberCount: 3 });
  const result = await deleteBandById(sql, BAND_ID);
  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error_code, 'band_has_members');
  assert.equal(sql.calls.filter((c) => c.text.includes('delete from')).length, 0);
});

test('DELETE with the wrong method is rejected before auth', async () => {
  const res = await deleteBand(req('GET'));
  assert.equal(res.status, 405);
});

test('DELETE without the admin token is rejected before touching the DB', async () => {
  const res = await deleteBand(req('DELETE'));
  assert.equal(res.status, 401);
});

test('DELETE with a wrong admin token is rejected', withAdminToken('correct-token', async () => {
  const res = await deleteBand(req('DELETE', { 'x-admin-token': 'wrong-token' }));
  assert.equal(res.status, 401);
}));
