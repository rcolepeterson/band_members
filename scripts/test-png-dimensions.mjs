// Smoke test: measure the PNG dimensions produced by the current
// build on both mobile (iPhone 13) and desktop viewports. We trigger
// the desktop download path (exportCurrentGraphPng) via the button
// and intercept the resulting Blob URL.
import pw from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

async function measurePng(deviceName, viewport, label) {
  const b = await pw.chromium.launch({ headless: true });
  const opts = deviceName
    ? { ...pw.devices[deviceName], permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true }
    : { viewport, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true };
  const c = await b.newContext(opts);
  const p = await c.newPage();
  await p.goto('http://localhost:8765/');
  await p.evaluate(() => sessionStorage.setItem('rbft-unlocked', 'yes'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(8000);

  const svgSize = await p.evaluate(() => {
    const svg = document.getElementById('graph-svg');
    const r = svg.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });

  // Trigger the download by calling exportCurrentGraphPng directly via
  // the desktop Share PNG button. First open the share popover.
  // Instead, invoke via a devtools eval hook: call the click handler
  // for #share-download.
  const downloadPromise = p.waitForEvent('download', { timeout: 30000 });
  // Open the share popover (desktop) then click Download PNG. On mobile
  // the share popover is also present but the Share button in the
  // hamburger sheet takes a different path; we directly open the
  // popover here.
  await p.evaluate(() => {
    const sg = document.getElementById('share-graph-btn');
    if (sg) sg.click();
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const dl = document.getElementById('download-png-btn');
    if (dl) dl.click();
  });

  const dl = await downloadPromise;
  const savePath = path.resolve(`/tmp/test-png-${label}.png`);
  await dl.saveAs(savePath);
  await b.close();

  // Read PNG dimensions from the header.
  const buf = fs.readFileSync(savePath);
  // PNG width is bytes 16-19, height 20-23, big-endian.
  const pngWidth = buf.readUInt32BE(16);
  const pngHeight = buf.readUInt32BE(20);
  return {
    svgCssWidth: svgSize.w,
    svgCssHeight: svgSize.h,
    pngWidth,
    pngHeight,
    blobBytes: buf.length,
    path: savePath,
  };
}

function checkAspect(label, r) {
  const scale = Math.max(2, 1200 / r.svgCssWidth);
  const expectedHeaderH = Math.round(60 * scale);
  const expectedFooterH = Math.round(36 * scale);
  const graphH = r.pngHeight - expectedHeaderH - expectedFooterH;
  const graphW = r.pngWidth;
  const svgAspect = r.svgCssWidth / r.svgCssHeight;
  const pngGraphAspect = graphW / graphH;
  const drift = Math.abs(svgAspect - pngGraphAspect) / svgAspect;
  console.log(`\n${label}:`);
  console.log(`  SVG css:   ${r.svgCssWidth.toFixed(0)} x ${r.svgCssHeight.toFixed(0)}   aspect=${svgAspect.toFixed(3)}`);
  console.log(`  PNG:       ${r.pngWidth} x ${r.pngHeight}   scale=${scale.toFixed(3)}`);
  console.log(`  Graph:     ${graphW} x ${graphH}   aspect=${pngGraphAspect.toFixed(3)}   drift=${(drift * 100).toFixed(2)}%`);
  console.log(`  Header:    ${expectedHeaderH}px (${(expectedHeaderH / r.pngHeight * 100).toFixed(1)}% of total)`);
  console.log(`  Footer:    ${expectedFooterH}px (${(expectedFooterH / r.pngHeight * 100).toFixed(1)}% of total)`);
  console.log(`  File:      ${(r.blobBytes / 1024 / 1024).toFixed(2)} MB at ${r.path}`);
  if (drift > 0.02) console.log(`  ⚠️  aspect drift > 2%`);
  else console.log(`  ✓ aspect preserved`);
}

console.log('Testing mobile (iPhone 13)...');
const mobile = await measurePng('iPhone 13', null, 'mobile');
checkAspect('mobile', mobile);

console.log('\nTesting desktop (1440x900)...');
const desktop = await measurePng(null, { width: 1440, height: 900 }, 'desktop');
checkAspect('desktop', desktop);
