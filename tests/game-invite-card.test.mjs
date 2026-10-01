// Unit tests for the head-to-head invite link-preview card:
//   GET /invite/<token>  ->  dynamic og: tags, then handoff to /game/?invite=
//
// The card's copy + HTML builders are pure (no DB), so they're tested
// directly. The live lookup path is verified manually against a deploy,
// same as the other game endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  inviteCardCopy,
  inviteCardHtml,
} from '../netlify/functions/game_invite_card.mjs';

test('escapeHtml neutralizes markup and quotes', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script> & friends'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; friends'
  );
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('open challenge names the challenger and their band pick', () => {
  const copy = inviteCardCopy({
    state: 'open',
    challenger: 'rawker4821',
    band_a: 'Zeke',
  });
  assert.equal(copy.title, 'rawker4821 challenged you to a Six Degrees showdown');
  assert.match(copy.description, /Zeke vs \?/);
  assert.match(copy.description, /stump/);
});

test('answered challenge names both sides and both bands', () => {
  const copy = inviteCardCopy({
    state: 'answered',
    challenger: 'rawker4821',
    invitee: 'paulkuhlir',
    band_a: 'Zeke',
    band_b: 'Metallica',
  });
  assert.match(copy.title, /rawker4821 vs paulkuhlir/);
  assert.match(copy.description, /Zeke vs Metallica/);
});

test('answered challenge without a recorded invitee still reads clean', () => {
  const copy = inviteCardCopy({
    state: 'answered',
    challenger: 'rawker4821',
    invitee: null,
    band_a: 'Zeke',
    band_b: 'Metallica',
  });
  assert.match(copy.title, /rawker4821/);
  assert.doesNotMatch(copy.title, /null|undefined/);
});

test('expired challenge says so plainly', () => {
  const copy = inviteCardCopy({ state: 'expired' });
  assert.match(copy.title, /ended/i);
  assert.match(copy.description, /expired/i);
});

test('unknown token gets generic challenge copy, never an error page', () => {
  const copy = inviteCardCopy({ state: 'unknown' });
  assert.match(copy.title, /challenge/i);
  assert.doesNotMatch(copy.title, /null|undefined/);
});

test('card HTML carries the og/twitter tags and the handoff', () => {
  const html = inviteCardHtml({
    token: 'abc123',
    title: 'rawker4821 challenged you to a Six Degrees showdown',
    description: 'Zeke vs ? — pick a band and try to stump them.',
  });
  assert.match(html, /<meta property="og:title" content="rawker4821 challenged you to a Six Degrees showdown" \/>/);
  assert.match(html, /<meta property="og:description" content="Zeke vs \?/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/sixdegreesofrock\.com\/invite\/abc123" \/>/);
  // Humans land on the real invite flow.
  assert.match(html, /<meta http-equiv="refresh" content="0;url=\/game\/\?invite=abc123" \/>/);
  assert.match(html, /<a href="\/game\/\?invite=abc123">Continue to the challenge<\/a>/);
});

test('hostile band names cannot break out of the card markup', () => {
  const evil = '"><script>alert(1)</script>';
  const html = inviteCardHtml({ token: evil, title: evil, description: evil });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});
