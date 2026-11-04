// Governor sign-in wiring (2026-11-04).
//
// Regression: initSignup (OAuth buttons, email form, signed-in state) lived
// inside the local-data boot chain (loadGraphData .then), which governor
// mode skips entirely -- so on the plain URL the sign-in panel opened with
// dead buttons and no error. initSignup is now a top-level function called
// from both boot paths. Static wiring assertions only: the code lives
// inline in graph/index.html and needs the DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'graph', 'index.html'), 'utf8');

test('initSignup is a single top-level function, not an IIFE inside the local chain', () => {
  assert.ok(!INDEX_HTML.includes('(function initSignup()'), 'no nested initSignup IIFE must remain');
  const defs = INDEX_HTML.match(/function initSignup\(\) \{/g) || [];
  assert.equal(defs.length, 1, 'exactly one initSignup definition must exist');
});

test('initSignup is defined before the local-data boot chain starts', () => {
  const defAt = INDEX_HTML.indexOf('function initSignup() {');
  const chainAt = INDEX_HTML.indexOf('rendererReady.then(loadGraphData)');
  assert.ok(defAt > 0 && chainAt > defAt, 'definition must precede the loadGraphData chain it used to live in');
});

test('governor branch binds sign-in wiring alongside governorBoot', () => {
  const branchAt = INDEX_HTML.indexOf('governorBoot();');
  assert.ok(branchAt > 0, 'governor branch must exist');
  const branch = INDEX_HTML.slice(branchAt, branchAt + 400);
  assert.ok(branch.includes('initSignup();'), 'governor branch must call initSignup()');
});

test('local chain still binds sign-in wiring exactly once per boot', () => {
  const chainAt = INDEX_HTML.indexOf('rendererReady.then(loadGraphData)');
  const chain = INDEX_HTML.slice(chainAt);
  const calls = chain.match(/initSignup\(\);/g) || [];
  assert.equal(calls.length, 1, 'local chain must call initSignup() exactly once');
});

test('initSignup is idempotent so a retry can never bind buttons twice', () => {
  const defAt = INDEX_HTML.indexOf('function initSignup() {');
  const head = INDEX_HTML.slice(defAt, defAt + 600);
  assert.ok(head.includes('if (initSignup.done) return;'), 'guard must early-return on a second call');
  assert.ok(head.includes('initSignup.done = true;'), 'guard must mark the first call done');
});

test('OAuth binding lives inside initSignup', () => {
  const defAt = INDEX_HTML.indexOf('function initSignup() {');
  const body = INDEX_HTML.slice(defAt, defAt + 20000);
  assert.ok(body.includes('async function startOAuth(provider, button)'), 'startOAuth must live in initSignup');
  assert.ok(body.includes("document.querySelectorAll('[data-oauth-provider]')"), 'provider buttons must be bound in initSignup');
  assert.ok(body.includes('/api/oauth/authorize?provider='), 'binding must hit the authorize endpoint');
});
