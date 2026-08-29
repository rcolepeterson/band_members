// Applying a reviewed enrichments.csv to the graph.
//
// ingest-batch.mjs --enrich proposes and never writes, which was the right
// default but left 1,857 verified field updates — 196 founding-member upgrades
// across 59 bands — with no path into the database.
//
// Everything here runs against pglite using the real schema from
// netlify/functions/migrate.mjs, through the same Neon-shaped tagged template the
// production code uses, so the module under test is not modified for testing.
// The safety properties are the point: a dry run by default, an audited actor,
// and every write guarded on the value the CSV was generated against.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import {
  parseCsv,
  splitCsvLine,
  scopeOf,
  buildPlan,
  applyPlan,
  currentMatchesExpectation,
  summarize,
  commitAtomically,
  BAND_FIELDS,
  PERSON_FIELDS,
  MEMBERSHIP_FIELDS,
  UNSUPPORTED_FIELDS,
  ACTION_FOR_SCOPE,
} from '../scripts/apply-enrichments.mjs';

// --- a Neon-shaped tagged template over pglite -------------------------------
async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create table users (id uuid primary key default gen_random_uuid(), email text);
    create table bands (
      id uuid primary key default gen_random_uuid(),
      name text not null, city text, state text, country text, genre text,
      years_active text, label text, albums text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table band_members (
      id uuid primary key default gen_random_uuid(),
      name text not null, city text, state text, country text,
      instrument1 text, instrument2 text, years_active text, bio text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table memberships (
      id bigserial primary key,
      band_id uuid not null references bands(id) on delete cascade,
      member_id uuid not null references band_members(id) on delete cascade,
      tenure text, weight integer not null default 1,
      relation text not null default 'member_of',
      created_at timestamptz not null default now(),
      unique (band_id, member_id)
    );
    create table contributions (
      id bigserial primary key,
      user_id uuid not null references users(id) on delete cascade,
      action text not null check (action in ('add_band','edit_band','edit_band_members','edit_person_bio')),
      band_id text, band_name text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  const sql = async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
    return (await db.query(text, values)).rows;
  };
  sql.db = db;
  return sql;
}

// A band, a founding member recorded as a plain member, and an actor.
async function seedDb(sql, { weight = 2, instrument1 = null } = {}) {
  const [actor] = await sql`insert into users (email) values ('maintainer@example.com') returning id`;
  const [band] = await sql`
    insert into bands (name, city, country, genre, years_active)
    values ('The Dillinger Escape Plan', '', '', '', '') returning id`;
  const [ben] = await sql`
    insert into band_members (name, instrument1) values ('Ben Weinman', ${instrument1}) returning id`;
  await sql`
    insert into memberships (band_id, member_id, weight, relation)
    values (${band.id}, ${ben.id}, ${weight}, 'member_of')`;
  return { actorId: actor.id, bandId: band.id, personId: ben.id };
}

const SEED_ROWS = [
  { source: 'The Dillinger Escape Plan', target: 'Ben Weinman', source_type: 'band', weight: '2' },
];

const proposal = (over = {}) => ({
  band: 'The Dillinger Escape Plan', rowIndex: '0',
  field: 'weight', oldValue: '2', newValue: '1',
  source: 'musicbrainz-original-attribute', ...over,
});

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test('a band name containing a comma survives parsing', () => {
  // "Earth, Wind & Fire" is why this is quote-aware rather than a split(',').
  assert.deepEqual(
    splitCsvLine('"Earth, Wind & Fire",12,weight,2,1,musicbrainz'),
    ['Earth, Wind & Fire', '12', 'weight', '2', '1', 'musicbrainz'],
  );
});

test('an escaped double quote is preserved', () => {
  assert.deepEqual(splitCsvLine('"Ron ""Rebel"" Matthews",1'), ['Ron "Rebel" Matthews', '1']);
});

test('a BOM does not corrupt the first header', () => {
  const rows = parseCsv('\uFEFFband,rowIndex,field\nX,0,weight\n');
  assert.deepEqual(Object.keys(rows[0]), ['band', 'rowIndex', 'field']);
});

// ---------------------------------------------------------------------------
// Field routing
// ---------------------------------------------------------------------------

test('each field routes to exactly one scope', () => {
  assert.equal(scopeOf('weight'), 'membership');
  assert.equal(scopeOf('instrument_1'), 'person');
  assert.equal(scopeOf('years_active'), 'band');
  assert.equal(scopeOf('city'), 'band');
  assert.equal(scopeOf('nonsense'), null);
});

test('instrument 3 and 4 are refused, because the schema has only two columns', () => {
  // band_members has instrument1 and instrument2. The CSV carries four. Dropping
  // 3 and 4 silently would look like success while losing data.
  assert.deepEqual(UNSUPPORTED_FIELDS, ['instrument_3', 'instrument_4']);
  const { plan, skipped } = buildPlan(
    [proposal({ field: 'instrument_3', oldValue: '', newValue: 'Piano' })],
    SEED_ROWS,
  );
  assert.equal(plan.length, 0);
  assert.match(skipped[0].reason, /instrument1\/2 only/);
});

test('a band-level field proposed once per roster row collapses to one write', () => {
  // 24 rows of Black Sabbath propose the same years_active 24 times.
  const many = Array.from({ length: 24 }, () =>
    proposal({ field: 'years_active', oldValue: '', newValue: '1968-present' }));
  const { plan } = buildPlan(many, SEED_ROWS);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].column, 'years_active');
});

