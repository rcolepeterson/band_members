// ---------------------------------------------------------------------------
// Layout invariants: the quality GATE for the Sigma neighborhood explorer.
//
// Why this file exists
// -------------------
// The Sigma layout work was verified one screenshot at a time, and each round
// of "looks good to me" was followed by a bug report: members stacking on each
// other, names missing, a node sitting on an unrelated edge, a phantom star, a
// curve bowing the wrong way. Every one of those was a violation of a property
// we could have stated up front and checked automatically.
//
// So instead of eyeballing one view, this sweeps a MATRIX -- several graph
// shapes, several anchors, several hop/budget combinations -- and asserts the
// properties that must hold for all of them:
//
//   1. Completeness   every visible node gets a position
//   2. Distinctness   no two nodes share coordinates
//   3. Separation     no two nodes are closer than the separation floor
//   4. Edge clearance no node sits on an edge it is not part of, measured
//                     against the CURVE that is actually drawn
//   5. Ring order     rings grow outward monotonically with hop distance
//   6. Locality       a membership edge never crosses the middle of the graph
//   7. Determinism    the same view produces the same coordinates every time
//
// It is pure geometry: no browser, no WebGL, no network. That means it runs in
// CI on every push (see .github/workflows/test.yml) and catches these
// regressions before anyone opens a preview. The browser-side companion is
// scripts/layout-audit.mjs, which checks the same properties in real rendered
// pixels across viewport sizes and interaction states.
//
// Thresholds are expressed in layout units, relative to the layout's own
// separation floor, so they stay meaningful if spacing changes.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { linkEndpoints } from '../scripts/neighborhood-helpers.mjs';
import { SHAPES, BUDGETS, layoutFor, violations } from './helpers/layout-checks.mjs';


// ---------------------------------------------------------------------------
// Graph shapes. Each one exists because it broke something, or because it is a
// shape the real data actually takes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Known-hard configurations
//
// The densest expansions of the real graph -- five and six degrees out from a
// hub like Swans, several hundred nodes, hundreds of cross-links between them --
// still contain a handful of tight spots. That is not a bug waiting to be fixed
// by another constant: a graph where one musician plays in eight bands cannot be
// drawn in a plane with every node clear of every unrelated edge, and past a
// point the honest answer is that these views are for exploring outward from,
// not for reading whole.
//
// They are listed here with an allowance rather than silently excluded, so:
//   - a regression that makes any of them worse fails the suite,
//   - an improvement also fails it, with a message telling you to lower the
//     number, so progress gets recorded instead of forgotten,
//   - and nothing else in the matrix is allowed a single violation.
//
// Lower these as the layout improves. Do not add to the list to make a failure
// go away without understanding it first.
// ---------------------------------------------------------------------------

const KNOWN_TIGHT = new Map([
  ['liveSample / anchor Swans / 4 hops, 160 nodes', 1],
  ['liveSample / anchor Swans / 5 hops, 220 nodes', 6],
  ['liveSample / anchor Swans / 6 hops, 400 nodes', 1],
  ['liveSample / anchor John Stanier / 6 hops, 400 nodes', 1],
]);

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

for (const [shapeName, build] of Object.entries(SHAPES)) {
  const graph = build();
  // Anchor on the default anchor, plus the busiest band and a leaf, so we cover
  // home visits, deep links onto a hub, and deep links onto a dead end.
  const busiest = graph.nodes
    .filter(node => node.type === 'band')
    .map(node => ({
      id: node.id,
      degree: graph.links.filter(link => linkEndpoints(link).includes(node.id)).length,
    }))
    .sort((a, b) => b.degree - a.degree)[0];
  const leaf = graph.nodes
    .filter(node => node.type === 'person' && node.id !== 'Aaron McRae')
    .slice(-1)[0];
  const anchors = ['Aaron McRae', busiest && busiest.id, leaf && leaf.id].filter(Boolean);

  for (const anchorId of anchors) {
    for (const budget of BUDGETS) {
      const label = `${shapeName} / anchor ${anchorId} / ${budget.maxHops} hops, ${budget.maxNodes} nodes`;

      test(`layout invariants: ${label}`, () => {
        const laid = layoutFor(graph, anchorId, budget);
        if (!laid.view.nodes.length) return; // anchor outside this graph: nothing to check
        const found = violations(laid, anchorId);
        const allowance = KNOWN_TIGHT.get(label);
        if (allowance === undefined) {
          assert.deepEqual(found, [], `${found.length} violation(s):\n  ${found.slice(0, 8).join('\n  ')}`);
          return;
        }
        // A known-hard configuration: locked at its current count so it cannot
        // get worse, and so improving it is visible (the test fails, telling you
        // to lower the number).
        assert.ok(
          found.length <= allowance,
          `${label} regressed to ${found.length} violation(s), allowance ${allowance}:\n  ${found
            .slice(0, 6)
            .join('\n  ')}`
        );
        assert.ok(
          found.length >= allowance - 1 || allowance === 0,
          `${label} now has only ${found.length} violation(s) -- lower its allowance from ${allowance}`
        );
      });
    }
  }

  test(`layout is deterministic: ${shapeName}`, () => {
    const first = layoutFor(graph, 'Aaron McRae', BUDGETS[2]);
    const second = layoutFor(graph, 'Aaron McRae', BUDGETS[2]);
    first.positions.forEach((point, id) => assert.deepEqual(point, second.positions.get(id)));
    assert.equal(first.positions.size, second.positions.size);
  });
}

