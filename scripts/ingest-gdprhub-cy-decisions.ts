#!/usr/bin/env tsx
/**
 * GDPRhub Cyprus DPA Decisions Ingestion Adapter
 *
 * Fetches Cyprus Data Protection Commissioner enforcement decisions from
 * the GDPRhub MediaWiki API and writes them into the `agency_guidance`
 * table of the Cyprus premium SQLite database.
 *
 * Source: https://gdprhub.eu — Category:Commissioner_(Cyprus)
 * License: CC BY-SA 4.0 (community-curated, provenance tier "amber")
 * Expected volume: ~33 decision pages
 *
 * Prerequisites:
 *   1. npm run build:db           -- base database with schema
 *   2. npm run build:db:paid      -- premium tables + provenance columns
 *
 * Usage:
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-gdprhub-cy-decisions.ts [options]
 *
 * Options:
 *   --db <path>   Path to the SQLite database (default: data/database.db)
 *   --dry-run     List decisions without writing to the database
 *   --limit N     Process only the first N decisions
 *
 * Examples:
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-gdprhub-cy-decisions.ts --dry-run
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-gdprhub-cy-decisions.ts --db /data/premium-dbs/cy/database.db
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-gdprhub-cy-decisions.ts --limit 5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/database.db');
const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ingest-gdprhub-cy.log');

const GDPRHUB_API = 'https://gdprhub.eu/api.php';
const GDPRHUB_PAGE_BASE = 'https://gdprhub.eu/index.php?title=';
const CATEGORY = 'Category:Commissioner_(Cyprus)';
const REQUEST_DELAY_MS = 1000;  // 1 s between API calls — be polite
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT = 'Cypriot-Law-MCP/1.0.0 (premium-ingestion)';

const AGENCY_NAME = 'Commissioner for Personal Data Protection (Cyprus)';
const LICENSE_ID = 'CC-BY-SA-4.0';
const PROVENANCE_TIER = 'amber';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CategoryMember {
  pageid: number;
  ns: number;
  title: string;
}

interface ParsedDecision {
  document_id: string;
  title: string;
  summary: string | null;
  full_text: string;
  issued_date: string | null;
  url: string;
  gdpr_articles: string | null;
  outcome: string | null;
  fine: string | null;
  page_id: number;
}

interface IngestionStats {
  pages_listed: number;
  pages_fetched: number;
  pages_inserted: number;
  pages_skipped: number;
  pages_failed: number;
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
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, logMessage);
}

function logError(message: string, error?: Error): void {
  const timestamp = new Date().toISOString();
  const errorDetails = error ? `\n  Error: ${error.message}` : '';
  const logMessage = `[${timestamp}] ERROR: ${message}${errorDetails}\n`;
  console.error(logMessage.trim());
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, logMessage);
}

// ─────────────────────────────────────────────────────────────────────────────
// Network helpers
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url: string, retries = MAX_RETRIES): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      log(`  Retry ${attempt}/${retries - 1} after ${backoff} ms...`);
      await delay(backoff);
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries - 1) {
        log(`  Request failed: ${lastError.message}`);
      }
    }
  }

  throw lastError || new Error('Unknown fetch error');
}

// ─────────────────────────────────────────────────────────────────────────────
// MediaWiki API: list category members
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all pages in Category:Commissioner_(Cyprus). Handles continuation
 * tokens for categories larger than the per-request limit.
 */
async function listCategoryMembers(): Promise<CategoryMember[]> {
  const members: CategoryMember[] = [];
  let cmcontinue: string | undefined;

  do {
    const params = new URLSearchParams({
      action: 'query',
      list: 'categorymembers',
      cmtitle: CATEGORY,
      cmlimit: '50',
      cmtype: 'page',
      format: 'json',
    });

    if (cmcontinue) {
      params.set('cmcontinue', cmcontinue);
    }

    const url = `${GDPRHUB_API}?${params.toString()}`;
    const data = await fetchJson(url) as Record<string, unknown>;

    const query = data.query as Record<string, unknown> | undefined;
    if (!query || !Array.isArray(query.categorymembers)) {
      throw new Error('Unexpected API response: missing query.categorymembers');
    }

    const batch = query.categorymembers as CategoryMember[];
    members.push(...batch);

    // Check for continuation
    const cont = data.continue as Record<string, string> | undefined;
    cmcontinue = cont?.cmcontinue;

    if (cmcontinue) {
      await delay(REQUEST_DELAY_MS);
    }
  } while (cmcontinue);

  return members;
}