test('a per-membership field does NOT collapse', () => {
  const seed = [
    { source: 'B', target: 'One' }, { source: 'B', target: 'Two' },
  ];
  const { plan } = buildPlan([
    { band: 'B', rowIndex: '0', field: 'weight', oldValue: '2', newValue: '1' },
    { band: 'B', rowIndex: '1', field: 'weight', oldValue: '2', newValue: '1' },
  ], seed);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map(p => p.person), ['One', 'Two']);
});

test('a mismatched enrichments/seed pair is refused, not applied to the wrong musician', () => {
  // enrichments.csv identifies a row only by its index into the seed it was
  // generated from. Pairing it with a different seed would silently rewrite
  // whoever happens to sit at that index.
  const { plan, skipped } = buildPlan([proposal()], [{ source: 'Some Other Band', target: 'Nobody' }]);
  assert.equal(plan.length, 0);
  assert.match(skipped[0].reason, /wrong seed file/);
});

test('a rowIndex past the end of the seed is refused', () => {
  const { plan, skipped } = buildPlan([proposal({ rowIndex: '9999' })], SEED_ROWS);
  assert.equal(plan.length, 0);
  assert.match(skipped[0].reason, /not in the seed/);
});

test('--fields narrows the plan', () => {
  const props = [
    proposal(),
    proposal({ field: 'years_active', oldValue: '', newValue: '1997-present' }),
  ];
  const { plan } = buildPlan(props, SEED_ROWS, { fields: ['weight'] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].field, 'weight');
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('the guard compares the database against what the CSV expected', () => {
  assert.ok(currentMatchesExpectation(2, '2'));
  assert.ok(currentMatchesExpectation('', ''));
  assert.ok(currentMatchesExpectation(null, ''));
  assert.ok(!currentMatchesExpectation(1, '2'));
  assert.ok(!currentMatchesExpectation('Guitar', ''));
});

// ---------------------------------------------------------------------------
// Writing, against the real schema
// ---------------------------------------------------------------------------

test('a dry run writes nothing at all', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan([proposal()], SEED_ROWS);
  const results = await applyPlan(sql, plan, { actor: actorId, apply: false });
  assert.deepEqual(summarize(results), { 'would-apply': 1 });
  const [m] = await sql`select weight from memberships`;
  assert.equal(m.weight, 2, 'weight must be untouched');
  assert.equal((await sql`select * from contributions`).length, 0, 'no audit row for a dry run');
});

test('applying upgrades the membership to founder', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan([proposal()], SEED_ROWS);
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.deepEqual(summarize(results), { applied: 1 });
  const [m] = await sql`select weight from memberships`;
  assert.equal(m.weight, 1, 'Ben Weinman is a founder of Dillinger');
});

