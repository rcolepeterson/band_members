// POST /api/admin-cleanup-test-artifacts — admin-only one-off cleanup.
//
// Purpose: delete rows that end-to-end verification runs (PR #50, #52, #53)
// left behind in the production Neon database. Every prod verification we
// run creates a real user + real band submission because the write path is
// the thing under test; those rows should not be part of the real dataset.
//
// This endpoint is deliberately NOT a generic "delete band" or "delete user"
// endpoint. It targets rows by a very narrow whitelist so it cannot be
// used to delete production data even if the admin token leaks.
//
// Deletion whitelist (compiled from prior test runs):
//   - user emails ending with '@bandmembers.invalid'
//   - members whose name starts with 'PR3b '
//   - bands whose name is exactly 'PR 3b Test Band'
//
// Deletion cascades:
//   - deleting a user cascades to contributions (users.on delete cascade)
//   - deleting a band cascades to memberships (memberships.on delete cascade)
//   - deleting a band_member cascades to memberships (memberships.on delete cascade)
//
// Safety rails:
//   - dry-run mode via { dry_run: true } lists what WOULD be deleted without
//     mutating anything. Always run once with dry_run before the real call.
//   - a member is only deleted if it has ZERO remaining memberships after
//     the band deletes (never deletes members shared with real bands, even
//     if the name happens to match the PR3b prefix — belt-and-suspenders).
//   - each delete step returns the affected row count so the caller can
//     verify the numbers match expectations.
//
// After this endpoint has been used, delete the file — it's a one-shot
// tool, not a permanent part of the API surface. Track that in the PR.

import {
  getSql,
  isDbConfigured,
  ok,
  unauthorized,
  dbUnavailable,
  serverError,
  methodNotAllowed,
} from './_db.mjs';

const ADMIN_TOKEN_HEADER = 'x-admin-token';

function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers?.get?.(ADMIN_TOKEN_HEADER) || '';
  return provided === expected;
}

const TEST_EMAIL_SUFFIX = '@bandmembers.invalid';
const TEST_MEMBER_PREFIX = 'PR3b ';
const TEST_BAND_NAMES = ['PR 3b Test Band'];

export default async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isAdminAuthorized(req)) return unauthorized();
  if (!isDbConfigured()) return dbUnavailable();

  let dryRun = false;
  try {
    const body = await req.json();
    dryRun = body && body.dry_run === true;
  } catch {
    // no body is fine -- treat as non-dry-run
  }

  const sql = getSql();
  const report = { dry_run: dryRun, steps: [] };

  try {
    // 1. Identify test users. We match on email suffix, not id, because the
    //    test user rows we've created span multiple past sessions.
    const testUsers = await sql`
      select id, email, name, created_at
      from users
      where email like ${'%' + TEST_EMAIL_SUFFIX}
    `;
    report.steps.push({ step: 'users_identified', count: testUsers.length, rows: testUsers });

    // 2. Identify test bands.
    const testBands = await sql`
      select id, name, city, state, country
      from bands
      where name = any(${TEST_BAND_NAMES})
    `;
    report.steps.push({ step: 'bands_identified', count: testBands.length, rows: testBands });

    // 3. Identify test members. We further filter to only members with ZERO
    //    memberships that would remain after the band deletes -- so a member
    //    that happens to be linked to a real band is left alone.
    const testMembers = await sql`
      select bm.id, bm.name
      from band_members bm
      where bm.name like ${TEST_MEMBER_PREFIX + '%'}
    `;

    const testBandIds = new Set(testBands.map(b => b.id));
    const safeMembersToDelete = [];
    for (const member of testMembers) {
      const remainingMemberships = await sql`
        select id, band_id
        from memberships
        where member_id = ${member.id}
      `;
      const willRemainAfterBandDelete = remainingMemberships.filter(
        m => !testBandIds.has(m.band_id)
      );
      if (willRemainAfterBandDelete.length === 0) {
        safeMembersToDelete.push({
          id: member.id,
          name: member.name,
          current_memberships: remainingMemberships.length,
          all_in_test_bands: true,
        });
      } else {
        // Skip -- member is linked to a real band. Never delete.
        safeMembersToDelete.push({
          id: member.id,
          name: member.name,
          current_memberships: remainingMemberships.length,
          all_in_test_bands: false,
          skipped: true,
        });
      }
    }
    report.steps.push({ step: 'members_identified', count: testMembers.length, rows: safeMembersToDelete });

    // Contributions preview (would-be cascaded from users)
    if (testUsers.length > 0) {
      const testUserIds = testUsers.map(u => u.id);
      const contribs = await sql`
        select count(*)::int as count
        from contributions
        where user_id = any(${testUserIds})
      `;
      report.steps.push({ step: 'contributions_will_cascade', count: contribs[0].count });
    }

    if (dryRun) {
      report.note = 'DRY RUN: no rows were deleted. Re-run without { dry_run: true } to actually delete.';
      return ok(report);
    }

    // 4. Actually delete. Order matters even with cascades because we want
    //    the counts back.
    const deletedBands = testBands.length > 0
      ? await sql`
          delete from bands
          where id = any(${testBands.map(b => b.id)})
          returning id, name
        `
      : [];
    report.steps.push({ step: 'bands_deleted', count: deletedBands.length, rows: deletedBands });

    const membersToDelete = safeMembersToDelete.filter(m => !m.skipped).map(m => m.id);
    const deletedMembers = membersToDelete.length > 0
      ? await sql`
          delete from band_members
          where id = any(${membersToDelete})
          returning id, name
        `
      : [];
    report.steps.push({ step: 'members_deleted', count: deletedMembers.length, rows: deletedMembers });

    const deletedUsers = testUsers.length > 0
      ? await sql`
          delete from users
          where id = any(${testUsers.map(u => u.id)})
          returning id, email
        `
      : [];
    report.steps.push({ step: 'users_deleted', count: deletedUsers.length, rows: deletedUsers });

    return ok(report);
  } catch (error) {
    console.error('admin_cleanup_test_artifacts failed', error);
    return serverError(String(error && error.message ? error.message : error));
  }
};

export const config = { path: '/api/admin-cleanup-test-artifacts', method: 'POST' };
