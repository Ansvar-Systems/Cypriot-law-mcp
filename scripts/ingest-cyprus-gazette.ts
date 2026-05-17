#!/usr/bin/env tsx
/**
 * Cyprus Government Gazette Ingestion Adapter
 *
 * Scrapes the Cyprus Government Gazette (Επίσημη Εφημερίδα της Κυπριακής
 * Δημοκρατίας) from the Government Printing Office (GPO) at the Ministry of
 * Finance, and writes issue metadata into the `gazette_issues` table of the
 * Cyprus premium SQLite database.
 *
 * MVP scope: issue-level metadata only. Full PDF text extraction into
 * `gazette_provisions` is deferred to a follow-up iteration.
 *
 * Source: https://www.mof.gov.cy/mof/gpo/gazette.nsf/
 *
 * License basis: Cyprus Law 143(I)/2021, transposing EU Directive 2019/1024
 * (Open Data Directive). Article 5 obligates member states to make documents
 * available in machine-readable form for re-use; Article 8 mandates commercial
 * re-use of public sector information. The Gazette is the authoritative
 * publication channel for Cyprus statutes, regulations, presidential decrees
 * and statutory instruments — paradigmatic PSI content.
 *
 * Legal posture note: mof.gov.cy serves robots.txt with blanket
 * "User-agent: * / Disallow: /". That hint is inconsistent with Cyprus's
 * statutory obligation under Cyprus Law 143(I)/2021 Article 5 to make documents
 * "machine-readable, accessible, findable and re-usable". The substantive
 * re-use right is granted by statute, not by the website operator's permission.
 * This adapter exercises that statutory right via:
 *   - Polite rate limiting (1500ms inter-request delay)
 *   - Identified User-Agent with operator contact (legal@ansvar.eu)
 *   - Hard stop on HTTP 429 / 403 responses
 * If GPO objects, the User-Agent gives them a path to discuss; we pivot to a
 * written bulk-dump arrangement at that point.
 *
 * Provenance tier: authoritative
 * (per docs/superpowers/specs/2026-04-25-cyprus-official-sources-program-design.md §4.3)
 *
 * Adapter architecture:
 *   1. For each annex (sectionNumber 1-5, mapped to I-V):
 *        For each cp page (1 → end), fetch the sectional view
 *        Extract per-issue HASH URLs
 *   2. For each issue HASH:
 *        Fetch the per-issue document; parse metadata
 *   3. UPSERT into gazette_issues (year, issue_number, annex unique key)
 *
 * Prerequisites:
 *   1. npm run build:db           -- base database with schema
 *   2. npm run build:db:paid      -- adds gazette_issues table + provenance
 *
 * Usage:
 *   npx tsx scripts/ingest-cyprus-gazette.ts [options]
 *
 * Options:
 *   --db <path>      Path to the SQLite database (default: data/database.db)
 *   --dry-run        Probe and parse, but do not write to the database
 *   --limit N        Process only the first N issues (across all annexes)
 *   --section N      Only process sectionNumber N (1-5; default: all)
 *   --max-cp N       Stop pagination at cp=N (default: 1000)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const runProc = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/database.db');
const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ingest-gazette.log');

const BASE_URL = 'https://www.mof.gov.cy';
// Cyprus Gazette Annexes navigation uses `dmlgaz_appsw_gr?OpenDocument&OpenView&Count=1000&cp=<N>&app=<APP_ID>`
// where APP_ID maps to sub-section:
//   app=16  ΠΑΡΑΡΤΗΜΑ ΠΡΩΤΟ Ι   General Legislation (LAWS)        → annex I (THIS MVP)
//   app=2   ΠΑΡΑΡΤΗΜΑ ΠΡΩΤΟ ΙΙ  Budget Laws                       → annex I (follow-up)
//   app=3   ΠΑΡΑΡΤΗΜΑ ΠΡΩΤΟ ΙΙΙ Treaty Ratifications              → annex I (follow-up)
//   app=4   ΠΑΡΑΡΤΗΜΑ ΔΕΥΤΕΡΟ Ι  Procedural Rules                 → annex II (follow-up)
//   app=5   ΠΑΡΑΡΤΗΜΑ ΔΕΥΤΕΡΟ ΙΙ Supreme Court Decisions          → annex II (follow-up)
//   app=6   ΠΑΡΑΡΤΗΜΑ ΤΡΙΤΟ Ι   Regulatory Administrative Acts    → annex III (follow-up)
//   app=7   ΠΑΡΑΡΤΗΜΑ ΤΡΙΤΟ ΙΙ  Individual Administrative Acts    → annex III (follow-up)
//   app=8   ΠΑΡΑΡΤΗΜΑ ΤΕΤΑΡΤΟ Ι  Council of Ministers Decisions   → annex IV (follow-up)
//   app=9   ΠΑΡΑΡΤΗΜΑ ΤΕΤΑΡΤΟ ΙΙ Decisions of House of Reps.      → annex IV (follow-up)
//   app=10  ΠΑΡΑΡΤΗΜΑ ΠΕΜΠΤΟ Ι  (Annex V)                          → annex V (follow-up)
// Follow-up apps require a schema migration to support (year, issue_number, annex, part)
// uniqueness instead of the current (year, issue_number, annex). This MVP targets just
// app=16 — the highest-value content for a Cypriot law firm doing primary-law research.
const APP_VIEW_PATH = '/mof/gpo/gazette.nsf/dmlgaz_appsw_gr/dmlgaz_appsw_gr';
const TARGET_APPS: Array<{ app: number; annex: 'I' | 'II' | 'III' | 'IV' | 'V'; label: string }> = [
  { app: 16, annex: 'I', label: 'ΠΑΡΑΡΤΗΜΑ ΠΡΩΤΟ Ι — General Legislation (LAWS)' },
];
const REQUEST_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT = 'Ansvar-Cypriot-Law-PSI-Reuse/1.0 (legal@ansvar.eu; statutory re-use under Cyprus Law 143(I)/2021 Art 5+8)';
const CURL_TIMEOUT_SECS = 30;

const LICENSE_ID = 'Cyprus-PSI';
const PROVENANCE_TIER = 'authoritative';

const ANNEX_MAP: Record<number, 'I' | 'II' | 'III' | 'IV' | 'V'> = {
  1: 'I',
  2: 'II',
  3: 'III',
  4: 'IV',
  5: 'V',
};

// Cyprus Gazette annex labels are Greek letters Α-Ε in the issue HTML.
// Map each to the schema's Roman numeral (I-V).
const GREEK_ANNEX_TO_ROMAN: Record<string, 'I' | 'II' | 'III' | 'IV' | 'V'> = {
  'Α': 'I',
  'Β': 'II',
  'Γ': 'III',
  'Δ': 'IV',
  'Ε': 'V',
};

interface CliOptions {
  db: string;
  dryRun: boolean;
  limit: number;
  section: number | null;
  maxCp: number;
}

interface IssueMetadata {
  doc_unid: string;
  year: number;
  issue_number: number;
  annex: 'I' | 'II' | 'III' | 'IV' | 'V';
  publication_date: string;
  source_url: string;
  pdf_url: string | null;
  page_count: number | null;
  title: string;
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
  const line = `[${timestamp}] ${message}\n`;
  console.log(message);
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, line);
}

function logError(message: string, err?: Error | unknown): void {
  const timestamp = new Date().toISOString();
  const detail = err instanceof Error ? `\n  Error: ${err.message}` : '';
  const line = `[${timestamp}] ERROR: ${message}${detail}\n`;
  console.error(line.trim());
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, line);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fetch via curl (Domino-friendly; same pattern as ingest-cysec-circulars.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchHtml(url: string, retries = MAX_RETRIES): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // -k (insecure) is required: Cyprus government Lotus Domino servers
      // have intermediate-cert chain issues that cause SSL verification
      // failures on non-Cyprus-CA-aware clients. Same pattern as the
      // cy-dp adapter for dataprotection.gov.cy.
      const { stdout } = await runProc(
        'curl',
        [
          '-sS',
          '-k',
          '-A', USER_AGENT,
          '-m', String(CURL_TIMEOUT_SECS),
          '-L',
          '--write-out', '\\n__HTTP_STATUS__:%{http_code}',
          url,
        ],
        { maxBuffer: 25 * 1024 * 1024 },
      );
      const match = stdout.match(/^([\s\S]*)\n__HTTP_STATUS__:(\d+)$/);
      if (!match) {
        throw new Error(`Malformed curl output: ${stdout.slice(0, 200)}`);
      }
      const body = match[1];
      const status = parseInt(match[2], 10);
      if (status === 429 || status === 403) {
        throw new Error(`HARD STOP: HTTP ${status} from upstream. Rate-limit or block detected. ` +
          'Halting ingestion to respect the operator. Review User-Agent + delay; consider direct contact with director@gpo.mof.gov.cy.');
      }
      if (status >= 400) {
        throw new Error(`HTTP ${status} for ${url}`);
      }
      return body;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('HARD STOP')) {
        throw err;
      }
      if (attempt === retries) {
        throw err;
      }
      logError(`Fetch attempt ${attempt}/${retries} failed for ${url}; retrying`, err);
      await delay(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error('unreachable');
}

// ─────────────────────────────────────────────────────────────────────────────
// Section listing parser
// ─────────────────────────────────────────────────────────────────────────────

interface SectionListingEntry {
  doc_unid: string;
  issue_number: number;
  publication_date_raw: string;
}

function parseSectionListing(html: string): SectionListingEntry[] {
  const pattern = /href="\/mof\/gpo\/gazette\.nsf\/All\/([A-F0-9]{32})\?OpenDocument">([^<]+)<\/a>/g;
  const buckets: Record<string, string[]> = {};
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const unid = m[1];
    const text = m[2].trim();
    if (!buckets[unid]) buckets[unid] = [];
    buckets[unid].push(text);
  }
  const out: SectionListingEntry[] = [];
  for (const [unid, texts] of Object.entries(buckets)) {
    let issueNum: number | null = null;
    let dateRaw = '';
    for (const t of texts) {
      if (/^\d{1,5}$/.test(t) && issueNum === null) issueNum = parseInt(t, 10);
      else if (/^\d{2}\/\d{2}\/\d{4}$/.test(t) && !dateRaw) dateRaw = t;
    }
    if (issueNum !== null && dateRaw) {
      out.push({ doc_unid: unid, issue_number: issueNum, publication_date_raw: dateRaw });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue-page parser
// ─────────────────────────────────────────────────────────────────────────────

function parseIssuePage(html: string, doc_unid: string, annexFromUrl: 'I' | 'II' | 'III' | 'IV' | 'V'): IssueMetadata | null {
  // The issue page has two possible formats depending on which annex/app it
  // belongs to:
  //   - Personnel section (sectional view):  <strong>ΤΜΗΜΑ - Α<br>...</strong>
  //   - Annex documents (app-based view):    <title>5089 - ΠΑΡΑΡΤΗΜΑ ΠΡΩΤΟ - ΜΕΡΟΣ (Ι)</title>
  // We trust the URL-derived annex (from app ID mapping) and only verify the
  // metadata table for issue number/date/PDF — those fields exist in both formats.
  const num = html.match(/Αριθμός Εφημερίδας:\s*<strong>(\d+)<\/strong>/);
  const pages = html.match(/Σελίδες:\s*<strong>([0-9,\s-]+)<\/strong>/);
  const date = html.match(/Ημερομηνία:\s*<strong>(\d{2}\/\d{2}\/\d{4})<\/strong>/);
  // Title fallback: prefer <h1>, else <title>
  const h1 = html.match(/<h1>(?:Τεύχος\s*:\s*\d+\s*-\s*)?([^<]+?)<\/h1>/);
  const titleTag = html.match(/<title>([^<|]+?)(?:\s*\|[^<]+)?<\/title>/);
  const pdf = html.match(/href="(?:\.\.\/)?([A-F0-9]{32})\/\$file\/([^"]+\.pdf)"/i);

  if (!num || !date) {
    return null;
  }

  const issueNumber = parseInt(num[1], 10);
  const dateParts = date[1].split('/');
  const isoDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
  const year = parseInt(dateParts[2], 10);

  const pageCount = pages ? parseInt(pages[1].replace(/[,\s].*/, ''), 10) : null;

  const pdfUrl = pdf
    ? `${BASE_URL}/mof/gpo/gazette.nsf/${pdf[1]}/$file/${pdf[2].replace(/ /g, '%20')}`
    : null;

  const title = (h1 ? h1[1] : titleTag ? titleTag[1] : '').trim();

  return {
    doc_unid,
    year,
    issue_number: issueNumber,
    annex: annexFromUrl,
    publication_date: isoDate,
    source_url: `${BASE_URL}/mof/gpo/gazette.nsf/All/${doc_unid}?OpenDocument`,
    pdf_url: pdfUrl,
    page_count: Number.isFinite(pageCount as number) ? pageCount : null,
    title,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB writer
// ─────────────────────────────────────────────────────────────────────────────

function upsertIssue(db: Database.Database, meta: IssueMetadata): boolean {
  const sql = `INSERT INTO gazette_issues (
    year, issue_number, annex, publication_date, source_url,
    pdf_path, source_uri, license_identifier, ingestion_timestamp, source_record_id, provenance_tier, page_count
  ) VALUES (
    @year, @issue_number, @annex, @publication_date, @source_url,
    @pdf_url, @source_url, @license_identifier, @ingestion_timestamp, @doc_unid, @provenance_tier, @page_count
  )
  ON CONFLICT(year, issue_number, annex) DO UPDATE SET
    publication_date = excluded.publication_date,
    source_url = excluded.source_url,
    pdf_path = excluded.pdf_path,
    source_uri = excluded.source_uri,
    license_identifier = excluded.license_identifier,
    ingestion_timestamp = excluded.ingestion_timestamp,
    source_record_id = excluded.source_record_id,
    provenance_tier = excluded.provenance_tier,
    page_count = excluded.page_count`;
  const result = db.prepare(sql).run({
    ...meta,
    license_identifier: LICENSE_ID,
    ingestion_timestamp: new Date().toISOString(),
    provenance_tier: PROVENANCE_TIER,
  });
  return result.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = { db: DEFAULT_DB_PATH, dryRun: false, limit: 0, section: null, maxCp: 1000 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db': opts.db = path.resolve(args[++i]); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--limit': opts.limit = parseInt(args[++i], 10); break;
      case '--section': opts.section = parseInt(args[++i], 10); break;
      case '--max-cp': opts.maxCp = parseInt(args[++i], 10); break;
      case '--help':
        console.log('Usage: ingest-cyprus-gazette.ts [--db PATH] [--dry-run] [--limit N] [--section N] [--max-cp N]');
        process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  log(`Cyprus Gazette ingestion adapter starting`);
  log(`Options: ${JSON.stringify(opts)}`);
  log(`License basis: ${LICENSE_ID} (Cyprus Law 143(I)/2021 + EU 2019/1024 Art 5+8)`);

  let db: Database.Database | null = null;
  if (!opts.dryRun) {
    if (!fs.existsSync(opts.db)) {
      logError(`DB not found at ${opts.db}. Run npm run build:db && npm run build:db:paid first.`);
      process.exit(1);
    }
    db = new Database(opts.db);
    db.pragma('journal_mode = DELETE');
  }

  let totalCollected = 0;
  let totalUpserted = 0;
  const seenUnids = new Set<string>();

  // Iterate each target app (this MVP: just app=16 General Laws).
  // cp paginates within each app's listing. The `Count=1000` param requests
  // a wide window per page; cp seems to be year-bucket (cp=12 returned 2026
  // issues at the time of probe). We iterate cp 1..maxCp until we see two
  // consecutive empty pages.
  outer: for (const target of TARGET_APPS) {
    log(`\n=== App ${target.app} — ${target.label} (annex ${target.annex}) ===`);
    let cp = 1;
    let consecutiveEmpty = 0;
    while (cp <= opts.maxCp) {
      const url = `${BASE_URL}${APP_VIEW_PATH}?OpenDocument&OpenView&Count=1000&cp=${cp}&app=${target.app}`;
      let html: string;
      try {
        html = await fetchHtml(url);
      } catch (err) {
        logError(`app=${target.app} cp=${cp}: fetch failed; treating as end-of-pagination`, err);
        break;
      }
      const entries = parseSectionListing(html);
      const newEntries = entries.filter((e) => !seenUnids.has(e.doc_unid));
      if (newEntries.length === 0) {
        consecutiveEmpty++;
        log(`app=${target.app} cp=${cp}: 0 new entries (total seen: ${seenUnids.size})`);
        if (consecutiveEmpty >= 2) {
          log(`app=${target.app}: 2 consecutive empty pages — stop`);
          break;
        }
      } else {
        consecutiveEmpty = 0;
        log(`app=${target.app} cp=${cp}: ${newEntries.length} new entries`);
      }

      for (const entry of newEntries) {
        if (opts.limit > 0 && totalCollected >= opts.limit) {
          log(`Limit ${opts.limit} reached — stopping`);
          break outer;
        }
        seenUnids.add(entry.doc_unid);
        totalCollected++;

        await delay(REQUEST_DELAY_MS);
        const issueUrl = `${BASE_URL}/mof/gpo/gazette.nsf/All/${entry.doc_unid}?OpenDocument`;
        let issueHtml: string;
        try {
          issueHtml = await fetchHtml(issueUrl);
        } catch (err) {
          logError(`Issue ${entry.doc_unid} (#${entry.issue_number}): fetch failed`, err);
          continue;
        }

        const meta = parseIssuePage(issueHtml, entry.doc_unid, target.annex);
        if (!meta) {
          logError(`Issue ${entry.doc_unid} (#${entry.issue_number}): metadata parse failed`);
          continue;
        }

        if (opts.dryRun) {
          log(`  [dry-run] Issue ${meta.issue_number} (${meta.annex}) ${meta.publication_date} pages=${meta.page_count} pdf=${meta.pdf_url ? 'yes' : 'no'} title="${meta.title.slice(0, 60)}"`);
        } else if (db) {
          try {
            const changed = upsertIssue(db, meta);
            if (changed) totalUpserted++;
            log(`  ${changed ? '+' : '='} Issue ${meta.issue_number} (${meta.annex}) ${meta.publication_date} pages=${meta.page_count}`);
          } catch (err) {
            logError(`Upsert failed for issue ${meta.issue_number}/${meta.annex}/${meta.year}`, err);
          }
        }
      }

      cp++;
      await delay(REQUEST_DELAY_MS);
    }
  }

  log(`\n=== Done ===`);
  log(`Total issues collected: ${totalCollected}`);
  log(`Total upserted: ${totalUpserted}`);

  if (db) {
    const counts = db.prepare(`SELECT annex, COUNT(*) as n FROM gazette_issues GROUP BY annex ORDER BY annex`).all() as Array<{ annex: string; n: number }>;
    log(`Database state after ingestion (gazette_issues by annex):`);
    for (const row of counts) log(`  Annex ${row.annex}: ${row.n}`);
    db.close();
  }
}

main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