test('every applied write leaves an audit row naming the actor', async () => {
  const sql = await makeDb();
  const { actorId, bandId } = await seedDb(sql);
  const { plan } = buildPlan([proposal()], SEED_ROWS);
  await applyPlan(sql, plan, { actor: actorId, apply: true });
  const rows = await sql`select * from contributions`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, actorId);
  assert.equal(rows[0].action, ACTION_FOR_SCOPE.membership);
  assert.equal(rows[0].band_name, 'The Dillinger Escape Plan');
  assert.equal(rows[0].band_id, String(bandId));
  const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
  assert.equal(meta.source, 'apply-enrichments');
  assert.equal(meta.person, 'Ben Weinman');
  assert.equal(meta.from, '2');
  assert.equal(meta.to, '1');
});

test('a row a human changed since the CSV is left alone', async () => {
  // The CSV is a snapshot, not a lock. If somebody marked this membership
  // touring in the meantime, their judgement outranks a MusicBrainz attribute.
  const sql = await makeDb();
  const { actorId } = await seedDb(sql, { weight: 3 });
  const { plan } = buildPlan([proposal()], SEED_ROWS);
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].reason, /changed since the CSV/);
  const [m] = await sql`select weight from memberships`;
  assert.equal(m.weight, 3, 'the human value survives');
});

test('an instrument column a human already filled is left alone', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql, { instrument1: 'Bass guitar' });
  const { plan } = buildPlan(
    [proposal({ field: 'instrument_1', oldValue: '', newValue: 'Guitar' })],
    SEED_ROWS,
  );
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'skipped');
  const [p] = await sql`select instrument1 from band_members`;
  assert.equal(p.instrument1, 'Bass guitar');
});

test('an empty instrument column is filled', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql, { instrument1: '' });
  const { plan } = buildPlan(
    [proposal({ field: 'instrument_1', oldValue: '', newValue: 'Guitar' })],
    SEED_ROWS,
  );
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'applied');
  const [p] = await sql`select instrument1 from band_members`;
  assert.equal(p.instrument1, 'Guitar');
});

test('a band-level field is written and audited as edit_band', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan(
    [proposal({ field: 'years_active', oldValue: '', newValue: '1997-present' })],
    SEED_ROWS,
  );
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'applied');
  const [b] = await sql`select years_active from bands`;
  assert.equal(b.years_active, '1997-present');
  const [c] = await sql`select action from contributions`;
  assert.equal(c.action, ACTION_FOR_SCOPE.band);
});

test('a weight outside 1-3 is refused rather than written', async () => {
  // memberships.weight is `integer not null` with no CHECK, so nothing at the
  // database level would stop a 7 — and no renderer knows how to classify one.
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan([proposal({ newValue: '7' })], SEED_ROWS);
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].reason, /must be 1, 2 or 3/);
  const [m] = await sql`select weight from memberships`;
  assert.equal(m.weight, 2, 'nothing written');
});

test('a band absent from the database is reported, not created', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan(
    [proposal({ band: 'Ghost Band' })],
    [{ source: 'Ghost Band', target: 'Ben Weinman' }],
  );
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].reason, /band not found/);
});

test('a person absent from the database is reported, not created', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan(
    [proposal({ rowIndex: '0' })],
    [{ source: 'The Dillinger Escape Plan', target: 'Somebody Else' }],
  );
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].reason, /person not found/);
});

test('a membership that does not exist is reported, not inserted', async () => {
  const sql = await makeDb();
  const { actorId, bandId } = await seedDb(sql);
  await sql`delete from memberships where band_id = ${bandId}`;
  const { plan } = buildPlan([proposal()], SEED_ROWS);
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].reason, /membership not found/);
});

test('one failure does not stop the rest of the run', async () => {
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const { plan } = buildPlan([
    proposal({ newValue: '7' }),
    proposal({ field: 'years_active', oldValue: '', newValue: '1997-present' }),
  ], SEED_ROWS);
  const results = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.deepEqual(summarize(results), { failed: 1, applied: 1 });
  const [b] = await sql`select years_active from bands`;
  assert.equal(b.years_active, '1997-present');
});

