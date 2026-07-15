// Smoke test the audit-log side of the /api/bands function against a
// deployed URL (Netlify preview or production). Because the audit log lives
// in a real Netlify Blobs store, we cannot exercise it purely locally without
// standing up `netlify dev`; this script hits the real function instead.
//
// Usage:
//   ADMIN_TOKEN=... node scripts/test-audit-log.mjs https://deploy-preview-N--bandmembers.netlify.app
//
// ADMIN_TOKEN is required; there is no baked-in fallback anymore (see PR #46).
// Grab the current value from the Netlify site's env vars.
//
// The script:
//   1. GETs /api/bands?audit=1 without a token -> expects 401
//   2. POSTs a marker submission (unique band name w/ timestamp)
//   3. GETs the audit log with the admin token -> expects 200 and the marker
//      to appear as a submission_accepted event
//   4. DELETEs the marker submission -> expects 200
//   5. Re-fetches the audit log -> expects a submission_deleted event for the
//      same id
//   6. Confirms the marker no longer appears in the public GET /api/bands
//
// Exits nonzero on any failure with a human-readable message.

const BASE = process.argv[2] || 'https://bandmembers.netlify.app';
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
  console.error('ADMIN_TOKEN env var is required. Get it from Netlify site settings > Environment variables and re-run:');
  console.error('  ADMIN_TOKEN=... node scripts/test-audit-log.mjs <BASE_URL>');
  process.exit(2);
}
// The frontend calls the bands function at its Netlify Functions v2 URL,
// not at /api/bands. Keep this in sync with BANDS_ENDPOINT in index.html.
const ENDPOINT = '/.netlify/functions/bands';

function log(step, msg) { console.log(`[${step}] ${msg}`); }
function fail(step, msg) { console.error(`[${step}] FAIL: ${msg}`); process.exit(1); }

async function jget(path, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { headers });
  const body = await r.text();
  let json = null; try { json = JSON.parse(body); } catch {}
  return { status: r.status, body, json };
}

async function jsend(method, path, payload, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: payload == null ? undefined : JSON.stringify(payload)
  });
  const body = await r.text();
  let json = null; try { json = JSON.parse(body); } catch {}
  return { status: r.status, body, json };
}

const stamp = Date.now();
const markerBand = `Audit Log Smoke Test ${stamp}`;

// Step 1: audit endpoint refuses unauthenticated callers
{
  const r = await jget(`${ENDPOINT}?audit=1`);
  if (r.status !== 401) fail('1', `expected 401 without token, got ${r.status}: ${r.body.slice(0, 200)}`);
  log('1', `unauthenticated ${ENDPOINT}?audit=1 correctly rejected (401)`);
}

// Step 2: POST a marker submission
let submissionId = null;
{
  const draft = {
    band: markerBand,
    city: 'Testville',
    state: 'WA',
    country: 'USA',
    genre: 'Test',
    members: [{ member: 'Ada Tester', instrument: 'guitar', relation: 1 }],
    mode: 'new-band-entry'
  };
  const r = await jsend('POST', ENDPOINT, draft);
  if (r.status !== 201) fail('2', `expected 201, got ${r.status}: ${r.body.slice(0, 200)}`);
  submissionId = r.json?.submission?.id;
  if (!submissionId) fail('2', `no submission.id in response body: ${r.body.slice(0, 200)}`);
  log('2', `POSTed marker "${markerBand}" -> id=${submissionId}`);
}

// Step 3: audit log now contains a submission_accepted for that id
{
  const r = await jget(`${ENDPOINT}?audit=1`, { 'x-admin-token': ADMIN });
  if (r.status !== 200) fail('3', `expected 200 with token, got ${r.status}: ${r.body.slice(0, 200)}`);
  const events = r.json?.events || [];
  const hit = events.find(e => e.submissionId === submissionId && e.event === 'submission_accepted');
  if (!hit) fail('3', `no submission_accepted event for id=${submissionId} (log had ${events.length} events)`);
  if (!hit.at) fail('3', `audit entry missing 'at' timestamp: ${JSON.stringify(hit)}`);
  log('3', `audit log contains submission_accepted for id=${submissionId} at ${hit.at}`);
}

// Step 4: DELETE the marker
{
  const r = await jsend('DELETE', `${ENDPOINT}?id=${encodeURIComponent(submissionId)}`, null,
    { 'x-admin-token': ADMIN });
  if (r.status !== 200) fail('4', `expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
  log('4', `DELETEd marker id=${submissionId}`);
}

// Step 5: audit log now also has a submission_deleted for that id
{
  const r = await jget(`${ENDPOINT}?audit=1`, { 'x-admin-token': ADMIN });
  if (r.status !== 200) fail('5', `expected 200 with token, got ${r.status}`);
  const events = r.json?.events || [];
  const hit = events.find(e => e.submissionId === submissionId && e.event === 'submission_deleted');
  if (!hit) fail('5', `no submission_deleted event for id=${submissionId}`);
  log('5', `audit log contains submission_deleted for id=${submissionId} at ${hit.at}`);
}

// Step 6: public bands endpoint no longer contains the marker
{
  const r = await jget(ENDPOINT);
  if (r.status !== 200) fail('6', `expected 200, got ${r.status}`);
  const subs = r.json?.submissions || [];
  const lingering = subs.find(s => s.id === submissionId);
  if (lingering) fail('6', `marker still present in public submissions after DELETE`);
  log('6', `public ${ENDPOINT} no longer contains id=${submissionId} (${subs.length} submissions total)`);
}

console.log('\nAll audit-log smoke tests passed.');
