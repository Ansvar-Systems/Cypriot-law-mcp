#!/usr/bin/env tsx
/**
 * Paid-tier database builder for Cyprus Law MCP server.
 *
 * ADDITIVE — does NOT rebuild from scratch. Instead:
 *   1. Verifies a base (free-tier) database exists
 *   2. Adds paid-only tables and schema extensions
 *   3. Adds provenance columns to all premium and base tables
 *   4. Updates db_metadata to reflect the premium tier
 *
 * The full build pipeline for paid tier is:
 *   npm run build:db                   # Step 1: Build base from seeds
 *   npm run build:db:paid              # Step 2: Add paid tables + provenance + metadata
 *   npm run ingest:case-law            # Step 3: Ingest case law
 *   npm run ingest:agency-guidance     # Step 4: Ingest agency guidance
 *
 * Usage:
 *   npm run build:db:paid
 *   tsx build-db-paid.ts --db /path/to/database.db
 *
 * NOTE: The agency_guidance table already exists in the Cyprus DB (47,552 rows
 * of Greek legislative texts from HuggingFace, currently mislabeled as Cypriot).
 * This script adds provenance columns to that table via ALTER TABLE so ingestion
 * pipelines can track and correct the provenance of those rows.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Accept --db flag for path override
const args = process.argv.slice(2);
const dbFlagIdx = args.indexOf('--db');
const DB_PATH = dbFlagIdx !== -1 && args[dbFlagIdx + 1]
  ? path.resolve(args[dbFlagIdx + 1])
  : path.resolve(__dirname, '../data/database.db');

// ─────────────────────────────────────────────────────────────────────────────
// Provenance columns added to all premium and base tables
//
// - source_uri          URL or API endpoint the record was fetched from
// - license_identifier  SPDX-style license string (e.g. "CC-BY-SA-4.0")
// - ingestion_timestamp ISO 8601 timestamp of when the record was ingested
// - source_record_id    Upstream identifier (e.g. MediaWiki page ID, CELEX number)
// - provenance_tier     "blue" (verbatim official) | "amber" (community-curated) | "gray" (inferred)
// ─────────────────────────────────────────────────────────────────────────────

const PROVENANCE_COLUMNS = [
  'source_uri TEXT',
  'license_identifier TEXT',
  'ingestion_timestamp TEXT',
  'source_record_id TEXT',
  'provenance_tier TEXT',
];

// ─────────────────────────────────────────────────────────────────────────────
// Paid-tier schema extensions
// ─────────────────────────────────────────────────────────────────────────────

const PAID_SCHEMA = `
-- Full-text case law opinions (paid tier)
-- Companion table to case_law; one row per opinion.
CREATE TABLE IF NOT EXISTS case_law_full (
  id                  INTEGER PRIMARY KEY,
  case_law_id         INTEGER NOT NULL REFERENCES case_law(id),
  full_text           TEXT    NOT NULL,
  headnotes           TEXT,
  dissenting_opinions TEXT,
  source_uri          TEXT,
  license_identifier  TEXT,
  ingestion_timestamp TEXT,
  source_record_id    TEXT,
  provenance_tier     TEXT,
  UNIQUE(case_law_id)
);

CREATE INDEX IF NOT EXISTS idx_case_law_full_case
  ON case_law_full(case_law_id);

-- FTS5 for case law search (covers base case_law table)
CREATE VIRTUAL TABLE IF NOT EXISTS case_law_fts USING fts5(
  case_number, summary, keywords,
  content='case_law',
  content_rowid='id',
  tokenize='unicode61'
);

-- Full-text preparatory works (paid tier)
-- Companion table to preparatory_works; one row per document.
CREATE TABLE IF NOT EXISTS preparatory_works_full (
  id                  INTEGER PRIMARY KEY,
  prep_work_id        INTEGER NOT NULL REFERENCES preparatory_works(id),
  full_text           TEXT    NOT NULL,
  section_summaries   TEXT,
  source_uri          TEXT,
  license_identifier  TEXT,
  ingestion_timestamp TEXT,
  source_record_id    TEXT,
  provenance_tier     TEXT,
  UNIQUE(prep_work_id)
);

CREATE INDEX IF NOT EXISTS idx_prep_works_full_prep
  ON preparatory_works_full(prep_work_id);

-- Agency guidance documents (paid tier)
-- CREATE IF NOT EXISTS is a no-op when the table already exists (47,552 rows
-- from HuggingFace load). Provenance columns are added separately via ALTER TABLE.
CREATE TABLE IF NOT EXISTS agency_guidance (
  id                 INTEGER PRIMARY KEY,
  agency             TEXT    NOT NULL,
  document_id        TEXT    NOT NULL UNIQUE,
  title              TEXT    NOT NULL,
  summary            TEXT,
  full_text          TEXT,
  issued_date        TEXT,
  url                TEXT,
  related_statute_id TEXT REFERENCES legal_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_agency_guidance_agency
  ON agency_guidance(agency);
CREATE INDEX IF NOT EXISTS idx_agency_guidance_statute
  ON agency_guidance(related_statute_id);

-- FTS5 for agency guidance search
CREATE VIRTUAL TABLE IF NOT EXISTS agency_guidance_fts USING fts5(
  title, summary, full_text,
  content='agency_guidance',
  content_rowid='id',
  tokenize='unicode61'
);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Official-source schema (Phase A — CY program spec §4.2)
//
// Tables for official Cyprus government data sources:
//   - Cyprus Gazette (Official Journal): issues + provisions + FTS5 index
//   - Supreme Court of Cyprus judgments + FTS5 index
//   - ECtHR cases via HUDOC API + FTS5 index
//   - data.gov.cy open dataset catalogue
//
// FTS5 virtual tables use content= + content_rowid= for external-content mode.
// Triggers to keep FTS in sync are added by each per-source ingest adapter,
// not here, to keep this DDL idempotent on re-runs.
// ─────────────────────────────────────────────────────────────────────────────

const OFFICIAL_SOURCE_TABLES = `
-- Cyprus Gazette (Official Journal) issues
CREATE TABLE IF NOT EXISTS gazette_issues (
  id               INTEGER PRIMARY KEY,
  year             INTEGER NOT NULL,
  issue_number     INTEGER NOT NULL,
  annex            TEXT    NOT NULL CHECK(annex IN ('I','II','III','IV','V')),
  publication_date TEXT,
  source_url       TEXT,
  pdf_path         TEXT,
  pdf_sha256       TEXT,
  page_count       INTEGER,
  UNIQUE(year, issue_number, annex)
);

-- Individual legal provisions extracted from gazette issues
CREATE TABLE IF NOT EXISTS gazette_provisions (
  id                 INTEGER PRIMARY KEY,
  issue_id           INTEGER NOT NULL REFERENCES gazette_issues(id),
  page_start         INTEGER,
  page_end           INTEGER,
  section_identifier TEXT,
  text               TEXT
);

CREATE INDEX IF NOT EXISTS idx_gazette_provisions_issue
  ON gazette_provisions(issue_id);

-- FTS5 index for gazette provision text search
CREATE VIRTUAL TABLE IF NOT EXISTS gazette_provisions_fts USING fts5(
  text,
  content='gazette_provisions',
  content_rowid='id',
  tokenize='unicode61'
);

-- Supreme Court of Cyprus judgments
CREATE TABLE IF NOT EXISTS supreme_court_judgments (
  id             INTEGER PRIMARY KEY,
  case_number    TEXT    NOT NULL UNIQUE,
  court_division TEXT,
  judgment_date  TEXT,
  parties        TEXT,
  full_text      TEXT,
  source_url     TEXT,
  content_sha256 TEXT
);

CREATE INDEX IF NOT EXISTS idx_supreme_court_date
  ON supreme_court_judgments(judgment_date);

-- FTS5 index for Supreme Court judgment full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS supreme_court_judgments_fts USING fts5(
  full_text,
  content='supreme_court_judgments',
  content_rowid='id',
  tokenize='unicode61'
);

-- ECtHR cases from HUDOC API (Cyprus as respondent state)
CREATE TABLE IF NOT EXISTS hudoc_cases (
  id                INTEGER PRIMARY KEY,
  hudoc_case_number TEXT NOT NULL UNIQUE,
  judgment_date     TEXT,
  respondent_states TEXT,
  articles_cited    TEXT,
  full_text         TEXT,
  outcome           TEXT
);

CREATE INDEX IF NOT EXISTS idx_hudoc_date
  ON hudoc_cases(judgment_date);

-- FTS5 index for HUDOC case full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS hudoc_cases_fts USING fts5(
  full_text,
  content='hudoc_cases',
  content_rowid='id',
  tokenize='unicode61'
);

-- Open dataset catalogue from data.gov.cy
CREATE TABLE IF NOT EXISTS data_gov_cy_datasets (
  id                INTEGER PRIMARY KEY,
  dataset_id        TEXT NOT NULL UNIQUE,
  title             TEXT,
  category          TEXT,
  publisher         TEXT,
  format            TEXT,
  source_url        TEXT,
  records_extracted INTEGER
);

CREATE INDEX IF NOT EXISTS idx_data_gov_cy_category
  ON data_gov_cy_datasets(category);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add provenance columns to a table. SQLite does not support ALTER TABLE ADD
 * COLUMN IF NOT EXISTS, so each addition is wrapped in a try/catch. Errors
 * from a "duplicate column name" are silently swallowed; all others re-throw.
 */