test('column names come from frozen maps, never from the CSV', () => {
  // A Neon tagged template cannot parameterize an identifier, so the only safe
  // source of a column name is this module. A field the maps do not know is
  // dropped before any SQL is built.
  assert.ok(Object.isFrozen(BAND_FIELDS));
  assert.ok(Object.isFrozen(PERSON_FIELDS));
  assert.ok(Object.isFrozen(MEMBERSHIP_FIELDS));
  const { plan, skipped } = buildPlan(
    [proposal({ field: 'weight; drop table bands--' })],
    SEED_ROWS,
  );
  assert.equal(plan.length, 0);
  assert.match(skipped[0].reason, /unrecognized field/);
});

test('the audited action is always one the CHECK constraint permits', async () => {
  // contributions.action is a four-value CHECK. A fifth would need a migration,
  // so a backfill records the closest existing action and puts the detail in
  // metadata. If this drifts, every insert fails at write time.
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  for (const action of Object.values(ACTION_FOR_SCOPE)) {
    await sql`
      insert into contributions (user_id, action, band_name)
      values (${actorId}, ${action}, 'probe')`;
  }
  assert.equal((await sql`select * from contributions`).length, 3);
});

test('a "The" prefix variant is not mistaken for a different band', () => {
  // The seed genuinely contains both "Fastbacks" and "The Fastbacks" rows, which
  // share one normalizeNameKey. buildSeedIndex picks one as the display name, so
  // a raw string comparison read the other rows as a different band and refused
  // three legitimate writes.
  const { plan, skipped } = buildPlan(
    [proposal({ band: 'Fastbacks', field: 'years_active', oldValue: '', newValue: '1979-2002' })],
    [{ source: 'The Fastbacks', target: 'Kim Warnick' }],
  );
  assert.equal(skipped.length, 0);
  assert.equal(plan.length, 1);
});

test('a genuinely different band is still refused', () => {
  // The property the loosened comparison must not give up.
  const { plan, skipped } = buildPlan(
    [proposal({ band: 'Mudhoney' })],
    [{ source: 'Pearl Jam', target: 'Ben Weinman' }],
  );
  assert.equal(plan.length, 0);
  assert.match(skipped[0].reason, /wrong seed file/);
});

// ---------------------------------------------------------------------------
// The transaction
//
// This file used to CLAIM "one transaction per band, so a failure cannot
// half-apply a roster" while issuing the update and the audit insert as two
// independent statements. An audit insert that failed after the update succeeded
// left the graph changed with nobody recorded as having changed it — the one
// outcome an audited backfill exists to prevent. These tests exist so the claim
// cannot drift from the behaviour again.
// ---------------------------------------------------------------------------

test('a failed audit insert rolls the data write back', async () => {
  // The realistic trigger: --actor pointing at a user that does not exist.
  // contributions.user_id is a foreign key, so the insert violates it AFTER the
  // membership update has already run inside the transaction.
  const sql = await makeDb();
  await seedDb(sql);
  const ghostActor = '00000000-0000-0000-0000-000000000000';
  const { plan } = buildPlan([proposal()], SEED_ROWS);

  const results = await applyPlan(sql, plan, { actor: ghostActor, apply: true });

  assert.equal(results[0].status, 'failed');
  const [m] = await sql`select weight from memberships`;
  assert.equal(m.weight, 2, 'the weight must be rolled back, not left at 1');
  assert.equal((await sql`select * from contributions`).length, 0, 'no audit row');
});

test('a rolled-back band field is not left changed either', async () => {
  const sql = await makeDb();
  await seedDb(sql);
  const ghostActor = '00000000-0000-0000-0000-000000000000';
  const { plan } = buildPlan(
    [proposal({ field: 'years_active', oldValue: '', newValue: '1997-present' })],
    SEED_ROWS,
  );
  const results = await applyPlan(sql, plan, { actor: ghostActor, apply: true });
  assert.equal(results[0].status, 'failed');
  const [b] = await sql`select years_active from bands`;
  assert.equal(b.years_active, '', 'years_active must be rolled back');
});

