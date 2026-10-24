// "Your card" (Cole, Paul, Aaron, 2026-10-11): sign-up asks for the email only;
// name, city, state, country and instrument are filled in later from the
// account menu, and the game asks once, after a win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-10-24 migration: the graph page (and its Your-card flow) moved to /graph.
const home = readFileSync(new URL('../graph/index.html', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../scripts/six-degrees-game.mjs', import.meta.url), 'utf8');

test('the account menu has Your card, all optional, saved with PATCH /api/me', () => {
  const card = home.match(/<details class="user-card-profile"[\s\S]*?<\/details>/)[0];
  for (const id of ['card-name', 'card-city', 'card-state', 'card-country', 'card-instrument']) {
    assert.match(card, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(card, /\srequired/, 'nothing on the card is required');
  assert.match(home, /fetch\('\/api\/me', \{\n\s*method: 'PATCH'/);
  assert.match(home, /initProfileCard\(\);/);
});

test('/?card=1 opens the account menu on Your card', () => {
  assert.match(home, /\[\?&\]card=1\(&\|\$\)\/\.test\(location\.search\) && loadCurrentUser\(\)/);
  assert.match(home, /details\.open = true;/);
});

test('Google, Facebook and Instagram sign-in are untouched', () => {
  for (const provider of ['google', 'facebook', 'instagram']) {
    assert.match(home, new RegExp(`data-oauth-provider="${provider}"`));
  }
  assert.match(home, /function startOAuth\(provider, button\)/);
});

test('the game asks for the card once, after a win, only if no city is saved', () => {
  assert.match(engine, /\} else if \(won && shouldAskForCard\(\)\) \{/);
  assert.match(engine, /href="\/\?card=1">Add it to your card<\/a>/);
  const ask = engine.match(/function shouldAskForCard\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(ask, /if \(localStorage\.getItem\(CARD_PROMPT_KEY\)\) return false;/);
  assert.match(ask, /user && user\.token && !user\.city/);
});

test('"Playing as" in the game opens the account menu on the homepage', () => {
  // The header pill, not the "Playing as" line inside the game box.
  const badge = engine.match(/async function renderArenaPlayerBadge\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(badge, /if \(!isSignedIn\(\)\) \{[\s\S]*?badge\.onclick = null;/, 'guests get no link');
  assert.match(badge, /badge\.setAttribute\('data-action', 'account'\);/);
  assert.match(badge, /badge\.onclick = \(\) => \{ window\.location\.href = '\/\?account=1'; \};/);
  assert.doesNotMatch(engine, /initPlayerLineLink/);
  // The homepage opens the menu for account=1, and Your card only for card=1.
  assert.match(home, /\[\?&\]account=1\(&\|\$\)\/\.test\(location\.search\) && loadCurrentUser\(\)/);
  assert.match(home, /if \(details && openCard\) details\.open = true;/);
});
