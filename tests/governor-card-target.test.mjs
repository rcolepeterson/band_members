// Governor card bridge: travelled-to target insertion (2026-11-04).
//
// Regression: the page master is frozen at the boot landing view, so a node
// reached by search/travel is usually ABSENT from it. The bridge used to
// look the target up, find nothing, and open() then resolved nothing, so
// no card opened (the pill still showed, because selection is module-side).
// The bridge must insert the fetched entity as the target node before the
// field patch, membership links and open() run. Static wiring assertions
// only: the bridge lives inline in graph/index.html and needs the DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'graph', 'index.html'), 'utf8');

const bridgeStart = INDEX_HTML.indexOf('GOVERNOR card bridge');
assert.ok(bridgeStart >= 0, 'governor card bridge comment must exist in graph/index.html');
const bridge = INDEX_HTML.slice(bridgeStart, bridgeStart + 8000);

test('bridge looks the target up by the selected node id', () => {
  assert.ok(
    bridge.includes('let target = master.nodes.find(n => n.id === detail.id);'),
    'target lookup must key on detail.id'
  );
});

test('bridge inserts a missing target node before patching it', () => {
  const insertAt = bridge.indexOf('if (!target) {');
  assert.ok(insertAt >= 0, 'missing-target guard must exist');
  const insertBlock = bridge.slice(insertAt, insertAt + 800);
  assert.ok(
    insertBlock.includes("target = { id: detail.id, name: entity.name || detail.id, type: detail.type === 'band' ? 'band' : 'person' };"),
    'inserted node must carry the selected id, the entity name, and a page node type (band/person)'
  );
  assert.ok(insertBlock.includes('master.nodes.push(target);'), 'inserted node must land in master.nodes');
});

test('inserted target keeps uuid and place fields for badge and subtitle lookup', () => {
  const insertAt = bridge.indexOf('if (!target) {');
  const insertBlock = bridge.slice(insertAt, insertAt + 800);
  assert.ok(insertBlock.includes('target.uuid = entity.id'), 'uuid must be kept for badge lookup');
  assert.ok(insertBlock.includes('target.city = entity.city'), 'city must be kept for the card subtitle');
  assert.ok(insertBlock.includes('target.country = entity.country'), 'country must be kept for the card subtitle');
});

test('insertion runs before the entity field patch and before open()', () => {
  const insertAt = bridge.indexOf('if (!target) {');
  const patchAt = bridge.indexOf("['bio', 'genre', 'label', 'albums', 'instrument1', 'instrument2']");
  const openAt = bridge.indexOf('open();');
  assert.ok(insertAt > 0 && patchAt > insertAt, 'insertion must precede the field patch');
  assert.ok(openAt > patchAt, 'open() must run after the patch, so the card reads the inserted node');
});

test('card id prefers the current view uuid over the plain-name fallback', () => {
  // For a travelled-to node the page master has no row, so the uuid lookup
  // there misses; without the current-view lookup the id falls back to the
  // plain name, which graph-card rejects with a uuid-cast 500 and the card
  // never opens. The module's current view always carries the selected
  // node's uuid (state.view.nodes, refreshed on every travel).
  const viewNodesAt = bridge.indexOf('const viewNodes = ');
  const viewNodeAt = bridge.indexOf('const viewNode = ');
  assert.ok(viewNodesAt >= 0 && viewNodeAt > viewNodesAt, 'card id must consult the current view node uuid');
  const cardIdAt = bridge.indexOf('const cardId = ');
  assert.ok(cardIdAt > viewNodeAt, 'view uuid lookup must precede the cardId assignment');
  assert.ok(
    bridge.includes('window.RBFT_SIGMA.state.view.nodes'),
    'current view nodes must come from the Sigma controller state'
  );
  const cardIdLine = bridge.slice(cardIdAt, cardIdAt + 300);
  assert.ok(
    cardIdLine.indexOf('viewNode && viewNode.uuid') < cardIdLine.indexOf('masterNode && (masterNode.name'),
    'view uuid must outrank the plain-name fallback in the cardId chain'
  );
});

test('non-governor card path is untouched', () => {
  assert.ok(bridge.includes('if (window.RBFT_GOVERNOR_MODE) {'), 'governor branch must still exist');
  const governorClose = bridge.indexOf('open();');
  const rest = bridge.slice(governorClose + 'open();'.length);
  assert.ok(rest.includes('open();'), 'the plain (non-governor) open() path must still follow the governor branch');
});
