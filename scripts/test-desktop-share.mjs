// Smoke test: on desktop, clicking the Facebook share button should
// NOT open a facebook.com/sharer popup, and SHOULD trigger a download
// of the graph PNG. Same for X and Reddit.
import pw from 'playwright';
import fs from 'node:fs';

const PREVIEW_URL = process.argv[2] || 'http://localhost:8765/';
const platforms = ['facebook', 'x', 'reddit'];

const b = await pw.chromium.launch({ headless: true });
const c = await b.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
  acceptDownloads: true,
});
const p = await c.newPage();

// Track any popup windows — with the new flow, none should open.
const popups = [];
c.on('page', (page) => popups.push(page.url()));

await p.goto(PREVIEW_URL);
await p.evaluate(() => sessionStorage.setItem('rbft-unlocked', 'yes'));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(8000);

// Open the share popover once.
await p.evaluate(() => document.getElementById('share-graph-btn').click());
await p.waitForTimeout(300);

let allPassed = true;
for (const platform of platforms) {
  const downloadPromise = p.waitForEvent('download', { timeout: 15000 });
  await p.evaluate((plat) => {
    document.getElementById(`share-${plat}-btn`).click();
  }, platform);
  try {
    const dl = await downloadPromise;
    const filename = dl.suggestedFilename();
    const savePath = `/tmp/share-${platform}.png`;
    await dl.saveAs(savePath);
    const bytes = fs.statSync(savePath).size;
    console.log(`${platform}: download=${filename}  ${(bytes/1024/1024).toFixed(2)}MB  ✓`);
  } catch (err) {
    console.log(`${platform}: NO DOWNLOAD (${err.message})  ✗`);
    allPassed = false;
  }
  await p.waitForTimeout(500);
  // Re-open popover in case it was auto-closed
  const isOpen = await p.evaluate(() => !document.getElementById('share-popover').hidden);
  if (!isOpen) {
    await p.evaluate(() => document.getElementById('share-graph-btn').click());
    await p.waitForTimeout(200);
  }
}

// Read feedback right after the last click (before popover reopen)
// by triggering one more click and immediately reading.
await p.evaluate(() => {
  if (document.getElementById('share-popover').hidden) {
    document.getElementById('share-graph-btn').click();
  }
});
await p.waitForTimeout(200);
const dl2 = p.waitForEvent('download', { timeout: 15000 });
await p.evaluate(() => document.getElementById('share-facebook-btn').click());
await dl2;
await p.waitForTimeout(500);
const feedback = await p.evaluate(() => document.getElementById('share-popover-feedback').textContent.trim());
console.log(`\nFinal feedback after FB click: "${feedback}"`);

if (popups.length > 0) {
  console.log(`\n✗ FAIL: ${popups.length} popup windows were opened:`);
  popups.forEach(u => console.log(`  - ${u}`));
  allPassed = false;
} else {
  console.log(`\n✓ No popup windows opened (correct)`);
}

await b.close();
process.exit(allPassed ? 0 : 1);
