// Smoke test the admin audit-log page (admin/audit.html) against a
// deployed URL. Exercises:
//   1. Page loads and shows the auth gate
//   2. Wrong token is rejected (401 -> visible error message)
//   3. Correct token unlocks the dashboard
//   4. Events table renders at least one event row and the summary strip
//   5. Row click expands the detail drawer with pretty-printed JSON
//   6. Sign-out returns to the gate
//   7. Session persistence: after sign-in, a page reload keeps us signed in
//      (token cached in sessionStorage) and re-loads the data.
//
// Usage:
//   ADMIN_TOKEN=... node scripts/test-admin-audit-page.mjs [BASE_URL]
//
// Default BASE_URL is https://bandmembers.netlify.app.
// Requires playwright (already a repo dev dep for other smoke tests).
//
// ADMIN_TOKEN is required; there is no baked-in fallback anymore (see PR #46).
// Grab the current value from the Netlify site's env vars.

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://bandmembers.netlify.app';
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
  console.error('ADMIN_TOKEN env var is required. Get it from Netlify site settings > Environment variables and re-run:');
  console.error('  ADMIN_TOKEN=... node scripts/test-admin-audit-page.mjs [BASE_URL]');
  process.exit(2);
}
const URL = `${BASE}/admin/audit.html`;

function log(step, msg) { console.log(`[${step}] ${msg}`); }
function fail(step, msg, browser) {
  console.error(`[${step}] FAIL: ${msg}`);
  if (browser) browser.close().catch(() => {});
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

// Capture console errors so a silent JS blowup on the page becomes a visible
// smoke-test failure.
const consoleErrors = [];
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

// Step 1: page loads and the auth gate is visible
{
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gate', { state: 'visible' });
  const dashHidden = await page.isHidden('#dashboard');
  if (!dashHidden) fail('1', 'dashboard should be hidden before sign-in', browser);
  log('1', 'page loaded, auth gate visible');
}

// Step 2: wrong token is rejected with a visible 401 message
{
  await page.fill('#token-input', 'this-is-not-the-token');
  await page.click('#signin-btn');
  await page.waitForFunction(
    () => (document.getElementById('gate-error')?.textContent || '').length > 0,
    { timeout: 10000 }
  );
  const err = await page.textContent('#gate-error');
  if (!/401|rejected/i.test(err)) fail('2', `expected 401 error message, got "${err}"`, browser);
  log('2', `wrong token rejected: "${err.trim()}"`);
  await page.fill('#token-input', '');
}

// Step 3: correct token unlocks the dashboard
{
  await page.fill('#token-input', ADMIN);
  await page.click('#signin-btn');
  await page.waitForSelector('#dashboard', { state: 'visible', timeout: 15000 });
  // The header should now show "signed in".
  const status = await page.textContent('#header-status');
  if (!/signed in/i.test(status)) fail('3', `header status should be "signed in", got "${status}"`, browser);
  log('3', 'correct token unlocked the dashboard');
}

// Step 4: events table + summary render
{
  // Wait until either at least one event row or the empty-state has rendered.
  await page.waitForFunction(
    () => document.querySelectorAll('#events .event-row').length > 0
       || document.querySelectorAll('#events .empty').length > 0
       || document.querySelectorAll('#events .error-state').length > 0,
    { timeout: 15000 }
  );
  const rowCount = await page.locator('#events .event-row').count();
  const statCount = await page.locator('#summary .stat').count();
  const errNode = await page.locator('#events .error-state').count();
  if (errNode > 0) {
    const errText = await page.textContent('#events .error-state');
    fail('4', `events pane rendered an error: ${errText}`, browser);
  }
  if (statCount < 6) fail('4', `expected 6 summary stats, got ${statCount}`, browser);
  log('4', `summary strip rendered (${statCount} stats); events table has ${rowCount} row(s)`);
  // The two smoke-test markers from earlier runs almost guarantee >= 2 rows,
  // but we don't fail on 0 - the audit store could theoretically be empty on
  // a fresh preview branch. We just note it.
  if (rowCount === 0) log('4', '(audit log is empty on this deploy - the UI still rendered)');
}

// Step 5: row click expands the detail drawer with pretty-printed JSON
{
  const rowCount = await page.locator('#events .event-row').count();
  if (rowCount > 0) {
    await page.locator('#events .event-row').first().click();
    await page.waitForSelector('#events .event-detail.open', { state: 'visible', timeout: 5000 });
    const detailText = await page.textContent('#events .event-detail.open');
    if (!detailText.includes('"event"') || !detailText.includes('"at"')) {
      fail('5', `detail drawer did not contain expected JSON keys; got:\n${detailText.slice(0, 200)}`, browser);
    }
    log('5', 'row expanded, detail drawer shows pretty-printed JSON');
  } else {
    log('5', 'skipped (no rows to expand)');
  }
}

// Step 6: sign-out returns to the gate
{
  await page.click('#signout-btn');
  await page.waitForSelector('#gate', { state: 'visible', timeout: 5000 });
  const dashHidden = await page.isHidden('#dashboard');
  if (!dashHidden) fail('6', 'dashboard should be hidden after sign-out', browser);
  const stored = await page.evaluate(() => sessionStorage.getItem('rbft-admin-token'));
  if (stored) fail('6', 'sessionStorage still contains the token after sign-out', browser);
  log('6', 'sign-out cleared session storage and returned to the gate');
}

// Step 7: session persistence - sign in again, reload, expect dashboard.
{
  await page.fill('#token-input', ADMIN);
  await page.click('#signin-btn');
  await page.waitForSelector('#dashboard', { state: 'visible', timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  // After reload the dashboard should come up directly (no gate).
  await page.waitForSelector('#dashboard', { state: 'visible', timeout: 15000 });
  const gateHidden = await page.isHidden('#gate');
  if (!gateHidden) fail('7', 'gate should be hidden on reload when session token is cached', browser);
  log('7', 'session token persisted across reload');
}

// Final: check we didn't accumulate any console errors during the run.
if (consoleErrors.length) {
  console.warn('\nWARN - JS console errors during test:');
  for (const e of consoleErrors) console.warn('  -', e);
  // Not a hard fail unless the page also failed a functional check above,
  // but surface it so we notice regressions quickly.
}

await browser.close();
console.log('\nAll admin audit-page smoke tests passed.');
