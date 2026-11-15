// Regression (Aaron, 2026-11-15): the last hop of a Daily run needed two
// taps. The completion blocks assign analyticsLastSessionId and
// trackDailyShare reads it, but the variable was never declared — in an ES
// module the assignment throws a ReferenceError AFTER the run completes
// server-side and BEFORE the finished board paints or the results open.
// The second tap only looked like the fix: it hit the "that run is over"
// recovery, which paints. These assertions keep the declaration in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = readFileSync(join(root, 'scripts/six-degrees-game.mjs'), 'utf8');

test('analyticsLastSessionId is declared exactly once', () => {
  const declarations = engine.match(/\blet analyticsLastSessionId\b/g) || [];
  assert.equal(declarations.length, 1,
    'analyticsLastSessionId must be declared with let exactly once');
});

test('the declaration sits with the analytics session state, before any use', () => {
  const declaredAt = engine.indexOf('let analyticsLastSessionId');
  const firstUse = engine.indexOf('analyticsLastSessionId', declaredAt + 1);
  assert.ok(declaredAt !== -1, 'declaration exists');
  assert.ok(engine.indexOf('let analyticsSessionId') < declaredAt,
    'declared beside analyticsSessionId');
  assert.ok(firstUse > declaredAt, 'no use precedes the declaration');
});

test('completion paths still record the finished session for share tracking', () => {
  const assignments = engine.match(/analyticsLastSessionId = analyticsSessionId;/g) || [];
  assert.ok(assignments.length >= 2,
    'win and give-up completion blocks keep assigning the last session id');
  assert.ok(engine.includes('analyticsSessionId || analyticsLastSessionId'),
    'trackDailyShare still falls back to the last session id');
});
