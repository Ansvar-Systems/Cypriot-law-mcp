#!/usr/bin/env tsx
/**
 * EUR-Lex Cyprus National Implementation Measures (NIM) Ingestion Adapter
 *
 * Fetches Cyprus NIM records from the EUR-Lex SPARQL endpoint and writes them
 * into the `eu_documents` and `eu_references` tables of the Cyprus premium
 * SQLite database.
 *
 * Source: https://publications.europa.eu/webapi/rdf/sparql
 * License: EU reuse policy, Decision 2011/833/EU
 * Provenance tier: "blue" (verbatim official EU institutional source)
 * Filter: CELEX sector 7 (national measures), country code CYP
 * Expected volume: ~3,086 NIM records
 *
 * Each NIM record links a Cypriot national law to the EU directive it transposes.
 * The script produces one eu_documents row per NIM (the national measure itself)
 * and one eu_references row per NIM-to-directive link.
 *
 * Prerequisites:
 *   1. npm run build:db           -- base database with eu_documents + eu_references
 *   2. npm run build:db:paid      -- premium tables + provenance columns
 *
 * Usage:
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-eurlex-cy-nim.ts [options]
 *
 * Options:
 *   --db <path>   Path to the SQLite database (default: data/database.db)
 *   --dry-run     Fetch and display records without writing to the database
 *   --limit N     Cap the total number of NIM records fetched
 *
 * Examples:
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-eurlex-cy-nim.ts --dry-run
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-eurlex-cy-nim.ts --db /data/premium-dbs/cypriot-law/database.db
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-eurlex-cy-nim.ts --limit 50 --dry-run
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
const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ingest-eurlex-cy-nim.log');

const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';
const BATCH_SIZE = 500;
const RATE_LIMIT_MS = 500;    // 500 ms between SPARQL batch requests
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT = 'Cypriot-Law-MCP/1.0.0 (premium-ingestion)';

const SOURCE_URI = SPARQL_ENDPOINT;
const LICENSE_ID = 'EU-2011-833';
const PROVENANCE_TIER = 'blue';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface NimRecord {
  celex: string;
  title: string;
  directiveCelex: string;
  directiveTitle: string;
  date: string | null;
  eurLexUrl: string;
}

interface IngestionStats {
  batches_fetched: number;
  records_fetched: number;
  documents_inserted: number;
  documents_skipped: number;
  references_inserted: number;
  references_skipped: number;
  errors: number;
}

interface CliOptions {
  dbPath: string;
  dryRun: boolean;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(message);
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, logLine);
}

function logError(message: string, error?: Error): void {
  const errorDetails = error ? `\n  Error: ${error.message}` : '';
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ERROR: ${message}${errorDetails}\n`;
  console.error(logLine.trim());
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, logLine);
}

// ─────────────────────────────────────────────────────────────────────────────
// Network helpers
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sparqlPost(query: string, retries = MAX_RETRIES): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      log(`  Retry ${attempt}/${retries - 1} after ${backoff} ms...`);
      await delay(backoff);
    }

    try {
      const params = new URLSearchParams({
        query,
        format: 'application/sparql-results+json',
      });

      const response = await fetch(SPARQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries - 1) {
        log(`  SPARQL request failed: ${lastError.message}`);
      }
    }
  }

  throw lastError || new Error('Unknown SPARQL fetch error');
}

// ─────────────────────────────────────────────────────────────────────────────
// SPARQL query + parsing
// ─────────────────────────────────────────────────────────────────────────────

function buildSparqlQuery(offset: number, limit: number): string {
  return [
    'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
    'SELECT DISTINCT ?celex ?title ?directiveCelex ?directiveTitle ?date',
    'WHERE {',
    '  ?nim cdm:resource_legal_id_celex ?celex .',
    '  FILTER(STRSTARTS(?celex, "7") && CONTAINS(?celex, "CYP"))',
    '  ?nim cdm:resource_legal_title ?title .',
    '  FILTER(LANG(?title) = "en" || LANG(?title) = "")',
    '  ?nim cdm:resource_legal_based_on_resource_legal ?directive .',
    '  ?directive cdm:resource_legal_id_celex ?directiveCelex .',
    '  OPTIONAL { ?directive cdm:resource_legal_title ?directiveTitle . FILTER(LANG(?directiveTitle) = "en") }',
    '  OPTIONAL { ?nim cdm:resource_legal_date_document ?date . }',
    '}',
    'ORDER BY ?celex',
    `OFFSET ${offset}`,
    `LIMIT ${limit}`,
  ].join('\n');
}

interface SparqlBinding {
  celex: { value: string };
  title: { value: string };
  directiveCelex: { value: string };
  directiveTitle?: { value: string };
  date?: { value: string };
}

interface SparqlResponse {
  results: {
    bindings: SparqlBinding[];
  };
}

function parseBindings(bindings: SparqlBinding[]): NimRecord[] {
  return bindings.map(b => ({
    celex: b.celex.value,
    title: b.title.value,
    directiveCelex: b.directiveCelex.value,
    directiveTitle: b.directiveTitle?.value ?? '',
    date: b.date?.value ?? null,
    eurLexUrl: `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${b.celex.value}`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched fetch with pagination
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllNims(limit?: number): Promise<NimRecord[]> {
  const all: NimRecord[] = [];
  let offset = 0;
  let batchNumber = 0;

  while (true) {
    // If a limit is set, compute remaining capacity
    const remaining = limit != null ? limit - all.length : BATCH_SIZE;
    if (remaining <= 0) break;

    const batchLimit = Math.min(BATCH_SIZE, remaining);
    batchNumber++;
    log(`  Batch ${batchNumber}: offset=${offset}, limit=${batchLimit}...`);

    const query = buildSparqlQuery(offset, batchLimit);
    const data = await sparqlPost(query) as SparqlResponse;
    const batch = parseBindings(data.results.bindings);

    all.push(...batch);
    log(`    Received ${batch.length} records (cumulative: ${all.length})`);

    // Stop if this batch returned fewer records than requested — no more data
    if (batch.length < batchLimit) break;

    offset += batchLimit;

    // Rate limit between batches
    await delay(RATE_LIMIT_MS);
  }

  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema introspection + provenance column provisioning
// ─────────────────────────────────────────────────────────────────────────────

const PROVENANCE_COLUMNS = [
  'source_uri TEXT',
  'license_identifier TEXT',
  'ingestion_timestamp TEXT',
  'source_record_id TEXT',
  'provenance_tier TEXT',
];

/**
 * Add provenance columns to a table if they do not already exist.
 * SQLite lacks ALTER TABLE ADD COLUMN IF NOT EXISTS, so each addition
 * is tried individually — duplicate-column errors are silently swallowed.
 */