function addProvenanceColumns(db: Database.Database, table: string): void {
  for (const colDef of PROVENANCE_COLUMNS) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) {
        throw err;
      }
      // Column already present — safe to continue.
    }
  }
}

/**
 * Return true if the named table exists in the database.
 */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return row !== undefined;
}

/**
 * Return the row count for a table, or null if the table does not exist.
 */
function rowCount(db: Database.Database, table: string): number | null {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  return row.c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

function buildPaidTier(): void {
  console.log('Building paid-tier extensions for Cyprus Law MCP...\n');

  // Verify base database exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(
      `ERROR: No base database found at ${DB_PATH}\n` +
      `Run 'npm run build:db' first to create the base database from seeds.`
    );
    process.exit(1);
  }

  const sizeBefore = fs.statSync(DB_PATH).size;
  console.log(`  Base database: ${DB_PATH} (${(sizeBefore / 1024 / 1024).toFixed(1)} MB)`);

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // Verify base schema exists
  if (!tableExists(db, 'legal_documents')) {
    console.error('ERROR: Base database is missing legal_documents table. Rebuild with: npm run build:db');
    db.close();
    process.exit(1);
  }

  // Ensure db_metadata exists (databases built before metadata was introduced)
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // ── Step 1: Create paid-tier tables ────────────────────────────────────────
  console.log('  Adding paid-tier schema extensions...');
  db.exec(PAID_SCHEMA);
  db.exec(OFFICIAL_SOURCE_TABLES);

  // ── Step 2: Provenance columns on base tables (case_law, preparatory_works) ─
  // These tables may be empty stubs at this stage; columns are added regardless
  // so ingestion scripts can write provenance data immediately.
  console.log('  Adding provenance columns to base tables...');
  for (const baseTable of ['case_law', 'preparatory_works']) {
    if (tableExists(db, baseTable)) {
      addProvenanceColumns(db, baseTable);
      console.log(`    ${baseTable}: provenance columns applied`);
    } else {
      console.log(`    ${baseTable}: table not present (skipped)`);
    }
  }

  // ── Step 3: Provenance columns on premium full-text tables ─────────────────
  // case_law_full and preparatory_works_full were created above with provenance
  // columns inline; ALTER TABLE here is for idempotency on re-runs.
  console.log('  Adding provenance columns to premium full-text tables...');
  for (const premiumTable of ['case_law_full', 'preparatory_works_full']) {
    addProvenanceColumns(db, premiumTable);
    console.log(`    ${premiumTable}: provenance columns applied`);
  }

  // ── Step 4: Provenance columns on agency_guidance ──────────────────────────
  // The table already holds 47,552 rows loaded from HuggingFace. Columns are
  // added here; existing rows will have NULL provenance until the ingest script
  // backfills them. NULL provenance_tier signals "unaudited" to the tool layer.
  console.log('  Adding provenance columns to agency_guidance (existing table)...');
  addProvenanceColumns(db, 'agency_guidance');
  console.log(`    agency_guidance: provenance columns applied`);

  // ── Step 5: Provenance columns on official-source tables ───────────────────
  // FTS5 virtual tables are excluded — provenance lives on the parent tables.
  console.log('  Adding provenance columns to official-source tables...');
  for (const officialTable of [
    'gazette_issues',
    'gazette_provisions',
    'supreme_court_judgments',
    'hudoc_cases',
    'data_gov_cy_datasets',
  ]) {
    addProvenanceColumns(db, officialTable);
    console.log(`    ${officialTable}: provenance columns applied`);
  }

  // ── Step 6: Row count report ───────────────────────────────────────────────
  console.log('\n  Base data:');
  const freeTables: Array<[string, string]> = [
    ['legal_documents',  'Legal documents  '],
    ['legal_provisions', 'Legal provisions '],
    ['definitions',      'Definitions      '],
  ];
  for (const [table, label] of freeTables) {
    const n = rowCount(db, table);
    console.log(`    ${label}: ${n !== null ? n.toLocaleString() : 'table not found'}`);
  }

  const paidTableNames = ['case_law_full', 'preparatory_works_full', 'agency_guidance'];
  console.log('\n  Paid-tier tables:');
  for (const table of paidTableNames) {
    const n = rowCount(db, table);
    console.log(`    ${table}: ${n !== null ? n.toLocaleString() : 'table not found'}`);
  }

  // ── Step 7: Update metadata ────────────────────────────────────────────────
  const upsertMeta = db.prepare(`
    INSERT INTO db_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const updateMeta = db.transaction(() => {
    upsertMeta.run('tier',           'premium');
    upsertMeta.run('schema_version', '2');
    upsertMeta.run('built_at',       new Date().toISOString());
    upsertMeta.run('builder',        'build-db-paid.ts');
    upsertMeta.run('paid_tables',    paidTableNames.join(','));
  });
  updateMeta();

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('ANALYZE');
  db.close();

  const sizeAfter = fs.statSync(DB_PATH).size;
  console.log(
    `\nPaid-tier build complete.` +
    `\n  Size:   ${(sizeBefore / 1024 / 1024).toFixed(1)} MB -> ${(sizeAfter / 1024 / 1024).toFixed(1)} MB` +
    `\n  Tier:   premium` +
    `\n  Output: ${DB_PATH}`
  );

  console.log(`\n  NOTE: Paid-tier tables require separate ingestion runs:`);
  console.log(`    1. agency_guidance       -- npm run ingest:agency-guidance`);
  console.log(`         (47,552 existing rows need provenance backfill)`);
  console.log(`    2. case_law_full         -- npm run ingest:case-law`);
  console.log(`         (source: Supreme Court of Cyprus / ECHR-OD; see sources.yml)`);
  console.log(`    3. preparatory_works_full -- npm run ingest:prep-works`);
  console.log(`         (source: Parliament of Cyprus; currently blocked — see sources.yml)`);
}

buildPaidTier();
