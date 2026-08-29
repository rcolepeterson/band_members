// -----------------------------------------------------------------------
// Apply a REVIEWED enrichments.csv to the graph.
//
// ingest-batch.mjs --enrich proposes; it never writes. That was the right
// default -- a MusicBrainz attribute should not silently rewrite a contributor's
// data -- but it left the last mile missing: 1,857 verified field updates,
// including 196 founding-member upgrades across 59 bands, sitting in a CSV with
// no path into the database. Founders that nobody can see are not founders.
//
// So this is the other half, and it is built to be boring on purpose:
//
//   --dry-run   is the default. Writing requires --apply, explicitly.
//   --actor     is required. contributions.user_id is NOT NULL and references
//               users(id), and that is correct: a backfill is a change somebody
//               approved, and the audit trail should name them rather than
//               invent a robot account with no accountability.
//   every write is guarded on the value the CSV was generated against. A
//               proposal that says 2 -> 1 is skipped if the row no longer reads
//               2, because a human may have edited it in the meantime and the
//               CSV is a snapshot, not a lock.
//   every write and its audit row commit together, or neither does.
//               This claimed to be true before it was: the update and the
//               contributions insert were two independent statements, so an audit
//               insert that failed after the update succeeded left the graph
//               changed with no record of who changed it -- the one outcome an
//               audited backfill exists to prevent.
//
//               Atomicity is reached two different ways depending on the driver,
//               because over HTTP a BEGIN is a no-op: each statement is its own
//               implicit transaction. neon()'s own .transaction([...]) batches
//               statements into ONE request that really is atomic, so that is what
//               the CLI uses. A session-backed client -- pglite in the tests, or
//               node-postgres -- takes the BEGIN/COMMIT path instead. Same
//               guarantee, arrived at by whichever route the connection supports.
//
//   node scripts/apply-enrichments.mjs --enrichments <csv> --seed <csv> \
//        --actor <user-uuid> [--apply] [--fields weight,instruments,...] [--limit N]
// -----------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { normalizeNameKey } from './pipeline-helpers.mjs';

// ---------------------------------------------------------------------------
// Field routing
//
// The CSV's field names are the pipeline's, not the schema's. This is the only
// place the two vocabularies meet.
// ---------------------------------------------------------------------------

// Band-level columns live on bands, keyed by band name. The CSV proposes these
// once per membership row, so 24 rows of Black Sabbath propose the same
// years_active 24 times; they collapse to one UPDATE per band per field.
export const BAND_FIELDS = Object.freeze({
  years_active: 'years_active',
  city: 'city',
  country: 'country',
  genre: 'genre',
});

// Person-level columns live on band_members, keyed by person name.
//
// NOTE the asymmetry, which is a real schema limit and not an oversight here:
// the CSV carries four instrument columns and band_members has TWO
// (instrument1, instrument2). instrument_3 and instrument_4 proposals have
// nowhere to go and are reported as skipped rather than silently dropped.
//
// Instruments are also stored per PERSON, not per membership, so a drummer in
// one band who played guitar in another cannot be represented -- the same shape
// of problem the role fix (#119) solved for weight, still unsolved for
// instruments. Worth naming; not worth quietly papering over.
export const PERSON_FIELDS = Object.freeze({
  instrument_1: 'instrument1',
  instrument_2: 'instrument2',
});

export const UNSUPPORTED_FIELDS = Object.freeze(['instrument_3', 'instrument_4']);

// Membership-level. The reason this script exists.
export const MEMBERSHIP_FIELDS = Object.freeze({ weight: 'weight' });

// contributions.action is a CHECK constraint with four permitted values, so a
// backfill is recorded as the closest existing one rather than requiring a
// migration to add a fifth. metadata carries the detail, including that it came
// from this script.
export const ACTION_FOR_SCOPE = Object.freeze({
  band: 'edit_band',
  person: 'edit_band_members',
  membership: 'edit_band_members',
});

export function scopeOf(field) {
  if (field in BAND_FIELDS) return 'band';
  if (field in PERSON_FIELDS) return 'person';
  if (field in MEMBERSHIP_FIELDS) return 'membership';
  return null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// Minimal, quote-aware. enrichments.csv is machine-written by csvRow(), but band
// names legitimately contain commas ("Earth, Wind & Fire") and the seed is
// human-edited, so a naive split is not safe on either file.
export function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (!lines.length) return rows;
  const headers = splitCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] === undefined ? '' : cells[i]; });
    rows.push(row);
  }
  return rows;
}

export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Turn CSV proposals into a plan: one entry per intended write, carrying the
 * band, the person (when the write is about one), the target column, the value
 * the CSV was generated against, and the new value.
 *
 * `seedRows` supplies the person name, because enrichments.csv identifies a row
 * only by its index into the seed it was generated from. A mismatched pair of
 * files would therefore point at the wrong musician, so the row's band is
 * cross-checked against the proposal's band and any disagreement is refused
 * rather than applied.
 */
