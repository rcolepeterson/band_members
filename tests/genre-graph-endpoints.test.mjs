// Genre Graph live-pull (spec 2026-11-26): the band_genre_data layer,
// its four endpoints, the apply script's merge-record mapping, and the
// page's live/snapshot wiring.
//
// Endpoint tests use the same no-DB short-circuit as
// bands-neon-endpoint.test.mjs (NETLIFY_DATABASE_URL unset -> 503), which
// exercises the method/auth/validation layer without Postgres. The write
// path (diff + upsert) runs against pglite with the REAL migration SQL
// from sql/genre-graph-migration-v1.sql, through the Neon-shaped tagged
// template from apply-enrichments.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import { DB_URL_ENV } from '../netlify/functions/_db.mjs';
import genreGraph from '../netlify/functions/genre_graph.mjs';
import genreGraphBand from '../netlify/functions/genre_graph_band.mjs';
import genreGraphPortal, { dedupeMembershipRows } from '../netlify/functions/genre_graph_portal.mjs';
import genreGraphApply, { MAX_APPLY_ROWS } from '../netlify/functions/genre_graph_apply.mjs';
import {
  GENRE_TABLES,
  GENRE_TIERS,
  GENRE_COLUMNS,
  isUuid,
  debutYearOf,
  normalizeGenreRow,
  genreRowEquals,
  diffGenreRows,
  upsertGenreRows,
  slimGenreRow,
  shapePortalNeighborhood,
} from '../netlify/functions/_genre_graph.mjs';
import { mergeRecordToGenreRow, summarizeRows } from '../scripts/apply-genre-data.mjs';

const BAND_A = '11111111-1111-4111-8111-111111111111';
const BAND_B = '22222222-2222-4222-8222-222222222222';
const BAND_MISSING = '33333333-3333-4333-8333-333333333333';

function req(method, { headers = {}, body, url = 'https://example.test/api' } = {}) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers.get('content-type') && typeof body !== 'string') {
      init.headers.set('content-type', 'application/json');
    }
  }
  return new Request(url, init);
}

function withoutDb(fn) {
  return async () => {
    const before = process.env[DB_URL_ENV];
    delete process.env[DB_URL_ENV];
    try {
      await fn();
    } finally {
      if (before !== undefined) process.env[DB_URL_ENV] = before;
    }
  };
}

function withAdminToken(fn) {
  return async () => {
    const before = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'test-token';
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = before;
    }
  };
}

function validRow(overrides = {}) {
  return {
    band_id: BAND_A,
    primary_genre: 'grunge',
    genre_tier: 'good',
    genre_sources: ['discogs', 'existing_db'],
    genre_agreement: 2,
    fringe_genres: [{ value: 'alternative rock', sources: ['discogs'] }],
    first_album_year: 1991,
    first_album_title: 'Ter',
    first_album_source: 'aaron_correction',
    first_album_tier: 'aaron_correction',
    formation_year: 1985,
    end_year: null,
    has_conflict: false,
    provenance: { band_id: BAND_A, note: 'test' },
    ...overrides,
  };
}

// --- GET /api/genre-graph ----------------------------------------------------

test('GET /api/genre-graph returns 503 with configuration hint when DB URL missing',
  withoutDb(async () => {
    const r = await genreGraph(req('GET'));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.ok(body.hint.includes(DB_URL_ENV));
  })
);

test('POST /api/genre-graph is rejected with 405', async () => {
  const r = await genreGraph(req('POST', { body: {} }));
  assert.equal(r.status, 405);
});

// --- GET /api/genre-graph/band/:id -------------------------------------------

test('band endpoint rejects a non-UUID id with 400 before touching the DB', async () => {
  const r = await genreGraphBand(req('GET'), { params: { id: 'not-a-uuid' } });
  assert.equal(r.status, 400);
});

test('band endpoint returns 503 for a valid UUID when DB URL missing',
  withoutDb(async () => {
    const r = await genreGraphBand(req('GET'), { params: { id: BAND_A } });
    assert.equal(r.status, 503);
  })
);

