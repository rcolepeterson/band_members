// Bundles the browser libraries into vendor/ so the page depends on this origin
// and nothing else.
//
// Before this, index.html reached out to two third parties on every cold load:
// a render-blocking <script> from d3js.org with no integrity attribute, and an
// import map pointing at esm.sh, which took 15 requests to assemble Sigma and
// resolved graphology-utils@^2.5.2 -- a CARET RANGE -- at request time. That last
// one meant production JavaScript could change without a commit.
//
// Blocking d3js.org left the page with no graph at all, so those hosts were not a
// nicety; they were a hard dependency on somebody else's uptime, invisible to us
// because our own network reaches them fine.
//
// Versions come from package.json. Note that package-lock.json is gitignored in
// this repo, so the lockfile is NOT the record of what ships -- the committed files
// in vendor/ are. That is the stronger guarantee of the two: the exact bytes the
// browser runs are in version control and change only in a reviewable diff, which
// was not true of a caret range resolved by a CDN at request time.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

mkdirSync('vendor', { recursive: true });

const version = name =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;

const banner = list =>
  `/* Vendored by scripts/vendor-libs.mjs -- do not edit.\n   ${list.map(n => `${n}@${version(n)}`).join('\n   ')}\n   Rebuild with: npm run vendor */\n`;

// graphology stands alone.
await build({
  entryPoints: ['node_modules/graphology/dist/graphology.esm.js'],
  outfile: 'vendor/graphology.mjs',
  bundle: true, format: 'esm', platform: 'browser', minify: true,
  banner: { js: banner(['graphology']) },
});

// Sigma, with graphology left external so the two do not each ship a copy. The
// bare specifier is rewritten to the vendored path, which keeps the import map
// honest and means no bare specifier survives into the browser.
await build({
  entryPoints: ['node_modules/sigma/dist/sigma.esm.js'],
  outfile: 'vendor/sigma.mjs',
  bundle: true, format: 'esm', platform: 'browser', minify: true,
  external: ['graphology'],
  banner: { js: banner(['sigma', 'graphology-utils']) },
});

// d3 is loaded lazily at runtime (see ensureD3 in index.html), as a classic script
// rather than a module, because that is what the existing code expects on window.
await build({
  entryPoints: ['node_modules/d3/src/index.js'],
  outfile: 'vendor/d3.js',
  bundle: true, format: 'iife', globalName: 'd3', platform: 'browser', minify: true,
  banner: { js: banner(['d3']) },
});

const rewritten = readFileSync('vendor/sigma.mjs', 'utf8')
  .replace(/from"graphology"/g, 'from"/vendor/graphology.mjs"')
  .replace(/from "graphology"/g, 'from "/vendor/graphology.mjs"');
writeFileSync('vendor/sigma.mjs', rewritten);
console.log('vendored:', ['graphology','sigma','graphology-utils','d3'].map(n => `${n}@${version(n)}`).join('  '));