function ensureProvenanceColumns(db: Database.Database, table: string): void {
  for (const colDef of PROVENANCE_COLUMNS) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) {
        throw err;
      }
      // Column already present — continue.
    }
  }
}

/**
 * Return the set of column names present in a table.
 */
function getColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return new Set(rows.map(r => r.name));
}

/**
 * Derive a synthetic eu_documents.id from a CELEX number.
 *
 * The golden-standard schema uses a text id as primary key. For NIM records
 * (CELEX sector 7) we generate an id like "nim-72017L0110CYP-430697" from
 * the CELEX number.
 */
function nimDocumentId(celex: string): string {
  return `nim-${celex.replace(/[^a-zA-Z0-9_]/g, '-')}`;
}

/**
 * Extract year from CELEX number. CELEX sector-7 NIMs encode the directive
 * year in positions 2-5 (e.g., "72017L0110CYP..." -> 2017).
 */
function extractYear(celex: string): number | null {
  const match = celex.match(/^7(\d{4})/);
  if (match) return parseInt(match[1], 10);
  return null;
}

/**
 * Extract directive number from CELEX. E.g., "72017L0110CYP..." -> 110.
 */
function extractNumber(celex: string): number | null {
  const match = celex.match(/^7\d{4}[A-Z](\d+)/);
  if (match) return parseInt(match[1], 10);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database insertion
// ─────────────────────────────────────────────────────────────────────────────

function insertNims(
  db: Database.Database,
  nims: NimRecord[],
  ingestionTimestamp: string,
): IngestionStats {
  const stats: IngestionStats = {
    batches_fetched: 0,
    records_fetched: nims.length,
    documents_inserted: 0,
    documents_skipped: 0,
    references_inserted: 0,
    references_skipped: 0,
    errors: 0,
  };

  // Discover the actual column sets so we can adapt to either the
  // golden-standard schema or the simplified from-scratch schema.
  const docCols = getColumnNames(db, 'eu_documents');
  const refCols = getColumnNames(db, 'eu_references');

  // Determine which eu_documents schema variant we have.
  // Golden standard: id, type, year, number, community, celex_number, title,
  //                  title_nl, short_name, adoption_date, ..., url_eur_lex
  // Simplified: varies — may have document_type, source_url, etc.
  const isGoldenStandard = docCols.has('type') && docCols.has('year') && docCols.has('url_eur_lex');

  // Determine which eu_references schema variant we have.
  // Golden standard: source_type, source_id, document_id, eu_document_id, ...
  // Simplified: document_id, eu_document, eu_celex, relationship
  const refIsGoldenStandard = refCols.has('source_type') && refCols.has('eu_document_id');

  log(`  eu_documents schema: ${isGoldenStandard ? 'golden-standard' : 'simplified'}`);
  log(`  eu_references schema: ${refIsGoldenStandard ? 'golden-standard' : 'simplified'}`);

  // Build INSERT statements based on the discovered schema
  let insertDoc: Database.Statement;
  let insertRef: Database.Statement;

  if (isGoldenStandard) {
    insertDoc = db.prepare(`
      INSERT OR IGNORE INTO eu_documents (
        id, type, year, number, celex_number, title,
        url_eur_lex, last_updated,
        source_uri, license_identifier, ingestion_timestamp,
        source_record_id, provenance_tier
      ) VALUES (
        @id, 'decision', @year, @number, @celex_number, @title,
        @url_eur_lex, @last_updated,
        @source_uri, @license_identifier, @ingestion_timestamp,
        @source_record_id, @provenance_tier
      )
    `);
  } else {
    // Simplified schema — adapt column names
    const urlCol = docCols.has('source_url') ? 'source_url' : 'url_eur_lex';
    const typeCol = docCols.has('document_type') ? 'document_type' : 'type';

    insertDoc = db.prepare(`
      INSERT OR IGNORE INTO eu_documents (
        id, ${typeCol}, celex_number, title, ${urlCol},
        source_uri, license_identifier, ingestion_timestamp,
        source_record_id, provenance_tier
      ) VALUES (
        @id, 'NIM', @celex_number, @title, @url_eur_lex,
        @source_uri, @license_identifier, @ingestion_timestamp,
        @source_record_id, @provenance_tier
      )
    `);
  }

  if (refIsGoldenStandard) {
    insertRef = db.prepare(`
      INSERT OR IGNORE INTO eu_references (
        source_type, source_id, document_id, eu_document_id,
        reference_type, reference_context, full_citation,
        is_primary_implementation, implementation_status,
        source_uri, license_identifier, ingestion_timestamp,
        source_record_id, provenance_tier
      ) VALUES (
        'document', @source_id, @document_id, @eu_document_id,
        'implements', @reference_context, @full_citation,
        1, 'unknown',
        @source_uri, @license_identifier, @ingestion_timestamp,
        @source_record_id, @provenance_tier
      )
    `);
  } else {
    // Simplified eu_references
    insertRef = db.prepare(`
      INSERT OR IGNORE INTO eu_references (
        document_id, eu_document, eu_celex, relationship,
        source_uri, license_identifier, ingestion_timestamp,
        source_record_id, provenance_tier
      ) VALUES (
        @document_id, @eu_document_label, @eu_celex, 'implements',
        @source_uri, @license_identifier, @ingestion_timestamp,
        @source_record_id, @provenance_tier
      )
    `);
  }

  // Bulk insert inside a transaction for performance
  const insertAll = db.transaction(() => {
    for (const nim of nims) {
      try {
        const docId = nimDocumentId(nim.celex);
        const year = extractYear(nim.celex);
        const number = extractNumber(nim.celex);

        // ── Insert eu_documents row ─────────────────────────────────
        const docParams: Record<string, unknown> = {
          id: docId,
          celex_number: nim.celex,
          title: nim.title,
          url_eur_lex: nim.eurLexUrl,
          last_updated: ingestionTimestamp,
          year: year ?? 0,
          number: number ?? 0,
          source_uri: SOURCE_URI,
          license_identifier: LICENSE_ID,
          ingestion_timestamp: ingestionTimestamp,
          source_record_id: nim.celex,
          provenance_tier: PROVENANCE_TIER,
        };

        const docResult = insertDoc.run(docParams);
        if (docResult.changes > 0) {
          stats.documents_inserted++;
        } else {
          stats.documents_skipped++;
        }

        // ── Insert eu_references row ────────────────────────────────
        const refParams: Record<string, unknown> = {
          source_id: docId,
          document_id: docId,
          eu_document_id: nim.directiveCelex,
          eu_document_label: nim.directiveTitle || nim.directiveCelex,
          eu_celex: nim.directiveCelex,
          reference_context: nim.directiveTitle
            ? `Transposes: ${nim.directiveTitle}`
            : `Transposes directive ${nim.directiveCelex}`,
          full_citation: nim.directiveTitle
            ? `${nim.directiveTitle} (${nim.directiveCelex})`
            : nim.directiveCelex,
          source_uri: SOURCE_URI,
          license_identifier: LICENSE_ID,
          ingestion_timestamp: ingestionTimestamp,
          source_record_id: nim.celex,
          provenance_tier: PROVENANCE_TIER,
        };

        const refResult = insertRef.run(refParams);
        if (refResult.changes > 0) {
          stats.references_inserted++;
        } else {
          stats.references_skipped++;
        }
      } catch (error) {
        stats.errors++;
        logError(`Failed to insert NIM ${nim.celex}`, error as Error);
      }
    }
  });

  insertAll();
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ingestion
// ─────────────────────────────────────────────────────────────────────────────

async function ingestEurLexCyNim(options: CliOptions): Promise<void> {
  const ingestionTimestamp = new Date().toISOString();

  log('EUR-Lex Cyprus NIM Ingestion');
  log('='.repeat(70));
  log(`  Database:    ${options.dbPath}`);
  log(`  Dry run:     ${options.dryRun}`);
  log(`  Limit:       ${options.limit ?? 'none'}`);
  log(`  Source:       ${SPARQL_ENDPOINT}`);
  log(`  License:     ${LICENSE_ID}`);
  log(`  Provenance:  ${PROVENANCE_TIER}`);
  log(`  Batch size:  ${BATCH_SIZE}`);
  log(`  Rate limit:  ${RATE_LIMIT_MS} ms`);
  log('');

  // ── Step 1: Fetch all NIM records via paginated SPARQL ────────────────────
  log('Fetching NIM records from EUR-Lex SPARQL endpoint...');
  let nims: NimRecord[];
  try {
    nims = await fetchAllNims(options.limit);
  } catch (error) {
    logError('Failed to fetch NIM records from SPARQL endpoint', error as Error);
    process.exit(1);
  }

  log(`Fetched ${nims.length} NIM records total`);

  if (nims.length === 0) {
    log('No NIM records found. Check SPARQL query filters.');
    return;
  }

  // ── Step 2: Dry-run preview ───────────────────────────────────────────────
  if (options.dryRun) {
    log('');
    log('DRY RUN — sample records that would be ingested:');
    const preview = nims.slice(0, 20);
    for (const nim of preview) {
      log(`  CELEX: ${nim.celex}`);
      log(`    Title: ${nim.title.slice(0, 100)}${nim.title.length > 100 ? '...' : ''}`);
      log(`    Directive: ${nim.directiveCelex} — ${nim.directiveTitle.slice(0, 80)}`);
      log(`    Date: ${nim.date ?? 'not available'}`);
      log(`    URL: ${nim.eurLexUrl}`);
      log('');
    }
    if (nims.length > 20) {
      log(`  ... and ${nims.length - 20} more records`);
    }
    log('');
    log(`Total: ${nims.length} NIM records would be processed`);
    log('No database changes made.');
    return;
  }

  // ── Step 3: Open database ─────────────────────────────────────────────────
  if (!fs.existsSync(options.dbPath)) {
    logError(`Database not found at ${options.dbPath}. Run build:db and build:db:paid first.`);
    process.exit(1);
  }

  const db = new Database(options.dbPath);
  db.pragma('foreign_keys = OFF');  // NIM directive CELEXes may not exist as eu_documents rows
  db.pragma('journal_mode = WAL');

  // Verify required tables exist
  for (const table of ['eu_documents', 'eu_references']) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    if (!exists) {
      logError(`Required table '${table}' not found in database. Run build:db first.`);
      db.close();
      process.exit(1);
    }
  }

  // ── Step 4: Ensure provenance columns exist on both tables ────────────────
  // The Cyprus build-db-paid.ts adds provenance to premium tables but may not
  // cover eu_documents/eu_references. Apply them here for safety — the ALTER
  // TABLE calls are idempotent (duplicate-column errors are swallowed).
  log('Ensuring provenance columns on eu_documents and eu_references...');
  ensureProvenanceColumns(db, 'eu_documents');
  ensureProvenanceColumns(db, 'eu_references');
  log('  Provenance columns verified.');

  // ── Step 5: Bulk insert inside a transaction ──────────────────────────────
  log('');
  log('Inserting NIM records...');
  const stats = insertNims(db, nims, ingestionTimestamp);

  // ── Step 6: Optimize and close ────────────────────────────────────────────
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('ANALYZE');
  db.close();

  // ── Step 7: Summary report ────────────────────────────────────────────────
  log('');
  log('='.repeat(70));
  log('EUR-Lex Cyprus NIM Ingestion Complete');
  log('='.repeat(70));
  log(`  Records fetched:       ${stats.records_fetched}`);
  log(`  Documents inserted:    ${stats.documents_inserted}`);
  log(`  Documents skipped:     ${stats.documents_skipped} (already existed)`);
  log(`  References inserted:   ${stats.references_inserted}`);
  log(`  References skipped:    ${stats.references_skipped} (already existed)`);
  log(`  Errors:                ${stats.errors}`);
  log('='.repeat(70));

  const dbSize = fs.statSync(options.dbPath).size;
  log(`  Database size: ${(dbSize / 1024 / 1024).toFixed(1)} MB`);
  log(`  Log file: ${LOG_FILE}`);
  log('');
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
      case '--limit': {
        const limitArg = args[++i];
        const parsed = parseInt(limitArg, 10);
        if (isNaN(parsed) || parsed <= 0) {
          console.error('Error: --limit must be a positive number');
          process.exit(1);
        }
        options.limit = parsed;
        break;
      }
      default:
        console.error(`Unknown option: ${args[i]}`);
        console.error('');
        console.error('Usage: npx tsx scripts/premium-ingestion/cypriot/ingest-eurlex-cy-nim.ts [options]');
        console.error('');
        console.error('Options:');
        console.error('  --db <path>   Path to the SQLite database');
        console.error('  --dry-run     Fetch and display records without writing to the database');
        console.error('  --limit N     Cap the total number of NIM records fetched');
        process.exit(1);
    }
  }

  ingestEurLexCyNim(options).catch(error => {
    logError('Ingestion failed', error);
    process.exit(1);
  });
}
