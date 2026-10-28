// Session-level bot-vs-human detail (Aaron, 2026-10-28): game events carry
// the request's User-Agent so the ops board can break sessions down by
// browser/device. IPs are never stored — rate limit only, transient.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = readFileSync(join(root, 'netlify/functions/game_analytics.mjs'), 'utf8');
const migrate = readFileSync(join(root, 'netlify/functions/migrate.mjs'), 'utf8');

test('migration adds the user_agent column to game_analytics_events', () => {
  assert.ok(migrate.includes('alter table game_analytics_events add column if not exists user_agent text'));
});

test('endpoint stores the request User-Agent, server-side', () => {
  assert.ok(endpoint.includes("req.headers?.get?.('user-agent')"), 'header read, not client payload');
  assert.ok(endpoint.includes('duration_seconds, user_agent)'), 'insert carries the column');
});

test('endpoint retries without the column so events survive a not-yet-migrated table', () => {
  const first = endpoint.indexOf('duration_seconds, user_agent)');
  const retry = endpoint.indexOf('duration_seconds)', first + 1);
  assert.ok(first !== -1 && retry !== -1, 'fallback insert without user_agent exists');
});

test('no IP is stored on events', () => {
  const inserts = endpoint.split('insert into game_analytics_events').slice(1);
  assert.ok(inserts.length >= 2, 'both inserts present');
  for (const ins of inserts) {
    const cols = ins.slice(0, ins.indexOf(')'));
    assert.ok(!/\bip\b/.test(cols), 'no ip column in event insert');
  }
});
