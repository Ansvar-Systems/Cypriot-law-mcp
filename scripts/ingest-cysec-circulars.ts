#!/usr/bin/env tsx
/**
 * CySEC Circulars Ingestion Adapter
 *
 * Scrapes Cyprus Securities and Exchange Commission (CySEC) circular listings
 * from www.cysec.gov.cy and writes metadata into the `agency_guidance` table
 * of the Cyprus premium SQLite database.
 *
 * CySEC circulars are PDF documents linked from category listing pages. This
 * adapter extracts: title (including reference number like "C773"), date,
 * category, and download URL. Full-text extraction from PDFs is out of scope;
 * the title and category metadata are stored as the searchable text.
 *
 * IIS header workaround: CySEC's IIS 10 server emits whitespace after HTTP
 * header values, which causes Node's strict HTTP parser to reject responses.
 * All HTTP fetches go through curl via child_process.execFile (no shell).
 *
 * Source: https://www.cysec.gov.cy/en-GB/public-info/circulars/
 * License: Government publication (no explicit open-data licence)
 * Provenance tier: amber
 *
 * Prerequisites:
 *   1. npm run build:db           -- base database with schema
 *   2. npm run build:db:paid      -- premium tables + provenance columns
 *
 * Usage:
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-cysec-circulars.ts [options]
 *
 * Options:
 *   --db <path>   Path to the SQLite database (default: data/database.db)
 *   --dry-run     List circulars without writing to the database
 *   --limit N     Process only the first N circulars (across all categories)
 *
 * Examples:
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-cysec-circulars.ts --dry-run
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-cysec-circulars.ts --db /data/premium-dbs/cy/database.db
 *   npx tsx scripts/premium-ingestion/cypriot/ingest-cysec-circulars.ts --limit 50
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/database.db');
const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ingest-cysec.log');

const BASE_URL = 'https://www.cysec.gov.cy';
const CIRCULARS_BASE = '/en-GB/public-info/circulars';
const REQUEST_DELAY_MS = 1500;  // 1.5 s between requests — be polite
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT = 'Cypriot-Law-MCP/1.0.0 (premium-ingestion)';
const CURL_TIMEOUT_SECS = 30;

const AGENCY_NAME = 'Cyprus Securities and Exchange Commission (CySEC)';
const LICENSE_ID = 'Cyprus-PSI';
const PROVENANCE_TIER = 'amber';

/**
 * CySEC circular subcategories to scrape. Each has a URL path suffix and
 * a human-readable label used in the document_id and summary.
 */
