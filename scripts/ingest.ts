#!/usr/bin/env tsx
/**
 * Cypriot Law MCP -- real-data ingestion from CyLaw.
 *
 * Source portal: https://www.cylaw.org
 * Method: HTML scraping of consolidated statutes (full.html)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import { TARGET_CYPRIOT_LAWS, getLawUrls, parseCyLawHtml, type TargetLaw } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../data/source/cylaw');
const SEED_DIR = path.resolve(__dirname, '../data/seed');

interface CliOptions {
  limit: number | null;
  skipFetch: boolean;
}

interface IngestionResult {
  lawRef: string;
  status: 'OK' | 'SKIPPED' | 'FAILED';
  provisions: number;
  definitions: number;
  note?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let skipFetch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }

    if (args[i] === '--skip-fetch') {
      skipFetch = true;
    }
  }

  return { limit, skipFetch };
}

function ensureDirectories(): void {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });
}

function clearExistingSeeds(): void {
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (!file.endsWith('.json')) continue;
    fs.unlinkSync(path.join(SEED_DIR, file));
  }
}

function getSourcePaths(law: TargetLaw): { fullPath: string; indexPath: string } {
  return {
    fullPath: path.join(SOURCE_DIR, `${law.pathStem}.full.html`),
    indexPath: path.join(SOURCE_DIR, `${law.pathStem}.index.html`),
  };
}

async function loadLawHtml(law: TargetLaw, skipFetch: boolean): Promise<{ fullHtml: string; indexHtml?: string }> {
  const { fullUrl, indexUrl } = getLawUrls(law);
  const { fullPath, indexPath } = getSourcePaths(law);

  if (skipFetch && fs.existsSync(fullPath)) {
    const fullHtml = fs.readFileSync(fullPath, 'utf-8');
    const indexHtml = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, 'utf-8')
      : undefined;
    return { fullHtml, indexHtml };
  }

  const fullResponse = await fetchWithRateLimit(fullUrl);
  if (fullResponse.status !== 200) {
    throw new Error(`Failed full text fetch (HTTP ${fullResponse.status}) ${fullUrl}`);
  }

  const indexResponse = await fetchWithRateLimit(indexUrl);
  const indexHtml = indexResponse.status === 200 ? indexResponse.body : undefined;

  fs.writeFileSync(fullPath, fullResponse.body);
  if (indexHtml) {
    fs.writeFileSync(indexPath, indexHtml);
  }

  return {
    fullHtml: fullResponse.body,
    indexHtml,
  };
}

async function ingest(): Promise<void> {
  const { limit, skipFetch } = parseArgs();

  console.log('Cypriot Law MCP -- Real Data Ingestion');
  console.log('======================================');
  console.log('Source: https://www.cylaw.org');
  console.log('Method: HTML scraping (consolidated full text)');
  if (limit !== null) console.log(`Limit: ${limit}`);
  if (skipFetch) console.log('Using cached source pages where available');
  console.log('');

  ensureDirectories();
  clearExistingSeeds();

  const targets = limit !== null ? TARGET_CYPRIOT_LAWS.slice(0, limit) : TARGET_CYPRIOT_LAWS;
  const results: IngestionResult[] = [];

  for (const law of targets) {
    const { fullUrl } = getLawUrls(law);
    const seedFile = `${String(law.order).padStart(2, '0')}-${law.id}.json`;
    const seedPath = path.join(SEED_DIR, seedFile);

    process.stdout.write(`Fetching/parsing ${law.shortName} ... `);

    try {
      const { fullHtml, indexHtml } = await loadLawHtml(law, skipFetch);
      const parsed = parseCyLawHtml(fullHtml, law, indexHtml);

      if (parsed.provisions.length === 0) {
        console.log('SKIPPED (no provisions extracted)');
        results.push({
          lawRef: law.shortName,
          status: 'SKIPPED',
          provisions: 0,
          definitions: 0,
          note: `No parseable provisions from ${fullUrl}`,
        });
        continue;
      }

      fs.writeFileSync(seedPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
      console.log(`OK (${parsed.provisions.length} provisions, ${parsed.definitions.length} definitions)`);

      results.push({
        lawRef: law.shortName,
        status: 'OK',
        provisions: parsed.provisions.length,
        definitions: parsed.definitions.length,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`FAILED (${msg})`);
      results.push({
        lawRef: law.shortName,
        status: 'FAILED',
        provisions: 0,
        definitions: 0,
        note: msg,
      });
    }
  }

  const ok = results.filter(r => r.status === 'OK');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  const failed = results.filter(r => r.status === 'FAILED');

  const totalProvisions = ok.reduce((sum, r) => sum + r.provisions, 0);
  const totalDefinitions = ok.reduce((sum, r) => sum + r.definitions, 0);

  console.log('\nIngestion summary');
  console.log('-----------------');
  console.log(`Successful laws: ${ok.length}`);
  console.log(`Skipped laws:    ${skipped.length}`);
  console.log(`Failed laws:     ${failed.length}`);
  console.log(`Provisions:      ${totalProvisions}`);
  console.log(`Definitions:     ${totalDefinitions}`);

  if (skipped.length > 0 || failed.length > 0) {
    console.log('\nSkipped/failed details:');
    for (const row of [...skipped, ...failed]) {
      console.log(`- ${row.lawRef}: ${row.note ?? row.status}`);
    }
  }
}

ingest().catch(error => {
  console.error('Fatal ingestion error:', error);
  process.exit(1);
});