// ─────────────────────────────────────────────────────────────────────────────
// MediaWiki API: fetch page wikitext
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPageWikitext(title: string): Promise<{ wikitext: string; pageid: number }> {
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
  });

  const url = `${GDPRHUB_API}?${params.toString()}`;
  const data = await fetchJson(url) as Record<string, unknown>;

  const parse = data.parse as Record<string, unknown> | undefined;
  if (!parse) {
    throw new Error(`No parse result for "${title}"`);
  }

  const pageid = parse.pageid as number;
  const wikitextObj = parse.wikitext as Record<string, string> | undefined;
  const wikitext = wikitextObj?.['*'];

  if (typeof wikitext !== 'string') {
    throw new Error(`No wikitext content for "${title}"`);
  }

  return { wikitext, pageid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wikitext parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a template parameter value from wikitext.
 * Matches lines like: |Date=01/07/2019
 */
function extractParam(wikitext: string, paramName: string): string | null {
  // Match |ParamName= followed by value up to next | or }} or newline with |
  const escapedName = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\|\\s*${escapedName}\\s*=\\s*([^\\n|}]+)`, 'i');
  const match = wikitext.match(regex);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

/**
 * Parse a date string in DD/MM/YYYY or YYYY-MM-DD format to ISO date (YYYY-MM-DD).
 */
function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // DD/MM/YYYY
  const dmy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }

  // YYYY-MM-DD (already ISO)
  const iso = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
  if (iso) return trimmed;

  // Partial: YYYY or YYYY-MM
  const partial = trimmed.match(/^\d{4}(-\d{2})?$/);
  if (partial) return trimmed;

  return null;
}

/**
 * Extract a wikitext section by heading name.
 * Returns the content between the named == heading == and the next == heading ==.
 */
function extractSection(wikitext: string, sectionName: string): string | null {
  // Match == Section Name == (with optional whitespace and variable heading levels)
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `={2,}\\s*${escapedName}\\s*={2,}\\s*\\n([\\s\\S]*?)(?=\\n={2,}\\s*[^=]|$)`,
    'i'
  );
  const match = wikitext.match(regex);
  if (!match) return null;

  const content = cleanWikitext(match[1].trim());
  return content.length > 10 ? content : null;
}

/**
 * Strip wiki markup from text: links, templates, HTML tags, references.
 */
function cleanWikitext(text: string): string {
  return text
    // Remove <ref>...</ref> and <ref ... />
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    // Convert [[link|display]] to display, [[link]] to link
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    // Convert [url display] to display
    .replace(/\[https?:\/\/[^\s\]]+ ([^\]]+)\]/g, '$1')
    // Remove bare external links [url]
    .replace(/\[https?:\/\/[^\]]+\]/g, '')
    // Remove bold/italic markers
    .replace(/'{2,3}/g, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove template calls (simple, non-nested)
    .replace(/\{\{[^}]+\}\}/g, '')
    // Collapse whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Derive a document_id from the page title.
 *
 * GDPRhub page titles follow the pattern:
 *   "Commissioner for Personal Data Protection (Cyprus) - 11.17.001.008.029"
 *
 * Extracts the reference number after the dash and produces:
 *   "cy-dpa-11.17.001.008.029"
 *
 * If no reference number is found, falls back to a slug of the full title.
 */
function deriveDocumentId(title: string): string {
  // Try to extract reference after last " - "
  const dashIdx = title.lastIndexOf(' - ');
  if (dashIdx !== -1) {
    const reference = title.substring(dashIdx + 3).trim();
    if (reference.length > 0) {
      // Sanitize: keep alphanumeric, dots, hyphens
      const sanitized = reference.replace(/[^a-zA-Z0-9.\-]/g, '_').toLowerCase();
      return `cy-dpa-${sanitized}`;
    }
  }

  // Fallback: slug the whole title
  const slug = title
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `cy-dpa-${slug}`;
}

/**
 * Build the canonical GDPRhub URL for a page.
 */
function pageUrl(title: string): string {
  return `${GDPRHUB_PAGE_BASE}${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/**
 * Parse a single GDPRhub decision page's wikitext into a structured record.
 */
function parseDecision(title: string, wikitext: string, pageid: number): ParsedDecision | null {
  // Extract template parameters
  const rawDate = extractParam(wikitext, 'Date');
  const gdprArticles = extractParam(wikitext, 'GDPR articles');
  const outcome = extractParam(wikitext, 'Outcome');
  const fine = extractParam(wikitext, 'Fine');

  // Build summary from the best available section
  const holding = extractSection(wikitext, 'Holding');
  const englishSummary = extractSection(wikitext, 'English Summary');
  const facts = extractSection(wikitext, 'Facts');
  const summary = englishSummary || holding || facts;

  // Build full text by concatenating available sections
  const sections: string[] = [];

  const factsText = extractSection(wikitext, 'Facts');
  if (factsText) sections.push(`Facts:\n${factsText}`);

  const disputeText = extractSection(wikitext, 'Dispute');
  if (disputeText) sections.push(`Dispute:\n${disputeText}`);

  const holdingText = extractSection(wikitext, 'Holding');
  if (holdingText) sections.push(`Holding:\n${holdingText}`);

  const commentText = extractSection(wikitext, 'Comment');
  if (commentText) sections.push(`Comment:\n${commentText}`);

  const furtherInfo = extractSection(wikitext, 'Further Resources');
  if (furtherInfo) sections.push(`Further Resources:\n${furtherInfo}`);

  // If no sections were found, fall back to English Summary
  if (sections.length === 0 && englishSummary) {
    sections.push(englishSummary);
  }

  // If still nothing, the page has no usable content
  if (sections.length === 0) {
    return null;
  }

  // Prepend metadata to full text
  const metaLines: string[] = [];
  if (gdprArticles) metaLines.push(`GDPR Articles: ${gdprArticles}`);
  if (outcome) metaLines.push(`Outcome: ${outcome}`);
  if (fine) metaLines.push(`Fine: ${fine}`);

  const metaBlock = metaLines.length > 0 ? metaLines.join('\n') + '\n\n' : '';
  const fullText = metaBlock + sections.join('\n\n');

  return {
    document_id: deriveDocumentId(title),
    title,
    summary,
    full_text: fullText,
    issued_date: parseDate(rawDate),
    url: pageUrl(title),
    gdpr_articles: gdprArticles,
    outcome,
    fine,
    page_id: pageid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ingestion
// ─────────────────────────────────────────────────────────────────────────────

async function ingestGdprhubCy(options: CliOptions): Promise<void> {
  const ingestionTimestamp = new Date().toISOString();

  log('GDPRhub Cyprus DPA Decisions Ingestion');
  log('='.repeat(70));
  log(`  Database:   ${options.dbPath}`);
  log(`  Dry run:    ${options.dryRun}`);
  log(`  Limit:      ${options.limit ?? 'none'}`);
  log(`  Source:      ${GDPRHUB_API}`);
  log(`  Category:   ${CATEGORY}`);
  log(`  License:    ${LICENSE_ID}`);
  log(`  Provenance: ${PROVENANCE_TIER}`);
  log('');

  // ── Step 1: List category members ─────────────────────────────────────────
  log('Listing category members...');
  let members: CategoryMember[];
  try {
    members = await listCategoryMembers();
  } catch (error) {
    logError('Failed to list category members', error as Error);
    process.exit(1);
  }

  log(`  Found ${members.length} pages in ${CATEGORY}`);

  if (options.limit && options.limit < members.length) {
    members = members.slice(0, options.limit);
    log(`  Limited to first ${options.limit} pages`);
  }

  const stats: IngestionStats = {
    pages_listed: members.length,
    pages_fetched: 0,
    pages_inserted: 0,
    pages_skipped: 0,
    pages_failed: 0,
  };

  // ── Step 2: Dry-run preview ───────────────────────────────────────────────
  if (options.dryRun) {
    log('');
    log('DRY RUN — listing pages that would be ingested:');
    for (const member of members) {
      log(`  [${member.pageid}] ${member.title}`);
      log(`    URL: ${pageUrl(member.title)}`);
      log(`    document_id: ${deriveDocumentId(member.title)}`);
    }
    log('');
    log(`Total: ${members.length} pages would be processed`);
    log('No database changes made.');
    return;
  }

  // ── Step 3: Open database ─────────────────────────────────────────────────
  if (!fs.existsSync(options.dbPath)) {
    logError(`Database not found at ${options.dbPath}. Run build:db and build:db:paid first.`);
    process.exit(1);
  }

  const db = new Database(options.dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // Verify agency_guidance table with provenance columns
  const tableInfo = db.prepare("PRAGMA table_info('agency_guidance')").all() as Array<{ name: string }>;
  const columnNames = new Set(tableInfo.map(c => c.name));
  const requiredColumns = ['source_uri', 'license_identifier', 'ingestion_timestamp', 'source_record_id', 'provenance_tier'];
  const missingColumns = requiredColumns.filter(c => !columnNames.has(c));

  if (missingColumns.length > 0) {
    logError(`agency_guidance table is missing provenance columns: ${missingColumns.join(', ')}. Run build:db:paid first.`);
    db.close();
    process.exit(1);
  }

  // Prepare insert statement
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO agency_guidance (
      agency, document_id, title, summary, full_text,
      issued_date, url, related_statute_id,
      source_uri, license_identifier, ingestion_timestamp,
      source_record_id, provenance_tier
    ) VALUES (
      @agency, @document_id, @title, @summary, @full_text,
      @issued_date, @url, @related_statute_id,
      @source_uri, @license_identifier, @ingestion_timestamp,
      @source_record_id, @provenance_tier
    )
  `);

  // ── Step 4: Fetch and insert each page ────────────────────────────────────
  log('');
  log('Fetching and ingesting decisions...');

  for (let i = 0; i < members.length; i++) {
    const member = members[i];

    // Rate limiting — wait before each request (except the first)
    if (i > 0) {
      await delay(REQUEST_DELAY_MS);
    }

    try {
      const { wikitext, pageid } = await fetchPageWikitext(member.title);
      stats.pages_fetched++;

      const decision = parseDecision(member.title, wikitext, pageid);

      if (!decision) {
        stats.pages_skipped++;
        log(`  [${i + 1}/${members.length}] SKIPPED: ${member.title} (no extractable content)`);
        continue;
      }

      // Insert with all provenance columns populated
      insertStmt.run({
        agency: AGENCY_NAME,
        document_id: decision.document_id,
        title: decision.title,
        summary: decision.summary,
        full_text: decision.full_text,
        issued_date: decision.issued_date,
        url: decision.url,
        related_statute_id: null,
        source_uri: decision.url,
        license_identifier: LICENSE_ID,
        ingestion_timestamp: ingestionTimestamp,
        source_record_id: String(decision.page_id),
        provenance_tier: PROVENANCE_TIER,
      });

      stats.pages_inserted++;
      log(
        `  [${i + 1}/${members.length}] INSERTED: ${decision.document_id}` +
        `${decision.issued_date ? ` (${decision.issued_date})` : ''}`
      );

    } catch (error) {
      stats.pages_failed++;
      logError(`  [${i + 1}/${members.length}] FAILED: ${member.title}`, error as Error);
    }
  }

  // ── Step 5: Rebuild FTS index ─────────────────────────────────────────────
  log('');
  log('Rebuilding agency_guidance_fts index...');
  try {
    // Check if the FTS table exists before rebuilding
    const ftsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agency_guidance_fts'"
    ).get();

    if (ftsExists) {
      db.exec("INSERT INTO agency_guidance_fts(agency_guidance_fts) VALUES('rebuild')");
      log('  FTS index rebuilt.');
    } else {
      log('  FTS table agency_guidance_fts not found — skipping rebuild.');
    }
  } catch (error) {
    logError('FTS rebuild failed', error as Error);
  }

  // ── Step 6: Optimize and close ────────────────────────────────────────────
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('ANALYZE');
  db.close();

  // ── Step 7: Summary report ────────────────────────────────────────────────
  log('');
  log('='.repeat(70));
  log('GDPRhub Cyprus DPA Decisions Ingestion Complete');
  log('='.repeat(70));
  log(`  Pages listed:    ${stats.pages_listed}`);
  log(`  Pages fetched:   ${stats.pages_fetched}`);
  log(`  Pages inserted:  ${stats.pages_inserted}`);
  log(`  Pages skipped:   ${stats.pages_skipped}`);
  log(`  Pages failed:    ${stats.pages_failed}`);
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
      }
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--limit':
        options.limit = parseInt(args[++i], 10);
        if (isNaN(options.limit) || options.limit <= 0) {
          console.error('Error: --limit must be a positive number');
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        console.error('');
        console.error('Usage: npx tsx scripts/premium-ingestion/cypriot/ingest-gdprhub-cy-decisions.ts [options]');
        console.error('');
        console.error('Options:');
        console.error('  --db <path>   Path to the SQLite database');
        console.error('  --dry-run     List decisions without writing to the database');
        console.error('  --limit N     Process only the first N decisions');
        process.exit(1);
    }
  }

  ingestGdprhubCy(options).catch(error => {
    logError('Ingestion failed', error);
    process.exit(1);
  });
}