test('band endpoint rejects POST with 405', async () => {
  const r = await genreGraphBand(req('POST', { body: {} }), { params: { id: BAND_A } });
  assert.equal(r.status, 405);
});

// --- GET /api/genre-graph/portal/:bandId --------------------------------------

test('portal endpoint rejects a non-UUID id with 400', async () => {
  const r = await genreGraphPortal(req('GET'), { params: { bandId: 'nope' } });
  assert.equal(r.status, 400);
});

test('portal endpoint returns 503 for a valid UUID when DB URL missing',
  withoutDb(async () => {
    const r = await genreGraphPortal(req('GET'), { params: { bandId: BAND_A } });
    assert.equal(r.status, 503);
  })
);

// --- POST /api/genre-graph/apply ----------------------------------------------

test('apply endpoint rejects GET with 405', async () => {
  const r = await genreGraphApply(req('GET'));
  assert.equal(r.status, 405);
});

test('apply endpoint returns 401 without an admin token', withAdminToken(async () => {
  const r = await genreGraphApply(req('POST', { body: { rows: [validRow()] } }));
  assert.equal(r.status, 401);
}));

test('apply endpoint returns 401 with a wrong admin token', withAdminToken(async () => {
  const r = await genreGraphApply(req('POST', {
    headers: { 'x-admin-token': 'wrong' },
    body: { rows: [validRow()] },
  }));
  assert.equal(r.status, 401);
}));

test('apply endpoint: auth passes, then 503 when DB URL missing (auth before DB check)',
  withAdminToken(withoutDb(async () => {
    const r = await genreGraphApply(req('POST', {
      headers: { 'x-admin-token': 'test-token' },
      body: { rows: [validRow()] },
    }));
    assert.equal(r.status, 503);
  }))
);

test('apply batch cap is 1000 rows', () => {
  assert.equal(MAX_APPLY_ROWS, 1000);
});

// --- Pure logic: _genre_graph.mjs ----------------------------------------------

test('isUuid accepts canonical UUIDs and rejects junk', () => {
  assert.equal(isUuid(BAND_A), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(null), false);
});

test('debutYearOf: first album wins, formation is the fallback, else null', () => {
  assert.equal(debutYearOf({ first_album_year: 1991, formation_year: 1985 }), 1991);
  assert.equal(debutYearOf({ first_album_year: null, formation_year: 1985 }), 1985);
  assert.equal(debutYearOf({ first_album_year: null, formation_year: null }), null);
});

test('normalizeGenreRow accepts a valid row and keeps first_album_tier free-text', () => {
  const { row, errors } = normalizeGenreRow(validRow());
  assert.equal(errors, undefined);
  assert.equal(row.band_id, BAND_A);
  assert.equal(row.first_album_tier, 'aaron_correction');
});

test('normalizeGenreRow rejects a genre_tier outside the locked vocabulary', () => {
  const { row, errors } = normalizeGenreRow(validRow({ genre_tier: 'certain' }));
  assert.equal(row, undefined);
  assert.ok(errors.some((e) => e.includes('genre_tier')));
  for (const tier of GENRE_TIERS) {
    assert.equal(normalizeGenreRow(validRow({ genre_tier: tier })).errors, undefined);
  }
});

test('normalizeGenreRow rejects out-of-range years and a missing band_id', () => {
  assert.ok(normalizeGenreRow(validRow({ first_album_year: 1700 })).errors);
  assert.ok(normalizeGenreRow(validRow({ formation_year: 2200 })).errors);
  assert.ok(normalizeGenreRow(validRow({ band_id: undefined })).errors);
  assert.ok(normalizeGenreRow(null).errors);
});

test('genreRowEquals is insensitive to jsonb key order', () => {
  const a = validRow({ provenance: { x: 1, y: { p: 1, q: 2 } } });
  const b = validRow({ provenance: { y: { q: 2, p: 1 }, x: 1 } });
  assert.equal(genreRowEquals(a, b), true);
  assert.equal(genreRowEquals(a, validRow({ primary_genre: 'punk rock' })), false);
});