export function buildPlan(proposals, seedRows, { fields = null } = {}) {
  const plan = [];
  const skipped = [];
  const seenBandField = new Set();

  for (const p of proposals) {
    const field = p.field;
    if (UNSUPPORTED_FIELDS.includes(field)) {
      skipped.push({ ...p, reason: 'no column in band_members (schema has instrument1/2 only)' });
      continue;
    }
    const scope = scopeOf(field);
    if (!scope) {
      skipped.push({ ...p, reason: `unrecognized field '${field}'` });
      continue;
    }
    if (fields && !fields.includes(field) && !(fields.includes('instruments') && field.startsWith('instrument_'))) {
      skipped.push({ ...p, reason: 'excluded by --fields' });
      continue;
    }

    const idx = Number(p.rowIndex);
    const seedRow = Number.isInteger(idx) ? seedRows[idx] : null;
    if (!seedRow) {
      skipped.push({ ...p, reason: `rowIndex ${p.rowIndex} is not in the seed` });
      continue;
    }
    // The guard against a stale pairing of enrichments.csv and seed CSV.
    //
    // Compared on normalizeNameKey rather than raw text, because that is the key
    // the pipeline matched on when it wrote the CSV. The seed genuinely contains
    // both "Fastbacks" and "The Fastbacks" rows, which share one normalized key,
    // so buildSeedIndex picked one as the display name and the other rows read as
    // a different band. A raw comparison refused three legitimate writes for that
    // reason alone. A genuinely mismatched pair of files still fails here, which
    // is the property worth keeping.
    if (normalizeNameKey(seedRow.source) !== normalizeNameKey(p.band)) {
      skipped.push({
        ...p,
        reason: `seed row ${idx} is '${seedRow.source}', not '${p.band}' — wrong seed file?`,
      });
      continue;
    }

    if (scope === 'band') {
      // Collapse the same band-level field proposed once per roster row.
      const key = `${p.band}::${field}`;
      if (seenBandField.has(key)) continue;
      seenBandField.add(key);
      plan.push({
        scope, band: p.band, person: null,
        column: BAND_FIELDS[field], field,
        oldValue: p.oldValue, newValue: p.newValue,
      });
      continue;
    }

    const person = (seedRow.target || '').trim();
    if (!person) {
      skipped.push({ ...p, reason: `seed row ${idx} has no person` });
      continue;
    }
    plan.push({
      scope, band: p.band, person,
      column: scope === 'person' ? PERSON_FIELDS[field] : MEMBERSHIP_FIELDS[field],
      field, oldValue: p.oldValue, newValue: p.newValue,
    });
  }
  return { plan, skipped };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Is the database still in the state the CSV was generated against?
 *
 * A "fill an empty column" proposal must find the column empty. A "2 -> 1"
 * proposal must find a 2. Anything else means a human edited the row after the
 * CSV was produced, and their judgement wins over a MusicBrainz attribute.
 */
export function currentMatchesExpectation(current, oldValue) {
  const expected = String(oldValue == null ? '' : oldValue).trim();
  const actual = String(current == null ? '' : current).trim();
  return expected === actual;
}

/**
 * Commit every statement in `thunks` atomically, or none of them.
 *
 * Each thunk is a function returning a query, deliberately not a started one, so
 * this can decide HOW to run them:
 *
 *   - `sql.transaction([...])`, when the driver offers it. This is neon()'s HTTP
 *     path: the statements go in one request and the server treats them as a
 *     single transaction. A BEGIN would be useless here, because over HTTP each
 *     statement is already its own implicit transaction -- which is exactly why
 *     the atomicity this file used to claim was not merely missing but
 *     unreachable with that connection.
 *   - BEGIN / COMMIT / ROLLBACK otherwise, for a session-backed client. pglite in
 *     the tests, node-postgres in principle.
 *
 * The ORIGINAL error is rethrown, never a rollback error. A rollback that itself
 * fails is swallowed: that means the connection is gone, which already rolled the
 * transaction back, and the first error is the one worth reporting.
 */
export async function commitAtomically(sql, thunks) {
  if (typeof sql.transaction === 'function') {
    return sql.transaction(thunks.map(fn => fn()));
  }
  await sql`begin`;
  try {
    const results = [];
    for (const fn of thunks) results.push(await fn());
    await sql`commit`;
    return results;
  } catch (err) {
    try {
      await sql`rollback`;
    } catch {
      // See above: the connection is gone and the original error is the useful one.
    }
    throw err;
  }
}

/**
 * Apply a plan. `sql` is a Neon-shaped tagged template over a single session, so
 * this runs against a pooled Neon client in production and pglite in tests with
 * no branching.
 *
 * Returns a per-entry outcome so a caller can print a reviewable report:
 * applied, skipped (with a reason), or failed.
 */
export async function applyPlan(sql, plan, { actor, apply = false } = {}) {
  const results = [];
  const bandIds = new Map();
  const personIds = new Map();

  async function bandId(name) {
    if (bandIds.has(name)) return bandIds.get(name);
    const rows = await sql`select id from bands where name = ${name} limit 1`;
    const id = rows.length ? rows[0].id : null;
    bandIds.set(name, id);
    return id;
  }
  async function personId(name) {
    if (personIds.has(name)) return personIds.get(name);
    const rows = await sql`select id from band_members where name = ${name} limit 1`;
    const id = rows.length ? rows[0].id : null;
    personIds.set(name, id);
    return id;
  }

  for (const entry of plan) {
    const bid = await bandId(entry.band);
    if (!bid) {
      results.push({ ...entry, status: 'skipped', reason: 'band not found in the database' });
      continue;
    }
    let pid = null;
    if (entry.person) {
      pid = await personId(entry.person);
      if (!pid) {
        results.push({ ...entry, status: 'skipped', reason: 'person not found in the database' });
        continue;
      }
    }

    // Read the current value first, so the guard is checked against the database
    // and not against the CSV's belief about the database.
    let current;
    try {
      if (entry.scope === 'band') {
        const rows = await sql`select * from bands where id = ${bid}`;
        current = rows.length ? rows[0][entry.column] : undefined;
      } else if (entry.scope === 'person') {
        const rows = await sql`select * from band_members where id = ${pid}`;
        current = rows.length ? rows[0][entry.column] : undefined;
      } else {
        const rows = await sql`
          select * from memberships where band_id = ${bid} and member_id = ${pid} limit 1`;
        if (!rows.length) {
          results.push({ ...entry, status: 'skipped', reason: 'membership not found' });
          continue;
        }
        current = rows[0][entry.column];
      }
    } catch (err) {
      results.push({ ...entry, status: 'failed', reason: `read failed: ${err.message}` });
      continue;
    }

    if (current === undefined) {
      results.push({ ...entry, status: 'skipped', reason: `no column '${entry.column}'` });
      continue;
    }
    if (!currentMatchesExpectation(current, entry.oldValue)) {
      results.push({
        ...entry,
        status: 'skipped',
        reason: `changed since the CSV: expected '${entry.oldValue}', found '${current}'`,
      });
      continue;
    }
    if (!apply) {
      results.push({ ...entry, status: 'would-apply' });
      continue;
    }

    // The data change and its audit row commit together or not at all. An
    // unaudited edit to somebody's band is worse than a skipped one.
    //
    // Validation that can throw happens HERE, before the transaction opens, so a
    // malformed weight is reported as a refusal rather than as a rolled-back
    // transaction that looks like a database problem.
    let dataThunk;
    try {
      dataThunk = dataQueryFor(sql, entry, bid, pid);
    } catch (err) {
      results.push({ ...entry, status: 'failed', reason: err.message });
      continue;
    }
    const auditThunk = () => sql`
      insert into contributions (user_id, action, band_id, band_name, metadata)
      values (
        ${actor},
        ${ACTION_FOR_SCOPE[entry.scope]},
        ${String(bid)},
        ${entry.band},
        ${JSON.stringify({
          source: 'apply-enrichments',
          scope: entry.scope,
          field: entry.field,
          column: entry.column,
          person: entry.person,
          from: entry.oldValue,
          to: entry.newValue,
        })}
      )`;

    try {
      await commitAtomically(sql, [dataThunk, auditThunk]);
      results.push({ ...entry, status: 'applied' });
    } catch (err) {
      results.push({ ...entry, status: 'failed', reason: err.message });
    }
  }
  return results;
}

// Column names come from the frozen maps above, never from the CSV, so an
// attacker-supplied field cannot reach the SQL text. Each column is written by
// an explicit branch for the same reason -- a tagged template cannot
// parameterize an identifier.
//
// These return a THUNK rather than running the query, so commitAtomically can
// either batch them into one HTTP transaction or run them inside BEGIN/COMMIT.
// Anything that can throw (an out-of-range weight, an unroutable column) throws
// when the thunk is BUILT, not when it runs, so a refusal is reported as a
// refusal instead of as a failed transaction.
export function dataQueryFor(sql, entry, bandId, personId) {
  if (entry.scope === 'band') {
    switch (entry.column) {
      case 'years_active':
        return () => sql`update bands set years_active = ${entry.newValue}, updated_at = now() where id = ${bandId}`;
      case 'city':
        return () => sql`update bands set city = ${entry.newValue}, updated_at = now() where id = ${bandId}`;
      case 'country':
        return () => sql`update bands set country = ${entry.newValue}, updated_at = now() where id = ${bandId}`;
      case 'genre':
        return () => sql`update bands set genre = ${entry.newValue}, updated_at = now() where id = ${bandId}`;
      default:
        throw new Error(`unroutable band column '${entry.column}'`);
    }
  }
  if (entry.scope === 'person') {
    switch (entry.column) {
      case 'instrument1':
        return () => sql`update band_members set instrument1 = ${entry.newValue}, updated_at = now() where id = ${personId}`;
      case 'instrument2':
        return () => sql`update band_members set instrument2 = ${entry.newValue}, updated_at = now() where id = ${personId}`;
      default:
        throw new Error(`unroutable person column '${entry.column}'`);
    }
  }
  const weight = Number(entry.newValue);
  // memberships.weight is `integer not null` with no CHECK, and the add-band form
  // only ever writes 1, 2 or 3. Refusing anything else keeps a malformed CSV from
  // putting a value in the column that no renderer knows how to classify.
  if (![1, 2, 3].includes(weight)) {
    throw new Error(`weight must be 1, 2 or 3 — got '${entry.newValue}'`);
  }
  return () => sql`
    update memberships set weight = ${weight}
    where band_id = ${bandId} and member_id = ${personId}`;
}

export function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    enrichments: null, seed: null, actor: null,
    apply: false, fields: null, limit: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--enrichments') args.enrichments = argv[++i];
    else if (a === '--seed') args.seed = argv[++i];
    else if (a === '--actor') args.actor = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--fields') args.fields = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: apply-enrichments.mjs --enrichments <csv> --seed <csv> --actor <user-uuid>\n' +
        '                            [--apply] [--fields weight,instruments,years_active] [--limit N]\n\n' +
        'Dry run is the DEFAULT. Nothing is written without --apply.',
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.enrichments || !args.seed) {
    console.error('ERROR: --enrichments and --seed are both required');
    process.exit(1);
  }
  if (args.apply && !args.actor) {
    console.error('ERROR: --actor <user-uuid> is required to apply (the audit trail names a person)');
    process.exit(1);
  }

  const proposals = parseCsv(await readFile(args.enrichments, 'utf8'));
  const seedRows = parseCsv(await readFile(args.seed, 'utf8'));
  const { plan, skipped } = buildPlan(proposals, seedRows, { fields: args.fields });
  const work = args.limit ? plan.slice(0, args.limit) : plan;

  console.log('=== Apply enrichments ===');
  console.log(`Enrichments: ${args.enrichments}  (${proposals.length} proposals)`);
  console.log(`Seed:        ${args.seed}  (${seedRows.length} rows)`);
  console.log(`Mode:        ${args.apply ? 'APPLY (writes)' : 'dry run (no writes)'}`);
  if (args.fields) console.log(`Fields:      ${args.fields.join(', ')}`);
  console.log(`Planned writes: ${plan.length}${args.limit ? ` (limited to ${work.length})` : ''}`);
  console.log(`Skipped before touching the database: ${skipped.length}`);
  const skipReasons = {};
  for (const s of skipped) skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(skipReasons)) console.log(`   ${n} × ${reason}`);
  console.log('');

  const dbUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL is not set. Refusing to guess a connection.');
    process.exit(1);
  }

  // neon(), not Pool.
  //
  // Pool would give a real session and therefore real BEGIN/COMMIT, but it talks
  // WebSocket, and on Node 20 there is no global WebSocket and `ws` is not a
  // dependency of this project. It fails immediately and unmistakably:
  //
  //   All attempts to open a WebSocket to connect to the database failed.
  //
  // So the first attempt at fixing the atomicity gap here would have crashed on
  // the first --apply. neon()'s tagged template carries .transaction([...]),
  // which batches statements into one request the server treats as a single
  // transaction -- the same guarantee, over the transport that actually works
  // here, and with no new dependency. commitAtomically picks that path
  // automatically.
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(dbUrl);

  const results = await applyPlan(sql, work, { actor: args.actor, apply: args.apply });
  const counts = summarize(results);
  console.log('=== Result ===');
  for (const [status, n] of Object.entries(counts)) console.log(`  ${status}: ${n}`);

  const notable = results.filter(r => r.status === 'skipped' || r.status === 'failed');
  if (notable.length) {
    console.log('\nSkipped / failed:');
    for (const r of notable.slice(0, 40)) {
      console.log(`  ${r.band}${r.person ? ` / ${r.person}` : ''} ${r.field}: ${r.reason}`);
    }
    if (notable.length > 40) console.log(`  … and ${notable.length - 40} more`);
  }
  if (!args.apply) console.log('\nDry run. Re-run with --apply --actor <user-uuid> to write.');
}

// Only run as a CLI, never on import. ingest-batch.mjs calls main() at import
// time, which is why its own functions cannot be unit-tested at all.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('\nFATAL:', err);
    process.exit(1);
  });
}