const CIRCULAR_CATEGORIES: Array<{ path: string; label: string }> = [
  { path: 'supervised/investment-firms', label: 'Investment Firms (CIF)' },
  { path: 'supervised/ucits', label: 'UCITS' },
  { path: 'supervised/aif', label: 'Alternative Investment Funds (AIF)' },
  { path: 'supervised/service-providers', label: 'Administrative Service Providers (ASP)' },
  { path: 'supervised/emir', label: 'EMIR' },
  { path: 'supervised/csd', label: 'Central Securities Depositories (CSD)' },
  { path: 'supervised/CIRCULARS-RBSF', label: 'Registrar of Beneficial Owners (RBS-F)' },
  { path: 'supervised/BENCHMARK-PROVIDERS', label: 'Benchmark Providers' },
  { path: 'supervised/Circulars-Securitisation', label: 'Securitisation' },
  { path: 'supervised/sftr-circulars', label: 'SFTR' },
  { path: 'supervised/csp-circulars', label: 'Crypto-Asset Service Providers (CASP)' },
  { path: 'supervised/mar-circulars', label: 'Market Abuse Regulation (MAR)' },
  { path: 'issuers', label: 'Issuers' },
  { path: 'certifications', label: 'Certifications' },
  { path: 'general', label: 'General' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CircularEntry {
  /** e.g. "cy-cysec-c773" */
  document_id: string;
  /** Full title from the listing, e.g. "C773 – UCITS's and AIFs' Depositaries..." */
  title: string;
  /** Circular reference extracted from title, e.g. "C773" */
  reference: string | null;
  /** ISO date string YYYY-MM-DD */
  date: string | null;
  /** Absolute URL to the PDF/file download */
  file_url: string;
  /** Category label, e.g. "Investment Firms (CIF)" */
  category: string;
  /** The listing page URL this was scraped from */
  listing_url: string;
}

interface IngestionStats {
  categories_scraped: number;
  pages_fetched: number;
  circulars_found: number;
  circulars_inserted: number;
  circulars_skipped_duplicate: number;
  fetch_errors: number;
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
// HTTP via curl (IIS header workaround)
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a URL using curl via execFile. This bypasses Node's strict HTTP
 * parser which rejects CySEC's IIS 10 responses (whitespace in headers).
 * Uses execFile (not exec) to avoid shell injection.
 */
async function fetchHtml(url: string, retries = MAX_RETRIES): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      log(`  Retry ${attempt}/${retries - 1} after ${backoff} ms...`);
      await delay(backoff);
    }

    try {
      const { stdout } = await execFile('curl', [
        '-s',                              // silent
        '-L',                              // follow redirects
        '--max-time', String(CURL_TIMEOUT_SECS),
        '-H', `User-Agent: ${USER_AGENT}`,
        '-H', 'Accept: text/html',
        url,
      ], { maxBuffer: 5 * 1024 * 1024 });  // 5 MB

      if (!stdout || stdout.length < 200) {
        throw new Error(`Response too short (${stdout?.length ?? 0} bytes) — likely an error page`);
      }

      return stdout;
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
// HTML parsing (regex-based — no jsdom needed for this CMS structure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the total number of results from the pager control.
 * Pattern: "Displaying results  1-25 (of 639)"
 * Returns null if no pager is found (single-page category).
 */
function parseTotalResults(html: string): number | null {
  const match = html.match(/Displaying results\s+\d+-\d+\s*\(of (\d+)\)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse the CySEC date format "DD Mon. YYYY" to ISO "YYYY-MM-DD".
 * Examples: "24 Apr. 2026", "03 Jan. 2025", "15 Dec. 2019"
 */
function parseCysecDate(raw: string): string | null {
  const trimmed = raw.trim();

  const monthMap: Record<string, string> = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
    'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
    'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
  };

  // "DD Mon. YYYY" or "DD Mon YYYY"
  const match = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3})\.?\s+(\d{4})$/);
  if (!match) return null;

  const day = match[1].padStart(2, '0');
  const monthKey = match[2].toLowerCase();
  const month = monthMap[monthKey];
  if (!month) return null;

  return `${match[3]}-${month}-${day}`;
}

/**
 * Extract the circular reference number from a title string.
 * CySEC circulars typically start with a reference like:
 *   "C773 – ..."
 *   "C770 CIFs regarding..."
 *   "CI146-2026-01 – ..."
 *   "EK/E 1 – ..."
 *
 * Returns null if no recognizable reference pattern is found.
 */
function extractReference(title: string): string | null {
  // Pattern 1: "C" followed by digits, optionally with suffix like "-2026-01"
  const cMatch = title.match(/^(C\d+(?:-\d+)*)\b/i);
  if (cMatch) return cMatch[1].toUpperCase();

  // Pattern 2: "CI" followed by digits
  const ciMatch = title.match(/^(CI\d+(?:-\d+)*)\b/i);
  if (ciMatch) return ciMatch[1].toUpperCase();

  // Pattern 3: "EK/E" followed by number
  const ekMatch = title.match(/^(EK\/[A-Z]\s*\d+)\b/i);
  if (ekMatch) return ekMatch[1].toUpperCase();

  // Pattern 4: Greek-prefixed references like "ΕΓ131-2014-30" (Epsilon-Gamma)
  const greekMatch = title.match(/^([^\x00-\x7F]{1,4}\d+(?:-\d+)*)\b/);
  if (greekMatch) return greekMatch[1];

  // Pattern 5: "Circular (M2006-01)" or "Circular (G2005-01)" — reference inside parens
  const parenMatch = title.match(/^Circular\s*\(([A-Z0-9][\w-]+)\)/i);
  if (parenMatch) return parenMatch[1].toUpperCase();

  // Pattern 6: any leading alphanumeric reference before a dash/colon separator
  const genericMatch = title.match(/^([A-Z][A-Z0-9/\s]{1,12}?\d+)\s*[–\-:]/);
  if (genericMatch) return genericMatch[1].trim();

  return null;
}

/**
 * Build a deterministic document_id from a circular's reference, date, and title.
 */
function buildDocumentId(reference: string | null, title: string, fileGuid: string): string {
  if (reference) {
    // Normalize reference: "C773" -> "c773", "CI146-2026-01" -> "ci146-2026-01"
    const normalized = reference
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return `cy-cysec-${normalized}`;
  }

  // Fallback: use the GUID from the file URL to guarantee uniqueness
  const guidShort = fileGuid.split('-')[0] || fileGuid.substring(0, 8);
  const titleSlug = title
    .substring(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `cy-cysec-${titleSlug}-${guidShort}`;
}

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extract circular entries from a single category listing page HTML.
 *
 * CySEC's Kentico CMS renders each circular as a Bootstrap card:
 *   <div class="card h-100 card-custom card-documents">
 *     <div class="card-body pb-3">
 *       <table><tr>
 *         <td><div class="text-muted">24 Apr. 2026</div></td>
 *         ...
 *       </table>
 *       <a href="/CMSPages/GetFile.aspx?guid=..." class="card-title fw-bold">
 *         C773 - Title text here
 *       </a>
 *     </div>
 *   </div>
 */
function parseCircularsFromHtml(
  html: string,
  category: string,
  listingUrl: string,
): CircularEntry[] {
  const entries: CircularEntry[] = [];

  // Split on card boundaries. Each card starts with the card-documents class.
  const cardChunks = html.split('card-custom card-documents');

  // Skip the first chunk (before the first card)
  for (let i = 1; i < cardChunks.length; i++) {
    const chunk = cardChunks[i];

    // Extract date: <div class="text-muted">DD Mon. YYYY</div>
    const dateMatch = chunk.match(
      /<div\s+class="text-muted">\s*(\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4})\s*<\/div>/
    );
    const dateRaw = dateMatch ? dateMatch[1] : null;
    const date = dateRaw ? parseCysecDate(dateRaw) : null;

    // Extract title link: <a href="..." class="card-title fw-bold"...>TITLE</a>
    const titleMatch = chunk.match(
      /<a\s+href="([^"]*)"[^>]*class="card-title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/
    );
    if (!titleMatch) continue;  // skip cards without a title link

    const relativeUrl = titleMatch[1];
    const rawTitle = titleMatch[2]
      .replace(/\s+/g, ' ')
      .trim();
    const title = decodeHtmlEntities(rawTitle);

    if (!title || title.length < 3) continue;

    // Build absolute file URL
    const fileUrl = relativeUrl.startsWith('http')
      ? relativeUrl
      : `${BASE_URL}${relativeUrl}`;

    // Extract GUID from the GetFile.aspx URL for deduplication
    const guidMatch = relativeUrl.match(/guid=([a-f0-9-]+)/i);
    const fileGuid = guidMatch ? guidMatch[1] : '';

    const reference = extractReference(title);
    const document_id = buildDocumentId(reference, title, fileGuid);

    entries.push({
      document_id,
      title,
      reference,
      date,
      file_url: fileUrl,
      category,
      listing_url: listingUrl,
    });
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category scraping with pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrape all circulars from a single category, handling pagination.
 * Returns the list of circular entries found.
 */
async function scrapeCategory(
  categoryPath: string,
  categoryLabel: string,
  stats: IngestionStats,
  limit?: number,
): Promise<CircularEntry[]> {
  const allEntries: CircularEntry[] = [];
  let page = 1;

  while (true) {
    // Check limit
    if (limit !== undefined && allEntries.length >= limit) break;

    const url = page === 1
      ? `${BASE_URL}${CIRCULARS_BASE}/${categoryPath}/`
      : `${BASE_URL}${CIRCULARS_BASE}/${categoryPath}/?page=${page}`;

    log(`  Fetching ${categoryLabel} page ${page}: ${url}`);

    let html: string;
    try {
      html = await fetchHtml(url);
      stats.pages_fetched++;
    } catch (error) {
      logError(`  Failed to fetch ${url}`, error as Error);
      stats.fetch_errors++;
      break;
    }

    const entries = parseCircularsFromHtml(html, categoryLabel, url);

    if (entries.length === 0) {
      // No cards found — either empty category or past the last page
      if (page === 1) {
        log(`  No circulars found in ${categoryLabel}`);
      }
      break;
    }

    allEntries.push(...entries);
    log(`  Found ${entries.length} circulars on page ${page} (running total: ${allEntries.length})`);

    // Check if there's a next page
    const totalResults = parseTotalResults(html);
    if (totalResults === null) {
      // No pager — single page category, all results are on this page
      break;
    }

    const resultsPerPage = entries.length;
    const maxPages = Math.ceil(totalResults / resultsPerPage);
    if (page >= maxPages) break;

    page++;
    await delay(REQUEST_DELAY_MS);
  }

  return allEntries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ingestion
// ─────────────────────────────────────────────────────────────────────────────

async function ingestCysecCirculars(options: CliOptions): Promise<void> {
  const ingestionTimestamp = new Date().toISOString();

  log('CySEC Circulars Ingestion');
  log('='.repeat(70));
  log(`  Database:   ${options.dbPath}`);
  log(`  Dry run:    ${options.dryRun}`);
  log(`  Limit:      ${options.limit ?? 'none'}`);
  log(`  Source:     ${BASE_URL}${CIRCULARS_BASE}/`);
  log(`  Categories: ${CIRCULAR_CATEGORIES.length}`);
  log(`  License:    ${LICENSE_ID}`);
  log(`  Provenance: ${PROVENANCE_TIER}`);
  log('');

  const stats: IngestionStats = {
    categories_scraped: 0,
    pages_fetched: 0,
    circulars_found: 0,
    circulars_inserted: 0,
    circulars_skipped_duplicate: 0,
    fetch_errors: 0,
  };

  // ── Step 1: Scrape all categories ─────────────────────────────────────────
  const allCirculars: CircularEntry[] = [];
  const seenIds = new Set<string>();

  for (const cat of CIRCULAR_CATEGORIES) {
    // If we've hit the global limit, stop
    if (options.limit !== undefined && allCirculars.length >= options.limit) {
      log(`  Global limit of ${options.limit} reached — stopping scrape`);
      break;
    }

    const remaining = options.limit !== undefined
      ? options.limit - allCirculars.length
      : undefined;

    log(`Scraping category: ${cat.label}`);
    const entries = await scrapeCategory(cat.path, cat.label, stats, remaining);
    stats.categories_scraped++;

    // Deduplicate by document_id (same circular may appear in multiple categories)
    for (const entry of entries) {
      if (seenIds.has(entry.document_id)) {
        stats.circulars_skipped_duplicate++;
        continue;
      }
      seenIds.add(entry.document_id);
      allCirculars.push(entry);

      if (options.limit !== undefined && allCirculars.length >= options.limit) break;
    }

    // Rate limit between categories
    await delay(REQUEST_DELAY_MS);
  }

  stats.circulars_found = allCirculars.length;

  log('');
  log(`Total unique circulars found: ${allCirculars.length}`);

  // Handle the case where 0 circulars are found (possible JS rendering)
  if (allCirculars.length === 0) {
    log('');
    log('WARNING: No circulars were extracted from CySEC listing pages.');
    log('Possible causes:');
    log('  - CySEC may have changed their page structure or CMS template');
    log('  - The circulars page may now use client-side JS rendering');
    log('  - The server may be returning error pages or captchas');
    log('');
    log('Check the HTML content by running:');
    log('  curl -s -L "https://www.cysec.gov.cy/en-GB/public-info/circulars/supervised/investment-firms/" | head -200');
    log('');
    log('Exiting without error (0 circulars is a valid scrape result).');
    return;
  }

  // ── Step 2: Dry-run preview ───────────────────────────────────────────────
  if (options.dryRun) {
    log('');
    log('DRY RUN — listing circulars that would be ingested:');
    log('-'.repeat(70));
    for (const c of allCirculars) {
      log(`  [${c.document_id}]`);
      log(`    Title:    ${c.title}`);
      log(`    Ref:      ${c.reference ?? '(none)'}`);
      log(`    Date:     ${c.date ?? '(unknown)'}`);
      log(`    Category: ${c.category}`);
      log(`    File URL: ${c.file_url}`);
      log('');
    }
    log('-'.repeat(70));
    log(`Total: ${allCirculars.length} circulars would be inserted`);
    log(`Duplicates skipped: ${stats.circulars_skipped_duplicate}`);
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
  const requiredColumns = [
    'source_uri', 'license_identifier', 'ingestion_timestamp',
    'source_record_id', 'provenance_tier',
  ];
  const missingColumns = requiredColumns.filter(c => !columnNames.has(c));

  if (missingColumns.length > 0) {
    logError(
      `agency_guidance table is missing provenance columns: ${missingColumns.join(', ')}. ` +
      'Run build:db:paid first.'
    );
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

  // ── Step 4: Insert circulars ──────────────────────────────────────────────
  log('');
  log('Inserting circulars into agency_guidance...');

  const insertAll = db.transaction(() => {
    for (let i = 0; i < allCirculars.length; i++) {
      const c = allCirculars[i];

      // Build a summary line with metadata
      const summaryParts: string[] = [];
      summaryParts.push(`CySEC Circular: ${c.title}`);
      if (c.category) summaryParts.push(`Category: ${c.category}`);
      if (c.reference) summaryParts.push(`Reference: ${c.reference}`);
      const summary = summaryParts.join('. ');

      // Full text includes all available metadata
      const fullTextLines: string[] = [];
      fullTextLines.push(c.title);
      fullTextLines.push('');
      if (c.reference) fullTextLines.push(`Reference: ${c.reference}`);
      fullTextLines.push(`Category: ${c.category}`);
      if (c.date) fullTextLines.push(`Date: ${c.date}`);
      fullTextLines.push(`Source: ${c.file_url}`);
      fullTextLines.push('');
      fullTextLines.push(
        'This is a circular issued by the Cyprus Securities and Exchange Commission (CySEC). ' +
        'The full text is available as a PDF document at the source URL above.'
      );

      // Derive source_record_id: prefer reference number, fall back to file GUID
      const guidMatch = c.file_url.match(/guid=([a-f0-9-]+)/i);
      const sourceRecordId = c.reference || guidMatch?.[1] || c.document_id;

      insertStmt.run({
        agency: AGENCY_NAME,
        document_id: c.document_id,
        title: c.title,
        summary,
        full_text: fullTextLines.join('\n'),
        issued_date: c.date,
        url: c.file_url,
        related_statute_id: null,
        source_uri: c.listing_url,
        license_identifier: LICENSE_ID,
        ingestion_timestamp: ingestionTimestamp,
        source_record_id: sourceRecordId,
        provenance_tier: PROVENANCE_TIER,
      });

      stats.circulars_inserted++;

      if ((i + 1) % 100 === 0) {
        log(`  Inserted ${i + 1}/${allCirculars.length}...`);
      }
    }
  });

  try {
    insertAll();
    log(`  Inserted ${stats.circulars_inserted} circulars`);
  } catch (error) {
    logError('Transaction failed', error as Error);
    db.close();
    process.exit(1);
  }

  // ── Step 5: Rebuild FTS index ─────────────────────────────────────────────
  log('');
  log('Rebuilding agency_guidance_fts index...');
  try {
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
  log('CySEC Circulars Ingestion Complete');
  log('='.repeat(70));
  log(`  Categories scraped:    ${stats.categories_scraped}`);
  log(`  Pages fetched:         ${stats.pages_fetched}`);
  log(`  Circulars found:       ${stats.circulars_found}`);
  log(`  Circulars inserted:    ${stats.circulars_inserted}`);
  log(`  Duplicates skipped:    ${stats.circulars_skipped_duplicate}`);
  log(`  Fetch errors:          ${stats.fetch_errors}`);
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
      case '--limit': {
        const limitArg = args[++i];
        options.limit = parseInt(limitArg, 10);
        if (isNaN(options.limit) || options.limit <= 0) {
          console.error('Error: --limit must be a positive number');
          process.exit(1);
        }
      }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        console.error('');
        console.error('Usage: npx tsx scripts/premium-ingestion/cypriot/ingest-cysec-circulars.ts [options]');
        console.error('');
        console.error('Options:');
        console.error('  --db <path>   Path to the SQLite database');
        console.error('  --dry-run     List circulars without writing to the database');
        console.error('  --limit N     Process only the first N circulars');
        process.exit(1);
    }
  }

  ingestCysecCirculars(options).catch(error => {
    logError('Ingestion failed', error);
    process.exit(1);
  });
}
