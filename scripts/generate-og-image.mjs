// One-shot generator for the site's Open Graph preview image
// (og-image.png, 1200x630). Committed to the repo so it's served as a
// static file and referenced from <meta property="og:image">.
//
// We use Playwright + Chromium (already a dev dep for the smoke tests)
// to render a small HTML card into a PNG. This keeps the design in
// version-controllable HTML/CSS rather than baked into a canvas script.
//
// Why not just link to rbft_logo_3.png?
//   - The bare logo is 1602x426, wider than tall. Facebook and other
//     unfurlers crop to 1.91:1, which chops the logo down the middle
//     to "BF" \u2014 exactly the ugly preview the user reported.
//   - A purpose-built 1200x630 card centered on the full logo + tagline
//     survives every unfurler's crop.
import pw from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.resolve('og-image.png');

// Inline the logo as a data URL so the render works without a running
// dev server. rbft_logo_3.png is committed at the repo root; the file
// name uses lowercase 'rbft' matching the on-page reference.
const logoPath = path.resolve('RBFT_logo_3.png');
if (!fs.existsSync(logoPath)) {
  console.error(`Missing logo at ${logoPath} \u2014 aborting.`);
  process.exit(1);
}
const logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #0b1118; }
  body {
    width: 1200px; height: 630px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    color: #e6eef7;
    background:
      radial-gradient(circle at 50% 30%, rgba(143,232,246,0.10), transparent 50%),
      radial-gradient(circle at 20% 80%, rgba(108,146,176,0.14), transparent 55%),
      linear-gradient(180deg, #111b26 0%, #0b1118 60%);
  }
  .logo {
    width: 640px; max-width: 60vw; height: auto;
    filter: drop-shadow(0 20px 40px rgba(0,0,0,0.4)) invert(1);
    margin-bottom: 36px;
  }
  .title {
    font-size: 46px; font-weight: 700; letter-spacing: -0.5px;
    margin: 0 0 12px 0; text-align: center;
  }
  .tagline {
    font-size: 24px; font-weight: 500; color: #a3b3c6;
    text-align: center; max-width: 900px; line-height: 1.35;
  }
  .footer {
    position: absolute; bottom: 32px; left: 0; right: 0;
    text-align: center; font-size: 18px; color: #6f7889;
    letter-spacing: 0.5px;
  }
</style></head><body>
  <img class="logo" src="${logoDataUrl}" alt="Six Degrees of Rock" />
  <div class="title">Six Degrees of Rock</div>
  <div class="tagline">Explore how bands and musicians connect across scenes and decades.</div>
  <div class="footer">bandmembers.netlify.app</div>
</body></html>`;

const b = await pw.chromium.launch({ headless: true });
const c = await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const p = await c.newPage();
await p.setContent(html, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => new Promise(r => {
  const img = document.querySelector('img.logo');
  if (img.complete) return r();
  img.onload = () => r();
  img.onerror = () => r();
}));
await p.waitForTimeout(200);
await p.screenshot({ path: OUT, fullPage: false, omitBackground: false });
await b.close();
const stat = fs.statSync(OUT);
console.log(`Wrote ${OUT}  size=${(stat.size/1024).toFixed(1)}KB`);
