#!/usr/bin/env tsx
/**
 * Cypriot Law MCP -- real-data ingestion from CyLaw.
 *
 * Supports:
 * - Curated ingestion (default 10 high-priority statutes)
 * - Full-corpus ingestion from CyLaw yearly indexes (--full-corpus)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import {
  TARGET_CYPRIOT_LAWS,
  buildTargetLawFromStem,
  getLawUrls,
  parseCyLawHtml,
  type TargetLaw,
} from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../data/source/cylaw');
const SEED_DIR = path.resolve(__dirname, '../data/seed');
const CATALOG_PATH = path.join(SOURCE_DIR, 'catalog-full-corpus.json');
const FAILURE_CACHE_PATH = path.join(SOURCE_DIR, 'ingest-failures.json');

interface CliOptions {
  limit: number | null;
  skipFetch: boolean;
  fullCorpus: boolean;
  resume: boolean;
  maxNew: number | null;
}

interface IngestionResult {
  lawRef: string;
  status: 'OK' | 'CACHED' | 'FAILED';
  provisions: number;
  definitions: number;
  note?: string;
}

interface LoadedHtml {
  fullHtml: string;
  fullUrl: string;
  indexHtml?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let skipFetch = false;
  let fullCorpus = false;
  let resume = false;
  let maxNew: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }

    if (args[i] === '--skip-fetch') {
      skipFetch = true;
      continue;
    }

    if (args[i] === '--full-corpus') {
      fullCorpus = true;
      continue;
    }

    if (args[i] === '--resume') {
      resume = true;
      continue;
    }

    if (args[i] === '--max-new' && args[i + 1]) {
      maxNew = Number.parseInt(args[i + 1], 10);
      i += 1;
    }
  }

  return { limit, skipFetch, fullCorpus, resume, maxNew };
}

function ensureDirectories(): void {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(path.join(SOURCE_DIR, 'year-indexes'), { recursive: true });
  fs.mkdirSync(path.join(SOURCE_DIR, 'law-indexes'), { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });
}

function clearExistingSeeds(): void {
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (!file.endsWith('.json')) continue;
    fs.unlinkSync(path.join(SEED_DIR, file));
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJsonFile(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

async function fetchHtmlWithCache(url: string, cachePath: string, skipFetch: boolean): Promise<string> {
  if (skipFetch && fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf-8');
  }

  const response = await fetchWithRateLimit(url);
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  fs.writeFileSync(cachePath, response.body, 'utf-8');
  return response.body;
}

function getSourcePaths(law: TargetLaw): { fullPath: string; indexPath: string } {
  return {
    fullPath: path.join(SOURCE_DIR, `${law.pathStem}.full.html`),
    indexPath: path.join(SOURCE_DIR, `${law.pathStem}.index.html`),
  };
}

function extractLawStemsFromHtml(html: string): string[] {
  const stems = new Set<string>();
  for (const match of html.matchAll(/href="\/nomoi\/indexes\/([A-Za-z0-9_]+)\.html"/g)) {
    stems.add(match[1]);
  }
  return [...stems];
}

function sortLawStems(stems: string[]): string[] {
  return [...stems].sort((a, b) => {
    const aParts = a.split('_').map(x => Number.parseInt(x, 10));
    const bParts = b.split('_').map(x => Number.parseInt(x, 10));

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const av = Number.isFinite(aParts[i]) ? aParts[i] : Number.POSITIVE_INFINITY;
      const bv = Number.isFinite(bParts[i]) ? bParts[i] : Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
    }

    return a.localeCompare(b, 'el');
  });
}

async function discoverFullCorpusTargets(skipFetch: boolean): Promise<TargetLaw[]> {
  const cached = readJsonFile<TargetLaw[]>(CATALOG_PATH);
  if (skipFetch && cached && cached.length > 0) {
    return cached;
  }

  const rootPath = path.join(SOURCE_DIR, 'nomoi-index.html');
  const rootHtml = await fetchHtmlWithCache('https://www.cylaw.org/nomoi/index.html', rootPath, skipFetch);

  const yearLinks = new Set<string>();
  for (const m of rootHtml.matchAll(/href="(\/nomoi\/(?:\d{4}_index|0_index)\.html)"/g)) {
    yearLinks.add(m[1]);
  }

  const stems = new Set<string>();

  for (const stem of extractLawStemsFromHtml(rootHtml)) {
    stems.add(stem);
  }

  for (const yearRel of [...yearLinks].sort()) {
    const yearUrl = new URL(yearRel, 'https://www.cylaw.org').toString();
    const yearCache = path.join(SOURCE_DIR, 'year-indexes', yearRel.split('/').pop() ?? 'year.html');

    const yearHtml = await fetchHtmlWithCache(yearUrl, yearCache, skipFetch);
    for (const stem of extractLawStemsFromHtml(yearHtml)) {
      stems.add(stem);
    }
  }

  const sortedStems = sortLawStems([...stems]).filter(s => s.length > 0);
  const targets = sortedStems.map((stem, idx) => buildTargetLawFromStem(stem, idx + 1));

  writeJsonFile(CATALOG_PATH, targets);
  return targets;
}

async function loadLawHtml(law: TargetLaw, skipFetch: boolean, fullCorpus: boolean): Promise<LoadedHtml> {
  const { fullUrl, indexUrl } = getLawUrls(law);
  const { fullPath, indexPath } = getSourcePaths(law);
  const isSimpleChapterStem = /^\d+[A-Za-zΑ-Ωα-ω]*$/u.test(law.pathStem);

  if (skipFetch && fs.existsSync(fullPath)) {
    return {
      fullHtml: fs.readFileSync(fullPath, 'utf-8'),
      fullUrl,
      indexHtml: fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : undefined,
    };
  }

  const fullResponse = await fetchWithRateLimit(fullUrl);
  if (fullResponse.status === 200) {
    fs.writeFileSync(fullPath, fullResponse.body, 'utf-8');
    return {
      fullHtml: fullResponse.body,
      fullUrl,
    };
  }

  if (fullCorpus && isSimpleChapterStem) {
    throw new Error(`No consolidated full text (HTTP ${fullResponse.status})`);
  }

  // Fallback: fetch law index and extract the consolidated full-text URL when stem variants exist.
  const indexResponse = await fetchWithRateLimit(indexUrl);
  if (indexResponse.status !== 200) {
    throw new Error(`No consolidated full text (full=${fullResponse.status}, index=${indexResponse.status})`);
  }

  fs.writeFileSync(indexPath, indexResponse.body, 'utf-8');

  const altRel = indexResponse.body.match(/href="(\/nomoi\/enop\/non-ind\/[^"]+\/full\.html)"/i)?.[1];
  if (!altRel) {
    throw new Error(`No consolidated full-text link found in index page: ${indexUrl}`);
  }

  const altUrl = new URL(altRel, 'https://www.cylaw.org').toString();
  const altResponse = await fetchWithRateLimit(altUrl);
  if (altResponse.status !== 200) {
    throw new Error(`Resolved alternate full text but got HTTP ${altResponse.status}: ${altUrl}`);
  }

  fs.writeFileSync(fullPath, altResponse.body, 'utf-8');

  return {
    fullHtml: altResponse.body,
    fullUrl: altUrl,
    indexHtml: fullCorpus ? undefined : indexResponse.body,
  };
}

function seedFileName(law: TargetLaw, totalTargets: number): string {
  const width = Math.max(2, String(totalTargets).length);
  return `${String(law.order).padStart(width, '0')}-${law.id}.json`;
}

async function ingest(): Promise<void> {
  const { limit, skipFetch, fullCorpus, resume, maxNew } = parseArgs();

  console.log('Cypriot Law MCP -- Real Data Ingestion');
  console.log('======================================');
  console.log('Source: https://www.cylaw.org');
  console.log(`Mode: ${fullCorpus ? 'FULL_CORPUS' : 'CURATED_10'}`);
  console.log('Method: HTML scraping (consolidated full text)');
  if (limit !== null) console.log(`Limit: ${limit}`);
  if (skipFetch) console.log('Using cached source pages where available');
  if (resume) console.log('Resume mode enabled (existing seed files are reused)');
  if (maxNew !== null) console.log(`Max new fetches this run: ${maxNew}`);
  console.log('');

  ensureDirectories();

  const discoveredTargets = fullCorpus
    ? await discoverFullCorpusTargets(skipFetch)
    : TARGET_CYPRIOT_LAWS;
  const targets = limit !== null ? discoveredTargets.slice(0, limit) : discoveredTargets;
  const knownFailureIds = new Set(readJsonFile<string[]>(FAILURE_CACHE_PATH) ?? []);

  const persistFailureCache = (): void => {
    writeJsonFile(FAILURE_CACHE_PATH, [...knownFailureIds].sort((a, b) => a.localeCompare(b, 'en')));
  };

  console.log(`Target laws: ${targets.length}`);

  if (!resume) {
    clearExistingSeeds();
  }

  const results: IngestionResult[] = [];
  let newFetchCount = 0;

  for (const law of targets) {
    if (maxNew !== null && newFetchCount >= maxNew) {
      console.log(`Reached --max-new limit (${maxNew}). Stopping this batch.`);
      break;
    }

    const seedFile = seedFileName(law, targets.length);
    const seedPath = path.join(SEED_DIR, seedFile);
    const lawRef = law.shortName ?? law.pathStem;

    if (resume && fs.existsSync(seedPath)) {
      const existing = readJsonFile<{ provisions?: unknown[]; definitions?: unknown[] }>(seedPath);
      results.push({
        lawRef,
        status: 'CACHED',
        provisions: existing?.provisions?.length ?? 0,
        definitions: existing?.definitions?.length ?? 0,
      });
      console.log(`Reusing ${lawRef} ... CACHED`);
      continue;
    }

    if (resume && knownFailureIds.has(law.id)) {
      console.log(`Skipping ${lawRef} ... FAILED_CACHED`);
      results.push({
        lawRef,
        status: 'FAILED',
        provisions: 0,
        definitions: 0,
        note: 'Previously known ingestion failure',
      });
      continue;
    }

    process.stdout.write(`Fetching/parsing ${lawRef} ... `);

    try {
      newFetchCount += 1;
      const loaded = await loadLawHtml(law, skipFetch, fullCorpus);
      const parsed = parseCyLawHtml(loaded.fullHtml, law, loaded.indexHtml);
      parsed.url = loaded.fullUrl;

      writeJsonFile(seedPath, parsed);
      console.log(`OK (${parsed.provisions.length} provisions, ${parsed.definitions.length} definitions)`);

      if (knownFailureIds.delete(law.id)) {
        persistFailureCache();
      }

      results.push({
        lawRef,
        status: 'OK',
        provisions: parsed.provisions.length,
        definitions: parsed.definitions.length,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`FAILED (${msg})`);
      if (!knownFailureIds.has(law.id)) {
        knownFailureIds.add(law.id);
        persistFailureCache();
      }
      results.push({
        lawRef,
        status: 'FAILED',
        provisions: 0,
        definitions: 0,
        note: msg,
      });
    }
  }

  const ok = results.filter(r => r.status === 'OK');
  const cached = results.filter(r => r.status === 'CACHED');
  const failed = results.filter(r => r.status === 'FAILED');

  const totalProvisions = [...ok, ...cached].reduce((sum, r) => sum + r.provisions, 0);
  const totalDefinitions = [...ok, ...cached].reduce((sum, r) => sum + r.definitions, 0);

  console.log('\nIngestion summary');
  console.log('-----------------');
  console.log(`Successful laws: ${ok.length}`);
  console.log(`Cached laws:     ${cached.length}`);
  console.log(`Failed laws:     ${failed.length}`);
  console.log(`New fetches:     ${newFetchCount}`);
  console.log(`Provisions:      ${totalProvisions}`);
  console.log(`Definitions:     ${totalDefinitions}`);

  if (failed.length > 0) {
    console.log('\nFailed details:');
    for (const row of failed.slice(0, 200)) {
      console.log(`- ${row.lawRef}: ${row.note ?? row.status}`);
    }
    if (failed.length > 200) {
      console.log(`... and ${failed.length - 200} more`);
    }
  }
}

ingest().catch(error => {
  console.error('Fatal ingestion error:', error);
  process.exit(1);
});
