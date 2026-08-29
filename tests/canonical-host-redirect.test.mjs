// One canonical host, enforced by an actual redirect.
//
// WHY THIS FILE EXISTS
//
// After the custom domain launched, the project's own Netlify subdomain kept
// serving a byte-identical copy of the site:
//
//   curl -sSI https://bandmembers.netlify.app/   ->   HTTP/2 200
//
// Netlify redirects other *custom* domains to the primary one (www did redirect
// correctly), but it goes on serving the *.netlify.app subdomain, and setting the
// primary domain in the dashboard does not change that. So two hosts competed for
// the same content, every inbound link to the pre-launch address passed none of
// its value on, and a canonical tag was the only thing telling a crawler which
// host to believe. That is a silent, permanent leak: nothing breaks, the site just
// quietly ranks as a duplicate of itself.
//
// This is a redirect rule and therefore invisible in the app's own UI, which makes
// it exactly the kind of thing that gets dropped by a future edit to _redirects.
// The properties below are the ones that would hurt if lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REDIRECTS = readFileSync(join(__dirname, '..', '_redirects'), 'utf8');

const CANONICAL_HOST = 'sixdegreesofrock.com';
const LEGACY_HOST = 'bandmembers.netlify.app';

// Rule lines only: comments carry example URLs and would otherwise match.
const rules = REDIRECTS.split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));

test('both schemes of the legacy host redirect to the canonical host', () => {
  for (const scheme of ['http', 'https']) {
    const rule = rules.find(line => line.startsWith(`${scheme}://${LEGACY_HOST}/`));
    assert.ok(rule, `Expected a ${scheme}:// rule for ${LEGACY_HOST}.`);
    assert.ok(
      rule.includes(`https://${CANONICAL_HOST}/`),
      `Expected the ${scheme}:// rule to target https://${CANONICAL_HOST}, got: ${rule}`
    );
  }
});

test('the redirect is permanent and forced', () => {
  const hostRules = rules.filter(line => line.includes(LEGACY_HOST));
  assert.ok(hostRules.length >= 2, 'Expected host rules for both schemes.');
  for (const rule of hostRules) {
    // 301, not 302: this is a permanent move, and only a 301 consolidates the
    // two hosts for search engines.
    assert.ok(/\b301!/.test(rule), `Expected a forced 301 (301!) in: ${rule}`);
  }
});

test('the path is carried across, so deep links survive the hop', () => {
  const hostRules = rules.filter(line => line.includes(LEGACY_HOST));
  for (const rule of hostRules) {
    assert.ok(rule.includes('/*'), `Expected a splat source so every path redirects: ${rule}`);
    assert.ok(
      rule.includes(':splat'),
      `Expected :splat in the target, or every old deep link lands on the home page: ${rule}`
    );
  }
});

test('the host rules name a host explicitly and cannot match the canonical host', () => {
  // A rule written as a bare path (/* -> https://sixdegreesofrock.com/:splat)
  // would match requests to the canonical host as well and redirect it to
  // itself: an infinite loop that takes the whole site down.
  const loop = rules.find(
    line => /^\/\*/.test(line) && line.includes(CANONICAL_HOST)
  );
  assert.equal(
    loop,
    undefined,
    `A bare-path rule to the canonical host would loop forever: ${loop}`
  );
});

test('deploy previews and branch deploys are not caught by the host rules', () => {
  // Previews are served from deploy-preview-<n>--bandmembers.netlify.app and
  // <branch>--bandmembers.netlify.app. Those are different hostnames, so a rule
  // anchored on the exact host leaves them alone — which is what lets a preview
  // still be tested. A wildcard in the host would break every preview.
  const hostRules = rules.filter(line => line.includes(LEGACY_HOST));
  for (const rule of hostRules) {
    const source = rule.split(/\s+/)[0];
    assert.ok(
      source === `http://${LEGACY_HOST}/*` || source === `https://${LEGACY_HOST}/*`,
      `Expected an exact host match, not a pattern that could catch preview subdomains: ${source}`
    );
  }
});

test('the existing /index.html canonicalisation is still in place', () => {
  assert.ok(
    rules.some(line => line.startsWith('/index.html')),
    'Expected the /index.html -> / rule to survive.'
  );
});
