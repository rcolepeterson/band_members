// POST /api/admin-cleanup-pr4a-artifacts — one-shot admin cleanup.
//
// PR 4a's live end-to-end verification created a test user and a real
// verifications row on Nirvana (the row is legitimate data, but it was
// produced by a bot-owned test session and we don't want the "verified by"
// history to point at a synthetic user). This endpoint removes:
//   - users with email ending in '@bandmembers.invalid' (safe -- these are
//     always throwaway test rows; the real user has a real email)
//   - verification rows whose surviving user cascade would leave them
//     orphaned (the schema doesn't have a FK from verifications to users
//     but the earliest one was written by the test user in this session).
//
// Same guardrails as PR #54's cleanup endpoint:
//   - dry_run mode
//   - contribution rows cascade with the user (users.on delete cascade)
//   - verification rows are matched by a specific band_id list, not a wide
//     "delete all verifications" -- because verifications are real data
//     and we only want to nuke the one we produced in the smoke test
//
// This file is one-shot. Delete it in a follow-up commit after use.

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
// Nirvana's band_id in prod; the only verification row PR 4a's smoke test
// caused to be written. Hardcoded so this endpoint cannot be used to wipe
// arbitrary verifications.
const VERIFICATION_BAND_IDS_TO_CLEAR = [
  '71b8f957-5538-4e1c-98c1-3fcb8a576075',
];

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
    // 1. Identify test users
    const testUsers = await sql`
      select id, email, name, created_at
      from users
      where email like ${'%' + TEST_EMAIL_SUFFIX}
    `;
    report.steps.push({ step: 'users_identified', count: testUsers.length, rows: testUsers });

    // 2. Identify verification rows we plan to clear (there should be 1)
    const verifs = await sql`
      select id, band_id, verified_at, overall_score
      from verifications
      where band_id = any(${VERIFICATION_BAND_IDS_TO_CLEAR})
    `;
    report.steps.push({ step: 'verifications_identified', count: verifs.length, rows: verifs });

    // 3. Preview cascaded contributions from user deletes
    if (testUsers.length > 0) {
      const userIds = testUsers.map(u => u.id);
      const contribs = await sql`
        select count(*)::int as count
        from contributions
        where user_id = any(${userIds})
      `;
      report.steps.push({ step: 'contributions_will_cascade', count: contribs[0].count });
    }

    if (dryRun) {
      report.note = 'DRY RUN: no rows were deleted. Re-run without { dry_run: true } to actually delete.';
      return ok(report);
    }

    // 4. Delete
    const deletedVerifs = verifs.length > 0
      ? await sql`
          delete from verifications
          where band_id = any(${VERIFICATION_BAND_IDS_TO_CLEAR})
          returning id, band_id
        `
      : [];
    report.steps.push({ step: 'verifications_deleted', count: deletedVerifs.length, rows: deletedVerifs });

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
    console.error('admin_cleanup_pr4a_artifacts failed', error);
    return serverError(String(error && error.message ? error.message : error));
  }
};

export const config = { path: '/api/admin-cleanup-pr4a-artifacts', method: 'POST' };
