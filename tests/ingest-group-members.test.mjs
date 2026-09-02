// A group is not a member.
//
// Where this came from: an automated batch added a "band" called Claypool Gold
// whose members were Primus, The Claypool Lennon Delirium and The Les Claypool
// Frog Brigade. Claypool Gold is a 2026 TOUR, and MusicBrainz really does model
// it as a Group whose 'member of band' relations are three other Groups plus
// Les Claypool. The ingestion copied that faithfully, and because this schema
// has exactly one relationship — band -> person — the three bands were written
// into the graph as PEOPLE.
//
// The damage was not the phantom rows themselves. Each collided by name with
// the real band, and node identity in the graph is the display name, so the
// band and the "person" became one node. On top of that, a solo-act self-loop
// from the same class of collision crashed the renderer outright.
//
// The relation type was on the payload the whole time (`relatedType`) and
// nothing looked at it. These tests make sure something does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractMemberRelations,
  isPersonRelation,
  partitionMemberRelations,
  looksLikeCollective,
} from '../scripts/musicbrainz.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INGEST = readFileSync(join(__dirname, '..', 'scripts', 'ingest-musicbrainz.mjs'), 'utf8');

// The real payload shape, verified against the MusicBrainz web service:
// artist effb12e4-4439-4a3a-98e8-a5ae4aaf5105 "Claypool Gold", type Group.
const claypoolGoldBody = {
  id: 'effb12e4-4439-4a3a-98e8-a5ae4aaf5105',
  name: 'Claypool Gold',
  type: 'Group',
  relations: [
    { type: 'member of band', direction: 'backward', artist: { id: 'a1', name: 'The Claypool Lennon Delirium', type: 'Group' } },
    { type: 'member of band', direction: 'backward', artist: { id: 'a2', name: 'Les Claypool', type: 'Person' } },
    { type: 'member of band', direction: 'backward', artist: { id: 'a3', name: 'The Les Claypool Frog Brigade', type: 'Group' } },
    { type: 'member of band', direction: 'backward', artist: { id: 'a4', name: 'Primus', type: 'Group' } },
  ],
};

// A real band, for contrast: every member is a person.
const primusBody = {
  id: 'b1',
  name: 'Primus',
  type: 'Group',
  relations: [
    { type: 'member of band', direction: 'backward', artist: { id: 'p1', name: 'Les Claypool', type: 'Person' } },
    { type: 'member of band', direction: 'backward', artist: { id: 'p2', name: 'Larry LaLonde', type: 'Person' } },
    { type: 'member of band', direction: 'backward', artist: { id: 'p3', name: 'Tim Alexander', type: 'Person' } },
  ],
};

test('the relation type survives extraction, which is what makes the guard possible', () => {
  const relations = extractMemberRelations(claypoolGoldBody);
  assert.equal(relations.length, 4, 'all four member relations are extracted');
  assert.deepEqual(
    relations.map(r => r.relatedType),
    ['Group', 'Person', 'Group', 'Group'],
    'relatedType must carry through: it is the only signal distinguishing a band from a musician here.'
  );
});

test('group-typed relations are refused as members', () => {
  assert.equal(isPersonRelation({ relatedType: 'Person' }), true);
  assert.equal(isPersonRelation({ relatedType: 'Group' }), false, 'a band cannot be a member of a band here');
  assert.equal(isPersonRelation({ relatedType: 'Orchestra' }), false, 'an orchestra is a collection of musicians');
  assert.equal(isPersonRelation({ relatedType: 'Choir' }), false, 'so is a choir');
});

test('an unknown or blank type is treated as a person', () => {
  // MB leaves the type empty on plenty of legitimate obscure musicians.
  // Refusing those would drop real members to catch a rare fake one.
  assert.equal(isPersonRelation({ relatedType: '' }), true);
  assert.equal(isPersonRelation({}), true);
  assert.equal(isPersonRelation({ relatedType: 'Character' }), true);
});

test('the Claypool Gold payload yields exactly one storable member', () => {
  const { people, groups } = partitionMemberRelations(extractMemberRelations(claypoolGoldBody));
  assert.deepEqual(people.map(r => r.relatedName), ['Les Claypool']);
  assert.deepEqual(
    groups.map(r => r.relatedName),
    ['The Claypool Lennon Delirium', 'The Les Claypool Frog Brigade', 'Primus'],
    'These three are the phantom musicians that reached production.'
  );
});

test('a real band loses nothing to the guard', () => {
  const { people, groups } = partitionMemberRelations(extractMemberRelations(primusBody));
  assert.equal(people.length, 3, 'every Primus member is a person and must survive');
  assert.equal(groups.length, 0);
});

test('a tour billing is recognised as a collective, a band is not', () => {
  assert.equal(
    looksLikeCollective(extractMemberRelations(claypoolGoldBody)),
    true,
    'three groups to one person is a billing, not a band.'
  );
  assert.equal(looksLikeCollective(extractMemberRelations(primusBody)), false);
});

test('one guest ensemble does not make a band a collective', () => {
  // The threshold has to leave real bands alone. A band with a single
  // affiliated group and several human members is still a band.
  const withOneGuestGroup = [
    { relatedName: 'A Person', relatedType: 'Person' },
    { relatedName: 'B Person', relatedType: 'Person' },
    { relatedName: 'Some Orchestra', relatedType: 'Orchestra' },
  ];
  assert.equal(looksLikeCollective(withOneGuestGroup), false);
});

test('a supergroup of people stays a band even with an affiliated group', () => {
  const supergroup = [
    { relatedName: 'P1', relatedType: 'Person' },
    { relatedName: 'P2', relatedType: 'Person' },
    { relatedName: 'P3', relatedType: 'Person' },
    { relatedName: 'G1', relatedType: 'Group' },
    { relatedName: 'G2', relatedType: 'Group' },
  ];
  assert.equal(looksLikeCollective(supergroup), false, 'people outnumber groups: still a band');
});

// -------------------------------------------------------------------------
// The ingestion run has to actually use it. A guard nothing calls is a
// comment, and this bug already shipped once with the type sitting unused
// on the payload.
// -------------------------------------------------------------------------

test('the ingestion run partitions relations before scoring or emitting members', () => {
  assert.match(INGEST, /partitionMemberRelations\(candidate\.detail\.relations\)/, 'expected the run to partition the candidate\'s relations');
  assert.match(INGEST, /const memberCount = personRelations\.length;/, 'member count must not include groups');
  assert.match(INGEST, /members: personRelations\.map/, 'the emitted member list must be people only');
  assert.ok(
    !/members: candidate\.detail\.relations\.map/.test(INGEST),
    'the unfiltered relation list must not be written out as members again.'
  );
  assert.ok(
    !/memberNamesInGraph = candidate\.detail\.relations/.test(INGEST),
    'bridge counting must run over people, or a group name can score as a bridge.'
  );
});

test('a collective is held for review rather than scored or merged', () => {
  assert.match(INGEST, /looksLikeCollective\(candidate\.detail\.relations\)/);
  const held = INGEST.slice(INGEST.indexOf('if (isCollective)'), INGEST.indexOf('const memberCount'));
  assert.ok(held.includes('collectives.push('), 'a held candidate must be recorded, not silently dropped');
  assert.ok(held.includes('continue;'), 'a held candidate must skip scoring entirely');
  assert.match(INGEST, /collectives,\n\s*counts: \{/, 'the run summary must carry the held collectives for a human to read');
});
