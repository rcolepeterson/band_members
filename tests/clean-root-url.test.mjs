// The front door's URL must stay clean.
//
// syncAddressBar() runs once, after the opening view is drawn, to canonicalise
// the link the visitor arrived on. It used to unconditionally write
// ?anchor=<home star>, so a plain visit to / was rewritten to
// /?anchor=Aaron%20McRae — the site's own front door looked like a deep link to
// one musician, and that is the URL people then copied out of the address bar.
//
// The fix has two halves and both matter:
//   1. No inbound anchor parameter -> the address bar is left clean.
//   2. An inbound ?band= / ?member= / ?node= / ?person= / ?anchor= is still
//      collapsed to a single canonical ?anchor=, because Share, reload-in-place
//      and the link-preview edge function all depend on that parameter.
//
// scripts/sigma-explorer.mjs imports sigma/graphology, so node --test cannot
// execute it (the same constraint sigma-explorer-wiring.test.mjs lives with).
// syncAddressBar's body is therefore extracted and evaluated against fake
// window/state objects: that exercises the real branching without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, '..', 'scripts', 'sigma-explorer.mjs'), 'utf8');

// Pull `function syncAddressBar() { ... }` out of the module by brace matching.
function extractSyncAddressBar() {
  const start = SOURCE.indexOf('function syncAddressBar()');
  assert.ok(start > 0, 'Expected syncAddressBar() in scripts/sigma-explorer.mjs.');
  let depth = 0;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced braces while extracting syncAddressBar().');
}

const SYNC_SOURCE = extractSyncAddressBar();

// Runs the real function body with a stubbed window and state, and returns the
// URL it would have written to the address bar.
function runSync(href, anchorId) {
  let written = href;
  const win = {
    location: { href },
    history: {
      state: null,
      replaceState(_state, _title, url) {
        written = String(url);
      },
    },
  };
  const state = { anchorId };
  // eslint-disable-next-line no-new-func
  const factory = new Function('win', 'state', 'URL', `${SYNC_SOURCE}; return syncAddressBar;`);
  factory(win, state, URL)();
  return written;
}

const HOME = 'Aaron McRae';

test('a plain visit to the root is left alone', () => {
  const result = runSync('https://example.test/', HOME);
  assert.equal(result, 'https://example.test/', 'Expected the bare root URL to stay bare.');
  assert.ok(!result.includes('anchor'), 'The home star must not be stamped into the address bar.');
});

test('the home star name never appears on an unanchored visit', () => {
  const result = runSync('https://example.test/?utm_source=newsletter', HOME);
  assert.ok(!/anchor=/.test(result), `Expected no anchor parameter, got ${result}`);
  assert.ok(result.includes('utm_source=newsletter'), 'Unrelated query parameters must survive.');
});

test('an inbound shared link keeps its anchor, canonicalised', () => {
  const result = runSync('https://example.test/?anchor=KISS', 'KISS');
  assert.ok(result.includes('anchor=KISS'), `Expected the shared anchor to be preserved, got ${result}`);
});

test('legacy anchor spellings collapse to a single canonical ?anchor=', () => {
  for (const key of ['band', 'member', 'node', 'person']) {
    const result = runSync(`https://example.test/?${key}=ZZ+Top`, 'ZZ Top');
    assert.ok(result.includes('anchor=ZZ+Top'), `Expected ?${key}= to become ?anchor=, got ${result}`);
    assert.ok(!result.includes(`${key}=`), `Expected the inbound ?${key}= to be cleared, got ${result}`);
  }
});

test('an inbound anchor that resolved elsewhere is rewritten to the view actually shown', () => {
  // A misspelled or renamed band resolves to whatever the graph could match;
  // the address bar must agree with the view, not with the request.
  const result = runSync('https://example.test/?band=Led+Zepplin', 'Led Zeppelin');
  assert.ok(result.includes('anchor=Led+Zeppelin'), `Expected the resolved anchor, got ${result}`);
});

test('a malformed location does not throw', () => {
  assert.doesNotThrow(() => runSync('not-a-url', HOME));
});
