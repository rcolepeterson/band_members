// Compact results end screen (Aaron, 2026-11-06): the results card
// scrolled on phones — about 350px too tall. Nothing is removed, the
// card is tightened: via text goes inline after its pill, stats and
// bars slim down, results-only card padding shrinks, and Share +
// Create-a-free-account sit side by side as smaller pills. Share text
// stays spoiler-free and every label stays put.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');
const results = src.slice(src.indexOf('function openDailyResults('), src.indexOf('function shouldAskForReminder()'));

test('chain via is inline after its pill, not a separate row', () => {
  assert.ok(!src.includes('<li class="sd-chain-via">'), 'no standalone via rows');
  assert.ok(src.includes("via = el('<span class=\"sd-chain-via\">"), 'via is a span inside the node row');
  assert.ok(src.includes('if (via) li.appendChild(via);'), 'via follows its pill');
  assert.ok(src.includes('.sd-chain-via{flex:1 1 110px;'), 'via takes the remaining width');
  assert.ok(src.includes('-webkit-line-clamp:2;'), 'long via lists cap at two lines');
});

test('Share and Create sit side by side as smaller pills', () => {
  assert.ok(src.includes('.sd-end-actions{display:flex;'), 'actions row is flex');
  assert.ok(results.includes('endActions.appendChild(shareBtn);'), 'Share goes in the row');
  assert.ok(results.includes('endActions.appendChild(guestBtn);'), 'Create goes in the same row');
  assert.ok(results.includes("endActions.after(el('<p class=\"sd-end-caption\">to save your streak and stats!</p>'));"), 'caption stays, right under the row');
  assert.ok(src.includes('.sd-end-actions .sd-primary,.sd-end-actions .sd-guest-btn{flex:1 1 0;'), 'both pills share the row equally');
  assert.ok(src.includes('min-height:44px;'), 'pills are smaller than the old 52px full-width ones');
});

test('copy and chrome are untouched, results card is tighter', () => {
  assert.ok(src.includes('Share result'), 'Share keeps its label');
  assert.ok(src.includes('Create a free account'), 'Create keeps its label');
  assert.ok(src.includes("c.classList.add('sd-modal-card--results');"), 'results card carries its own class');
  assert.ok(src.includes('.sd-modal-card--results{padding:18px 14px 12px}'), 'results padding shrinks, other modals untouched (tightened further 2026-11-07)');
  assert.ok(src.includes('.sd-modal-card--results h2{font-size:1.25rem}'), 'results title shrinks, other modals untouched (tightened further 2026-11-07)');
  assert.ok(src.includes('.sd-stats-grid .sd-stat strong{font-size:1.35rem}'), 'stats numbers slim down');
  assert.ok(src.includes('.sd-stat strong{display:block;font-size:1.55rem;'), 'moves/shortest/time numbers slim down');
  assert.ok(src.includes("c.appendChild(chainListEl([start, ...mine], run.connections || {}));"), 'chain call site unchanged');
});