test('diffGenreRows splits inserts / updates / unchanged / missing bands', () => {
  const existing = new Map([[BAND_A, validRow()]]);
  const bandIds = new Set([BAND_A, BAND_B]);
  const incoming = [
    validRow(),                                        // unchanged
    validRow({ band_id: BAND_B, primary_genre: 'punk rock' }), // insert
    validRow({ band_id: BAND_MISSING }),               // band not in DB
  ];
  const d = diffGenreRows(existing, bandIds, incoming);
  assert.equal(d.unchanged.length, 1);
  assert.equal(d.inserts.length, 1);
  assert.equal(d.updates.length, 0);
  assert.deepEqual(d.missingBand.map((r) => r.band_id), [BAND_MISSING]);

  const d2 = diffGenreRows(existing, bandIds, [validRow({ primary_genre: 'pop' })]);
  assert.equal(d2.updates.length, 1);
  assert.ok(d2.updates[0].fields.includes('primary_genre'));
});

test('slimGenreRow computes debut_year and carries genre_sources', () => {
  const s = slimGenreRow({ ...validRow(), id: BAND_A, name: 'Sweet Water', city: null, country: null });
  assert.equal(s.id, BAND_A);
  assert.equal(s.genre, 'grunge');
  assert.equal(s.debut_year, 1991);
  assert.deepEqual(s.genre_sources, ['discogs', 'existing_db']);
  assert.equal(s.provenance, undefined);
});

test('shapePortalNeighborhood builds entry + outer in the embedded PORTAL shape', () => {
  const bands = [
    { id: BAND_A, name: 'Centre Band' },
    { id: BAND_B, name: 'Other Band' },
  ];
  const members = [
    { id: 'm1', name: 'Member One' },
    { id: 'm2', name: 'Member Two' },
  ];
  const memberships = [
    { band_id: BAND_A, member_id: 'm1' },
    { band_id: BAND_A, member_id: 'm2' },
    { band_id: BAND_B, member_id: 'm1' },
  ];
  const shaped = shapePortalNeighborhood({ centre: bands[0], memberships, members, bands, degrees: 3 });
  assert.deepEqual(shaped.entry, [['Member One', ['Other Band']], ['Member Two', []]]);
  assert.deepEqual(shaped.outer['Other Band'], [['Member One', ['Centre Band']]]);
  assert.equal(shaped.ids['Centre Band'], BAND_A);
  const twoDeg = shapePortalNeighborhood({ centre: bands[0], memberships, members, bands, degrees: 2 });
  assert.deepEqual(twoDeg.outer, {});
});

test('portal rows2+rows3 merge dedupes (rows2 is a subset of rows3 at degrees=3)', () => {
  // Sweet Water-shaped fixture: 7 centre members, some shared with 2°
  // bands, plus a third-ring member reachable only through a 2° band.
  const BAND_C = '44444444-4444-4444-8444-444444444444';
  const BAND_D = '55555555-5555-4555-8555-555555555555';
  const bands = [
    { id: BAND_A, name: 'Sweet Water' },
    { id: BAND_B, name: 'SGM' },
    { id: BAND_C, name: 'The Protocol' },
    { id: BAND_D, name: 'Third Ring Band' },
  ];
  const members = [
    { id: 'm1', name: 'Member One' },
    { id: 'm2', name: 'Member Two' },
    { id: 'm3', name: 'Member Three' },
    { id: 'm4', name: 'Member Four' },
    { id: 'm5', name: 'Member Five' },
    { id: 'm6', name: 'Member Six' },
    { id: 'm7', name: 'Member Seven' },
    { id: 'm8', name: 'Third Ring Member' },
  ];
  const row = (band_id, member_id) => ({ band_id, member_id });
  // 2°: every membership held by the centre band's members.
  const rows2 = [
    row(BAND_A, 'm1'), row(BAND_A, 'm2'), row(BAND_A, 'm3'), row(BAND_A, 'm4'),
    row(BAND_A, 'm5'), row(BAND_A, 'm6'), row(BAND_A, 'm7'),
    row(BAND_B, 'm1'), row(BAND_B, 'm2'), row(BAND_C, 'm3'),
  ];
  // 3°: memberships of the 2° bands' members — includes all of rows2
  // (centre members sit in 2° bands too) plus the third ring.
  const rows3 = [...rows2, row(BAND_B, 'm8'), row(BAND_D, 'm8')];
  const merged = dedupeMembershipRows([...rows2, ...rows3]);
  assert.equal(merged.length, rows3.length);
  const shaped = shapePortalNeighborhood({ centre: bands[0], memberships: merged, members, bands, degrees: 3 });
  assert.equal(shaped.entry.length, 7);
  const names = shaped.entry.map(([n]) => n);
  assert.equal(new Set(names).size, 7, 'entry members are unique');
  for (const [, others] of shaped.entry) {
    assert.equal(new Set(others).size, others.length, 'other-band lists have no duplicates');
  }
  assert.deepEqual(shaped.entry[0], ['Member One', ['SGM']]);
  assert.ok(shaped.outer['SGM'].some(([n]) => n === 'Third Ring Member'));
});