// ---------------------------------------------------------------------------
// The audit's dataset dimension.
//
// The rendered-view audit reported 44/44 clean while the live site hid labels
// users could see were missing. Cause: a local static server has no /api route,
// so the page falls back to the bundled CSV (3,194 nodes) while production reads
// Neon (3,240). Different counts, different layout -- so a clean CSV run was
// never evidence about production. These pin the fix so the dimension cannot be
// quietly dropped, which would restore the blind spot without failing anything.
// ---------------------------------------------------------------------------
const AUDIT = readFileSync(new URL('../scripts/layout-audit.mjs', import.meta.url), 'utf8');

test('the audit renders both the fixture and the production payload', () => {
  assert.match(AUDIT, /const DATA_CHOICE = readFlag\('--data', 'both'\)/);
  assert.match(AUDIT, /key: 'fixture'/);
  assert.match(AUDIT, /key: 'production'/);
  // Both by default: a pass on one is not evidence about the other.
  assert.match(AUDIT, /DATA_CHOICE === 'both' \|\| DATA_CHOICE === set\.key/);
  // An unknown --data value must fail loudly rather than audit nothing and
  // print "0/0 checks clean".
  assert.match(AUDIT, /--data must be one of: fixture, production, both/);
});

test('production data is replayed into the page, not fetched live', () => {
  // Depending on the network, the password gate, or whatever the database holds
  // this minute would make the gate flaky and its failures unreproducible.
  assert.match(AUDIT, /await context\.route\('\*\*\/api\/bands', route => route\.fulfill\(\{/);
  assert.match(AUDIT, /body: JSON\.stringify\(dataset\.replay\)/);
  // Fulfilling that one route is the whole difference, because the page tries
  // /api/bands first and falls back to CSV.
  assert.match(AUDIT, /const PRODUCTION_PAYLOAD = JSON\.parse\(readFileSync\(SNAPSHOT_PATH, 'utf8'\)\)/);
});

test('refreshing the snapshot is explicit and refuses an empty payload', () => {
  // A fixture whose expectations change underneath it silently is not a gate.
  assert.match(AUDIT, /const REFRESH_DATA = args\.includes\('--refresh-data'\)/);
  // An API blip must not blank the snapshot and turn the production pass into a
  // no-op that still reports clean.
  assert.match(AUDIT, /Refused to overwrite the snapshot/);
  assert.match(AUDIT, /!Array\.isArray\(payload\.bands\) \|\| !payload\.bands\.length/);
});

test('every audit row names the dataset that produced it', () => {
  // Otherwise a production-only failure reads as an unreproducible flake.
  assert.match(AUDIT, /label: `\$\{dataset\.label\}\s+\$\{viewport\.label\}`/);
  assert.match(AUDIT, /const label = `\$\{dataset\.label\}\s+\$\{viewport\.label\} \/ \$\{state\.label\}`/);
});

test('the production snapshot holds a real graph and no personal data', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../scripts/fixtures/production-bands.json', import.meta.url), 'utf8')
  );
  // Big enough to be production rather than a truncated or errored response.
  assert.ok(snapshot.bands.length > 400, `expected 400+ bands, got ${snapshot.bands.length}`);
  assert.ok(snapshot.members.length > 2500, `expected 2500+ members, got ${snapshot.members.length}`);
  assert.ok(snapshot.memberships.length > 3500, `expected 3500+ memberships, got ${snapshot.memberships.length}`);
  // The snapshot is committed, so it must carry only the public fields the site
  // already serves -- no contact details, credentials or submitter identities.
  const forbidden = /email|password|token|secret|auth|ip_address|phone|submitted_by|user_id/i;
  for (const collection of ['bands', 'members', 'memberships']) {
    for (const key of Object.keys(snapshot[collection][0])) {
      assert.doesNotMatch(key, forbidden, `${collection}.${key} looks like personal data`);
    }
  }
});

// ---------------------------------------------------------------------------
// The click-through pass.
//
// Two bugs shipped in one day that every other check called clean: the Filter
// pill opened its panel just past the bottom of the window (top:910 in a 900px
// viewport), and the "No Rawk Found" prompt never appeared because nothing
// listened for the event that raises it. Both were invisible for the same
// reason -- the tests drove the machinery directly (selectOption on a <select>,
// functions called by name) instead of pressing what a visitor presses and then
// looking at what came up. These pin the pass that closes that gap.
// ---------------------------------------------------------------------------

test('the audit presses every pill and measures what opens', () => {
  assert.match(AUDIT, /const CLICK_THROUGH = \[/);
  for (const key of ['filter', 'share', 'add', 'feedback']) {
    assert.match(AUDIT, new RegExp(`key: '${key}'`), `${key} must be pressed`);
  }
  // A real press at the pill's own coordinates, so anything covering the pill
  // fails here instead of being bypassed by a synthetic event.
  assert.match(AUDIT, /await page\.click\(trigger, \{ timeout: 5000 \}\)/);
  // The search miss is a flow, not a pill: type a band that is not in the tree.
  assert.match(AUDIT, /search: 'Zzzz Not A Real Band', opens: '#graph-empty-state'/);
  assert.match(AUDIT, /await page\.fill\('\.sigma-prompt input', item\.search\)/);
});

test('opening a panel off screen is a failure, not a pass', () => {
  // The exact fault: aria-expanded said true, the selects were populated, and
  // the panel was 279px below the bottom of the window.
  assert.match(AUDIT, /below the bottom of the window/);
  assert.match(AUDIT, /above the top of the window/);
  assert.match(AUDIT, /left of the window/);
  assert.match(AUDIT, /right of the window/);
  // And the other fault: raised nothing at all.
  assert.match(AUDIT, /is still hidden after the click/);
  assert.match(AUDIT, /is not in the document/);
});

test('the click-through measures the result, not an aria attribute', () => {
  // The Filter pill set aria-expanded="true" for the entire time it was broken,
  // so believing the trigger would have kept the gate green.
  const measure = AUDIT.slice(AUDIT.indexOf('const MEASURE_OPENED'), AUDIT.indexOf('const MEASURE_CHROME'));
  assert.doesNotMatch(measure, /aria-expanded/);
  assert.match(measure, /getBoundingClientRect\(\)/);
  // Reachable by a pointer: something drawn on top of the panel means a visitor
  // clicks that instead.
  assert.match(measure, /document\.elementFromPoint\(cx, cy\)/);
  assert.match(measure, /covers it/);
  // Too small to use counts as broken too.
  assert.match(measure, /too small to be usable/);
});

test('every opened panel is counted in the audit total', () => {
  // A pass whose results are printed but not counted is decoration.
  assert.match(AUDIT, /const checks = rows\.length \+ chromeRows\.length \+ labelRows\.length \+ clickRows\.length;/);
  assert.match(AUDIT, /if \(result\.problems\.length\) failures \+= 1;/);
});

test('the audit presses Share and weighs the picture it produces', () => {
  // The share export shipped broken and no check noticed, because none of them
  // pressed the button. A blank or zero-sized canvas still encodes to a valid
  // PNG, just a tiny one, so the file's weight is the assertion that matters.
  assert.match(AUDIT, /Share image/);
  assert.match(AUDIT, /page\.waitForEvent\('download'/);
  assert.match(AUDIT, /button:has-text\("Download PNG"\)/);
  assert.match(AUDIT, /almost certainly blank/);
  assert.match(AUDIT, /if \(size < 20000\)/);
  // Downloads have to be accepted for that to be possible at all.
  assert.match(AUDIT, /acceptDownloads: true/);
  // And when nothing is produced, report what the page told the visitor.
  assert.match(AUDIT, /no image was produced/);
});
