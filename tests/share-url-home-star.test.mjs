// A shared link must not name the home star unless the sharer asked for it.
//
// PR #112 fixed syncAddressBar() so a plain visit to / stops rewriting itself to
// /?anchor=Aaron%20McRae. It fixed the address bar only. The URL people actually
// pass around comes from the Share popover, and that path was untouched:
// shareableUrl() wrote state.anchorId unconditionally, so every flow through it
// -- Copy link, Facebook, X, Reddit, Email, Download PNG, the mobile bypass --
// shared the front door as a deep link to one musician.
//
// The rule it now follows: an anchor belongs in a link when the visitor chose
// that node -- by arriving on a link that named it, or by travelling to it. The
// home star on a visit that never asked for it is not a choice, and dropping it
// costs the recipient nothing, since with no anchor they open on the home star
// anyway.
//
// Note what is deliberately NOT the fix. copySiteLink()'s comment claimed it was
// "always the bare main-site URL", and an early attempt took that at its word and
// pointed it at the root. That killed the only way to share a view by hand: a
// visitor who explores to Mudhoney and hits Copy link has to be able to send
// Mudhoney. So Copy link keeps carrying the view, the stale comment is corrected
// rather than implemented, and the whole rule lives in one place -- inside
// shareableUrl() -- where every share path picks it up at once.
//
// index.html is a single 500KB document with no build step, so these functions
// cannot be imported. Their bodies are extracted and evaluated against stub
// window/RBFT_SIGMA objects -- the same technique tests/clean-root-url.test.mjs
// uses on scripts/sigma-explorer.mjs, and it exercises the real branching.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// Pull `function <name>(...) { ... }` out of index.html by brace matching.
function extractFunction(name) {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.ok(start > 0, `Expected function ${name}() in index.html.`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (depth === 0) return INDEX.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}().`);
}

const SHAREABLE_PARAMS_DECL = "const SHAREABLE_PARAMS = ['anchor', 'band', 'member', 'node', 'person'];";
const INBOUND_DECL = "const INBOUND_ANCHOR_PARAMS = ['band', 'member', 'node', 'person', 'anchor'];";

assert.ok(INDEX.includes(SHAREABLE_PARAMS_DECL), 'Expected the SHAREABLE_PARAMS declaration.');
assert.ok(INDEX.includes(INBOUND_DECL), 'Expected the INBOUND_ANCHOR_PARAMS declaration.');

const BODY = [
  SHAREABLE_PARAMS_DECL,
  INBOUND_DECL,
  extractFunction('siteRootUrl'),
  extractFunction('arrivedAnchored'),
  extractFunction('shareableUrl'),
].join('\n');

// Builds a stub `window` and runs the real function bodies against it.
// `anchorId` is the node on screen; `homeStarId` is the site's home star.
function run(href, { anchorId = null, homeStarId = 'Aaron McRae', noSigma = false } = {}) {
  const parsed = new URL(href);
  const window = {
    location: {
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
    },
    RBFT_SIGMA: noSigma ? undefined : { state: { anchorId, homeStarId } },
  };
  const factory = new Function(
    'window',
    'URLSearchParams',
    `${BODY}; return { shareableUrl, siteRootUrl, arrivedAnchored };`,
  );
  return factory(window, URLSearchParams);
}

const ROOT = 'https://sixdegreesofrock.com/';

test('a plain visit sitting on the home star shares the bare front door', () => {
  const { shareableUrl } = run(ROOT, { anchorId: 'Aaron McRae' });
  assert.equal(shareableUrl(), ROOT);
});

test('the home star is not stamped in even when it is the live anchor', () => {
  const { shareableUrl } = run(ROOT, { anchorId: 'Aaron McRae' });
  assert.doesNotMatch(shareableUrl(), /anchor=/);
  assert.doesNotMatch(shareableUrl(), /Aaron/);
});

test('travelling to another node still shares that node', () => {
  const { shareableUrl } = run(ROOT, { anchorId: 'Mother Love Bone' });
  assert.equal(shareableUrl(), 'https://sixdegreesofrock.com/?anchor=Mother+Love+Bone');
});

test('an inbound deep link to the home star is preserved -- that visitor asked', () => {
  const { shareableUrl } = run(`${ROOT}?anchor=Aaron%20McRae`, { anchorId: 'Aaron McRae' });
  assert.equal(shareableUrl(), 'https://sixdegreesofrock.com/?anchor=Aaron+McRae');
});

test('an inbound ?band= to the home star is preserved and canonicalised to ?anchor=', () => {
  const { shareableUrl } = run(`${ROOT}?band=Aaron%20McRae`, { anchorId: 'Aaron McRae' });
  const shared = shareableUrl();
  assert.equal(shared, 'https://sixdegreesofrock.com/?anchor=Aaron+McRae');
  assert.doesNotMatch(shared, /band=/);
});

test('the alternative inbound spellings still collapse to one canonical ?anchor=', () => {
  for (const key of ['band', 'member', 'node', 'person']) {
    const { shareableUrl } = run(`${ROOT}?${key}=Mudhoney`, { anchorId: 'Mudhoney' });
    const shared = shareableUrl();
    assert.equal(shared, 'https://sixdegreesofrock.com/?anchor=Mudhoney');
    assert.doesNotMatch(shared, new RegExp(`${key}=`));
  }
});

test('a stale inbound anchor loses to the node actually on screen', () => {
  const { shareableUrl } = run(`${ROOT}?anchor=KISS`, { anchorId: 'Pearl Jam' });
  assert.equal(shareableUrl(), 'https://sixdegreesofrock.com/?anchor=Pearl+Jam');
});

test('an inbound anchor survives when the graph has not reported a live anchor yet', () => {
  const { shareableUrl } = run(`${ROOT}?anchor=KISS`, { noSigma: true });
  assert.equal(shareableUrl(), 'https://sixdegreesofrock.com/?anchor=KISS');
});

test('a plain visit shares the bare root before the graph has loaded', () => {
  const { shareableUrl } = run(ROOT, { noSigma: true });
  assert.equal(shareableUrl(), ROOT);
});

test('/index.html is stripped so both front doors share the same link', () => {
  const { shareableUrl, siteRootUrl } = run('https://sixdegreesofrock.com/index.html', {
    anchorId: 'Aaron McRae',
  });
  assert.equal(siteRootUrl(), ROOT);
  assert.equal(shareableUrl(), ROOT);
  const deep = run('https://sixdegreesofrock.com/index.html?anchor=Mudhoney', {
    anchorId: 'Mudhoney',
  });
  assert.equal(deep.shareableUrl(), 'https://sixdegreesofrock.com/?anchor=Mudhoney');
});

test('a subdirectory host keeps its path', () => {
  const { siteRootUrl } = run('https://example.com/tree/index.html', { anchorId: 'Mudhoney' });
  assert.equal(siteRootUrl(), 'https://example.com/tree/');
});

test('arrivedAnchored() reads the URL the visit started on, not the live view', () => {
  assert.equal(run(ROOT, { anchorId: 'Mudhoney' }).arrivedAnchored(), false);
  for (const key of ['anchor', 'band', 'member', 'node', 'person']) {
    assert.equal(run(`${ROOT}?${key}=KISS`).arrivedAnchored(), true, `${key} should count`);
  }
});

test('a missing homeStarId cannot suppress a real anchor', () => {
  // If the home star never resolved, the old unconditional behaviour is correct:
  // better a link that names the view than a bare one that loses it.
  const { shareableUrl } = run(ROOT, { anchorId: 'Mudhoney', homeStarId: null });
  assert.equal(shareableUrl(), 'https://sixdegreesofrock.com/?anchor=Mudhoney');
});

test('Copy link carries the view, so an explored tree can be passed on by hand', () => {
  // Copy link is the only way to share a view without posting it to a platform,
  // so it must use the view-carrying builder. The fix belongs inside
  // shareableUrl(), not in a bare-URL special case here: narrowing this button to
  // the root would have removed the ability to share a band at all.
  // Asserted against the source because the clipboard call cannot run headlessly.
  const copy = extractFunction('copySiteLink');
  assert.match(copy, /const siteUrl = shareableUrl\(\);/);
});

test('the copy confirmation names which link was actually copied', () => {
  // A single fixed "Main site link copied" is how the old behaviour stayed hidden
  // for as long as it did: it reported the front door while handing over a deep
  // link, so nobody reading the confirmation had a reason to check the clipboard.
  const copy = extractFunction('copySiteLink');
  assert.match(copy, /siteUrl === siteRootUrl\(\)/);
  assert.match(copy, /Main site link copied to your clipboard\./);
  assert.match(copy, /Link to this view copied to your clipboard\./);
});

test('every share flow routes through shareableUrl()', () => {
  // One builder, so the home-star rule cannot hold on one path and not another.
  const viaBuilder = (INDEX.match(/const siteUrl = shareableUrl\(\);/g) || []).length;
  assert.ok(
    viaBuilder >= 7,
    `Expected every share flow to call shareableUrl(); found ${viaBuilder}.`,
  );
  const byHand = (INDEX.match(/const siteUrl = (?!shareableUrl\(\);)/g) || []).length;
  assert.equal(byHand, 0, 'A share link must not be assembled outside shareableUrl().');
});