// --- Apply script mapping --------------------------------------------------------

test('mergeRecordToGenreRow maps the merge record and preserves it as provenance', () => {
  const rec = {
    band_id: BAND_A,
    name: 'Sweet Water',
    primary_genre: { value: 'grunge', tier: 'provisional', sources: ['aaron_correction'], agreement_count: 1 },
    fringe_genres: [{ value: 'pop', sources: ['discogs'] }],
    first_album: { year: 1991, title: 'Ter', source: 'aaron_correction', tier: 'aaron_correction' },
    formation: { begin_year: 1985, end_year: null },
    conflicts: [{ field: 'first_album' }],
  };
  const row = mergeRecordToGenreRow(rec);
  assert.equal(row.primary_genre, 'grunge');
  assert.equal(row.first_album_year, 1991);
  assert.equal(row.formation_year, 1985);
  assert.equal(row.has_conflict, true);
  assert.equal(row.provenance, rec);
  const summary = summarizeRows([row]);
  assert.equal(summary.total, 1);
});

// --- pglite: real migration + upsert round-trip -----------------------------------

async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create table bands (
      id uuid primary key,
      name text not null,
      city text, state text, country text, genre text, years_active text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  // The real migration file, verbatim — proves it runs as shipped.
  const migration = readFileSync(new URL('../sql/genre-graph-migration-v1.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  const sql = async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
    return (await db.query(text, values)).rows;
  };
  sql.db = db;
  return sql;
}

test('migration creates band_genre_data with the GENRE_COLUMNS shape', async () => {
  const sql = await makeDb();
  const cols = await sql`
    select column_name from information_schema.columns
    where table_name = 'band_genre_data' order by ordinal_position
  `;
  const names = cols.map((c) => c.column_name);
  for (const col of GENRE_COLUMNS) assert.ok(names.includes(col), `missing column ${col}`);
  assert.ok(names.includes('band_id'));
  assert.ok(names.includes('created_at') && names.includes('updated_at'));
});

test('upsertGenreRows inserts, then re-upserting the same row is a no-op diff', async () => {
  const sql = await makeDb();
  await sql`insert into bands (id, name) values (${BAND_A}, 'Sweet Water'), (${BAND_B}, 'SGM')`;
  const rows = [validRow(), validRow({ band_id: BAND_B, primary_genre: 'crossover thrash', first_album_year: 1988, first_album_title: 'Aggression' })];
  await upsertGenreRows(sql, rows);
  const stored = await sql`select band_id, primary_genre, first_album_year from band_genre_data order by primary_genre`;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].primary_genre, 'crossover thrash');
  assert.equal(stored[1].first_album_year, 1991);

  // Idempotency: the same rows diff as unchanged against what's stored.
  const existingRows = await sql`select * from band_genre_data`;
  const existingById = new Map(existingRows.map((r) => [r.band_id, r]));
  const d = diffGenreRows(existingById, new Set([BAND_A, BAND_B]), rows);
  assert.equal(d.unchanged.length, 2);
  assert.equal(d.inserts.length + d.updates.length, 0);

  // A changed value diffs as an update naming the field.
  const d2 = diffGenreRows(existingById, new Set([BAND_A, BAND_B]), [validRow({ primary_genre: 'pop' })]);
  assert.equal(d2.updates.length, 1);
  assert.ok(d2.updates[0].fields.includes('primary_genre'));
});