test('a rolled-back instrument fill is not left changed either', async () => {
  const sql = await makeDb();
  await seedDb(sql, { instrument1: '' });
  const ghostActor = '00000000-0000-0000-0000-000000000000';
  const { plan } = buildPlan(
    [proposal({ field: 'instrument_1', oldValue: '', newValue: 'Guitar' })],
    SEED_ROWS,
  );
  const results = await applyPlan(sql, plan, { actor: ghostActor, apply: true });
  assert.equal(results[0].status, 'failed');
  const [p] = await sql`select instrument1 from band_members`;
  assert.equal(p.instrument1, '', 'instrument1 must be rolled back');
});

test('a rollback does not poison the rest of the run', async () => {
  // A failed transaction must be rolled back cleanly enough that the NEXT entry
  // can still commit. Without the rollback, Postgres leaves the session in
  // "current transaction is aborted" and every later statement fails too.
  const sql = await makeDb();
  const { actorId } = await seedDb(sql);
  const ghost = '00000000-0000-0000-0000-000000000000';

  const { plan } = buildPlan([proposal()], SEED_ROWS);
  const failed = await applyPlan(sql, plan, { actor: ghost, apply: true });
  assert.equal(failed[0].status, 'failed');

  const second = await applyPlan(sql, plan, { actor: actorId, apply: true });
  assert.equal(second[0].status, 'applied', 'the session must still be usable');
  const [m] = await sql`select weight from memberships`;
  assert.equal(m.weight, 1);
  assert.equal((await sql`select * from contributions`).length, 1);
});

test('commitAtomically commits on success and rolls back on throw', async () => {
  const sql = await makeDb();
  await sql`create table probe (n integer)`;

  await commitAtomically(sql, [() => sql`insert into probe values (1)`]);
  assert.equal((await sql`select * from probe`).length, 1, 'committed');

  await assert.rejects(
    commitAtomically(sql, [
      () => sql`insert into probe values (2)`,
      () => { throw new Error('boom'); },
    ]),
    /boom/,
    'the original error must surface, not a rollback error',
  );
  assert.equal((await sql`select * from probe`).length, 1, 'the second insert was rolled back');
});

test('the file does not claim a transaction it lacks', () => {
  // The specific regression: a comment asserting atomicity while the code had
  // none. If commitAtomically is ever removed, this fails alongside the behaviour.
  const src = readFileSync(new URL('../scripts/apply-enrichments.mjs', import.meta.url), 'utf8');
  assert.match(src, /export async function commitAtomically/);
  assert.match(src, /await commitAtomically\(sql, \[dataThunk, auditThunk\]\)/);
  assert.match(src, /await sql`begin`/);
  assert.match(src, /await sql`commit`/);
  assert.match(src, /await sql`rollback`/);
  // And it must use the driver's own batched transaction when one is offered,
  // because over HTTP a BEGIN is a no-op.
  assert.match(src, /typeof sql\.transaction === 'function'/);
});

test('a driver offering .transaction() is used instead of BEGIN', async () => {
  // The neon() HTTP path. Pool would give a real session, but it needs a
  // WebSocket that Node 20 does not have and `ws` is not a dependency -- the
  // first attempt at this fix crashed on connect. So when the driver batches,
  // batch; never emit a BEGIN that HTTP would silently ignore.
  const issued = [];
  const fake = async (strings) => { issued.push(strings.join('?').trim()); return []; };
  let batched = null;
  fake.transaction = async (queries) => { batched = queries; return []; };

  await commitAtomically(fake, [() => fake`update a set b = 1`, () => fake`insert into c values (2)`]);

  assert.equal(batched.length, 2, 'both statements go in one batch');
  assert.ok(!issued.some(q => /^begin/i.test(q)), 'no BEGIN over a batching driver');
  assert.ok(!issued.some(q => /^commit/i.test(q)), 'no COMMIT either');
});
