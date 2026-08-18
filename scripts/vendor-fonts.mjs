// Downloads the two typefaces this site uses and writes a local @font-face sheet,
// so the page depends on this origin and nothing else.
//
// Licensing (ITF Free Font License v2.0, checked 2026-08-18): self-hosting is
// expressly permitted -- "You may self-host the Font Software on your own servers
// or infrastructure for use on your own websites and applications, including
// through standard webfont technologies such as CSS @font-face", and "Use of the
// Fontshare API is optional and is not required for web use". Commercial use is
// free. https://www.fontshare.com/licenses/itf-ffl
//
// The same license PROHIBITS subsetting and format conversion. So this script
// downloads the exact .woff2 files Fontshare's own CDN serves and stores them
// byte-for-byte. It deliberately does NOT take the OTF download and convert it,
// which would be a prohibited format conversion, and it does not subset.
//
// It also works around a Fontshare API quirk that was a live bug on this site:
// requesting `f[]=satoshi...&f[]=boska...` returns Satoshi plus FOUR faces of
// Outfit and NO Boska, so --font-display: 'Boska', Georgia, serif had been
// silently rendering as Georgia. Asking for each family in its own request avoids
// depending on that ordering at all.
import { mkdirSync, writeFileSync } from 'node:fs';

const FAMILIES = [
  { handle: 'boska', family: 'Boska', weights: [400, 500, 700] },
  { handle: 'satoshi', family: 'Satoshi', weights: [400, 500, 700] },
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

mkdirSync('vendor/fonts', { recursive: true });
const rules = [];

for (const { handle, family, weights } of FAMILIES) {
  const url = `https://api.fontshare.com/v2/css?f%5B%5D=${handle}@${weights.join(',')}&display=swap`;
  const css = await fetch(url, { headers: { 'user-agent': UA } }).then(r => r.text());

  for (const weight of weights) {
    // Match this family + weight in the returned sheet rather than trusting order.
    const face = css.split('@font-face').find(
      block => block.includes(`'${family}'`) && new RegExp(`font-weight:\\s*${weight}\\b`).test(block)
    );
    if (!face) throw new Error(`${family} ${weight} missing from the Fontshare response`);
    const href = face.match(/url\('([^']+\.woff2)'\)/);
    if (!href) throw new Error(`${family} ${weight} has no woff2 url`);

    const fileUrl = href[1].startsWith('//') ? `https:${href[1]}` : href[1];
    const name = `${family.toLowerCase()}-${weight}.woff2`;
    const bytes = Buffer.from(await fetch(fileUrl, { headers: { 'user-agent': UA } }).then(r => r.arrayBuffer()));
    if (bytes.length < 1000) throw new Error(`${name} came back suspiciously small (${bytes.length}B)`);
    writeFileSync(`vendor/fonts/${name}`, bytes);
    console.log(`  ${name.padEnd(20)} ${String(bytes.length).padStart(7)} B`);

    rules.push(
      `@font-face {\n` +
      `  font-family: '${family}';\n` +
      `  src: url('/vendor/fonts/${name}') format('woff2');\n` +
      `  font-weight: ${weight};\n` +
      `  font-style: normal;\n` +
      `  font-display: swap;\n` +
      `}`
    );
  }
}

writeFileSync('vendor/fonts.css',
  `/* Vendored by scripts/vendor-fonts.mjs -- do not edit. Rebuild: npm run vendor:fonts\n` +
  `   Satoshi and Boska, Indian Type Foundry, ITF Free Font License v2.0.\n` +
  `   Self-hosting is expressly permitted; the .woff2 files are stored exactly as\n` +
  `   Fontshare serves them, because the same license prohibits subsetting and\n` +
  `   format conversion. https://www.fontshare.com/licenses/itf-ffl */\n\n` +
  rules.join('\n\n') + '\n');
console.log(`\nvendor/fonts.css written with ${rules.length} faces`);