// --- SQL / migrate / cache cross-checks -------------------------------------------

test('sql migration, migrate.mjs, and GENRE_COLUMNS agree', () => {
  const sqlFile = readFileSync(new URL('../sql/genre-graph-migration-v1.sql', import.meta.url), 'utf8');
  const migrate = readFileSync(new URL('../netlify/functions/migrate.mjs', import.meta.url), 'utf8');
  assert.ok(sqlFile.includes('create table if not exists band_genre_data'));
  assert.ok(migrate.includes('create table if not exists band_genre_data'));
  assert.ok(migrate.includes('band_genre_data_primary_genre_idx'));
  for (const col of GENRE_COLUMNS) {
    assert.ok(sqlFile.includes(col), `sql file missing ${col}`);
    assert.ok(migrate.includes(col), `migrate.mjs missing ${col}`);
  }
  // Additive lock: the migration never alters the bands table.
  assert.ok(!/alter table bands/i.test(sqlFile));
});

test('graph cache knows the band_genre_data table', () => {
  assert.ok(GENRE_TABLES.includes('band_genre_data'));
  const cache = readFileSync(new URL('../netlify/functions/_graph_cache.mjs', import.meta.url), 'utf8');
  assert.ok(cache.includes('GENRE_TABLES'), '_graph_cache must fold GENRE_TABLES into KNOWN_TABLES');
});

// --- Page wiring -------------------------------------------------------------------

const page = readFileSync(new URL('../genre-graph/index.html', import.meta.url), 'utf8');

test('page keeps the embedded snapshot as fallback', () => {
  assert.ok(page.includes('var DATA = '), 'embedded DATA present');
  assert.ok(page.includes('var BANDS = '), 'embedded BANDS present');
  assert.ok(page.includes('var PORTAL = '), 'embedded PORTAL present');
});

test('page fetches live data and rebuilds through buildModel', () => {
  assert.ok(page.includes('fetch("/api/genre-graph"'), 'boot fetch present');
  assert.ok(page.includes('function applyLiveData('), 'applyLiveData present');
  assert.ok(page.includes('function buildModel()'), 'buildModel present');
  assert.ok(page.includes('"/api/genre-graph/portal/"'), 'live portal fetch present');
  assert.ok(page.includes('"/api/genre-graph/band/"'), 'provenance fetch present');
});

test('page carries the Key section (locked hybrid provenance design)', () => {
  assert.ok(page.includes('Key — sources &amp; confidence'));
  assert.ok(page.includes('data-prov-expand'), 'per-card provenance expansion present');
});

test('FOLD_INS resolves long-tail genres through chains, rock and roll to rock', () => {
  const m = page.match(/var FOLD_INS = (\{[^;]*\});/);
  assert.ok(m, 'FOLD_INS literal present');
  const fold = JSON.parse(m[1]);
  assert.equal(Object.keys(fold).length, 295);
  const dataMatch = page.match(/var DATA = (\{.*?\});\n/);
  assert.ok(dataMatch, 'DATA literal present');
  const tax = new Set(JSON.parse(dataMatch[1]).genres.map((g) => g[0]));
  const resolve = (pg) => {
    if (!pg) return null;
    if (pg === 'rock and roll') return 'rock';
    let cur = pg;
    const seen = new Set();
    let hops = 0;
    while (cur && !tax.has(cur) && hops < 5) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      cur = fold[cur];
      hops++;
    }
    return cur && tax.has(cur) ? cur : null;
  };
  assert.equal(resolve('grunge'), 'grunge');
  assert.equal(resolve('rock and roll'), 'rock');
  assert.equal(resolve('horror punk post hardcore'), 'punk rock');
  assert.equal(resolve('totally made up genre'), null);
  assert.equal(resolve(null), null);
});
