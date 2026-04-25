#!/usr/bin/env tsx
/**
 * HuggingFace Corpus Removal for Cyprus Premium DB
 *
 * The Cyprus premium database contains ~47,552 agency_guidance rows loaded from
 * HuggingFace AI-team-UoA/greek_legal_code. These are Greek (Hellenic Republic)
 * legislative texts from the Raptarchis code (1834-2015), NOT Cypriot law. They
 * were loaded during initial premium DB construction without provenance metadata.
 *
 * These rows must be REMOVED, not retagged. A Cypriot-law DB must not carry
 * Greek Republic legislation — customers querying Cyprus law would get Greek
 * results regardless of provenance tier. FTS5 searches all rows.
 *
 * This script:
 *   1. Identifies mislabeled rows (provenance_tier IS NULL, agency is not a
 *      known Cyprus/CySEC source)
 *   2. DELETEs them in a single transaction
 *   3. Rebuilds FTS indexes to purge stale entries
 *   4. VACUUMs the database to reclaim space
 *   5. Reports before/after counts
 *
 * Prerequisites:
 *   1. npm run build:db           -- base database
 *   2. npm run build:db:paid      -- provenance columns added
 *
 * Usage:
 *   npx tsx scripts/premium-ingestion/cypriot/retag-huggingface-corpus.ts [options]
 *
 * Options:
 *   --db <path>   Path to the SQLite database (default: data/database.db)
 *   --dry-run     Show what would be deleted without writing
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/database.db');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CliOptions {
  dbPath: string;
  dryRun: boolean;
}

interface CountRow {
  c: number;
}

interface AgencyRow {
  agency: string;
  cnt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHERE clauses for identifying HuggingFace rows in both states:
//
// PASS 1 — never-tagged rows (original load, no prior migration):
//   provenance_tier IS NULL, agency is not a Cypriot source
//
// PASS 2 — already-retagged rows (old retag script ran before this fix):
//   provenance_tier = 'gray', agency starts with '[Hellenic Republic]',
//   source_uri points to the HuggingFace dataset
// ─────────────────────────────────────────────────────────────────────────────

const HUGGINGFACE_SOURCE_URI = 'https://huggingface.co/datasets/AI-team-UoA/greek_legal_code';

const WHERE_NEVER_TAGGED = `
  provenance_tier IS NULL
  AND agency NOT LIKE '%Cyprus%'
  AND agency NOT LIKE '%CySEC%'
`;

const WHERE_OLD_RETAG = `
  provenance_tier = 'gray'
  AND agency LIKE '[Hellenic Republic]%'
  AND source_uri = '${HUGGINGFACE_SOURCE_URI}'
`;

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function run(options: CliOptions): void {
  console.log('HuggingFace Corpus Removal (Greek texts from Cypriot DB)');
  console.log('======================================================================');
  console.log(`  Database:   ${options.dbPath}`);
  console.log(`  Dry run:    ${options.dryRun}`);
  console.log(`  Operation:  DELETE (not retag)`);
  console.log('');

  // ── Verify database exists ────────────────────────────────────────────────

  if (!fs.existsSync(options.dbPath)) {
    console.error(`ERROR: Database not found at ${options.dbPath}`);
    console.error('Run build:db and build:db:paid first.');
    process.exit(1);
  }

  const sizeBefore = fs.statSync(options.dbPath).size;
  const db = new Database(options.dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // ── Count affected rows (both passes) ──────────────────────────────────────

  const totalRow = db.prepare('SELECT COUNT(*) as c FROM agency_guidance').get() as CountRow;
  const neverTaggedRow = db.prepare(
    `SELECT COUNT(*) as c FROM agency_guidance WHERE ${WHERE_NEVER_TAGGED}`
  ).get() as CountRow;
  const oldRetagRow = db.prepare(
    `SELECT COUNT(*) as c FROM agency_guidance WHERE ${WHERE_OLD_RETAG}`
  ).get() as CountRow;

  const totalCount = totalRow.c;
  const neverTaggedCount = neverTaggedRow.c;
  const oldRetagCount = oldRetagRow.c;
  const affectedCount = neverTaggedCount + oldRetagCount;

  console.log('Before removal:');
  console.log(`  Total agency_guidance rows:   ${totalCount.toLocaleString()}`);
  console.log(`  Pass 1 (never-tagged):        ${neverTaggedCount.toLocaleString()}`);
  console.log(`  Pass 2 (old retag fingerprint): ${oldRetagCount.toLocaleString()}`);
  console.log(`  Total to remove:              ${affectedCount.toLocaleString()}`);
  console.log(`  Rows that will be kept:       ${(totalCount - affectedCount).toLocaleString()}`);

  // Show agency breakdown of rows being removed (pass 1 only — pass 2 are all [Hellenic Republic])
  if (neverTaggedCount > 0) {
    const agencyBreakdown = db.prepare(`
      SELECT agency, COUNT(*) as cnt
      FROM agency_guidance
      WHERE ${WHERE_NEVER_TAGGED}
      GROUP BY agency
      ORDER BY cnt DESC
      LIMIT 15
    `).all() as AgencyRow[];

    if (agencyBreakdown.length > 0) {
      console.log('  Pass 1 agencies being removed (top 15):');
      for (const row of agencyBreakdown) {
        console.log(`    ${row.agency}: ${row.cnt.toLocaleString()}`);
      }
    }
  }

  console.log('');

  if (affectedCount === 0) {
    console.log('No mislabeled rows found. Either removal has already run or no');
    console.log('HuggingFace rows are present.');
    db.close();
    return;
  }

  // ── Dry run ───────────────────────────────────────────────────────────────

  if (options.dryRun) {
    console.log('DRY RUN — no changes made.');
    console.log(`Would DELETE ${affectedCount.toLocaleString()} rows from agency_guidance.`);
    console.log(`  Pass 1 (never-tagged):          ${neverTaggedCount.toLocaleString()}`);
    console.log(`  Pass 2 (old retag fingerprint): ${oldRetagCount.toLocaleString()}`);
    console.log(`Database would shrink from ${(sizeBefore / 1024 / 1024).toFixed(1)} MB after VACUUM.`);
    db.close();
    return;
  }

  // ── Execute removal (both passes in one transaction) ──────────────────────

  console.log('Executing removal...');

  const deletePass1 = db.prepare(
    `DELETE FROM agency_guidance WHERE ${WHERE_NEVER_TAGGED}`
  );
  const deletePass2 = db.prepare(
    `DELETE FROM agency_guidance WHERE ${WHERE_OLD_RETAG}`
  );

  const remove = db.transaction(() => {
    const r1 = deletePass1.run();
    const r2 = deletePass2.run();
    return { pass1: r1.changes, pass2: r2.changes };
  });

  const result = remove();
  const deletedRows = result.pass1 + result.pass2;

  console.log(`  Pass 1 (never-tagged):          ${result.pass1.toLocaleString()} deleted`);
  console.log(`  Pass 2 (old retag fingerprint): ${result.pass2.toLocaleString()} deleted`);

  // ── Rebuild FTS (fatal on failure) ────────────────────────────────────────

  console.log('Rebuilding FTS indexes...');
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agency_guidance_fts'"
  ).get();

  if (ftsExists) {
    db.exec("INSERT INTO agency_guidance_fts(agency_guidance_fts) VALUES('rebuild')");
    console.log('  agency_guidance_fts rebuilt.');
  }

  // ── Verify ────────────────────────────────────────────────────────────────

  const remainingPass1 = db.prepare(
    `SELECT COUNT(*) as c FROM agency_guidance WHERE ${WHERE_NEVER_TAGGED}`
  ).get() as CountRow;
  const remainingPass2 = db.prepare(
    `SELECT COUNT(*) as c FROM agency_guidance WHERE ${WHERE_OLD_RETAG}`
  ).get() as CountRow;

  const survivingRow = db.prepare(
    'SELECT COUNT(*) as c FROM agency_guidance'
  ).get() as CountRow;

  const remainingTotal = remainingPass1.c + remainingPass2.c;

  console.log('');
  console.log('After removal:');
  console.log(`  Rows deleted:                 ${deletedRows.toLocaleString()}`);
  console.log(`  Remaining mislabeled:         ${remainingTotal.toLocaleString()}`);
  console.log(`  Surviving agency_guidance:     ${survivingRow.c.toLocaleString()}`);

  if (remainingTotal > 0) {
    console.error('');
    console.error(`WARNING: ${remainingTotal} rows still match the removal filter.`);
    console.error('This is unexpected — investigate manually.');
  }

  // ── VACUUM and close ─────────────────────────────────────────────────────

  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('');
  console.log('Running VACUUM to reclaim space...');
  db.exec('VACUUM');

  db.close();

  const sizeAfter = fs.statSync(options.dbPath).size;
  console.log(`  Size: ${(sizeBefore / 1024 / 1024).toFixed(1)} MB -> ${(sizeAfter / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log('======================================================================');
  console.log('Removal complete.');
  console.log('======================================================================');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const isMainModule = process.argv[1] != null &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  const args = process.argv.slice(2);

  const options: CliOptions = {
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db': {
        const dbArg = args[++i];
        if (!dbArg) {
          console.error('Error: --db requires a path argument');
          process.exit(1);
        }
        options.dbPath = path.resolve(dbArg);
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        console.error('');
        console.error('Usage: npx tsx scripts/premium-ingestion/cypriot/retag-huggingface-corpus.ts [options]');
        console.error('');
        console.error('Options:');
        console.error('  --db <path>   Path to the SQLite database');
        console.error('  --dry-run     Show what would be deleted without writing');
        process.exit(1);
    }
  }

  run(options);
}
