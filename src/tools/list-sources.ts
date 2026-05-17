/**
 * list_sources — Return provenance metadata for all data sources.
 */

import type Database from '@ansvar/mcp-sqlite';
import { readDbMetadata } from '../capabilities.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface SourceInfo {
  name: string;
  authority: string;
  url: string;
  license: string;
  coverage: string;
  languages: string[];
}

export interface ListSourcesResult {
  sources: SourceInfo[];
  database: {
    tier: string;
    schema_version: string;
    built_at?: string;
    document_count: number;
    provision_count: number;
  };
}

function safeCount(db: InstanceType<typeof Database>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

export async function listSources(
  db: InstanceType<typeof Database>,
): Promise<ToolResponse<ListSourcesResult>> {
  const meta = readDbMetadata(db);

  return {
    results: {
      sources: [
        {
          name: 'EUR-Lex SPARQL (Cyprus NIM)',
          authority: 'Publications Office of the European Union',
          url: 'https://publications.europa.eu/webapi/rdf/sparql',
          license: 'EU reuse policy (Commission Decision 2011/833/EU)',
          coverage: 'Cyprus national implementation measures (CELEX sector 7, country code CYP)',
          languages: ['en'],
        },
        {
          name: 'CySEC Circulars',
          authority: 'Cyprus Securities and Exchange Commission',
          url: 'https://www.cysec.gov.cy/en-GB/public-info/circulars/',
          license: 'Cyprus-PSI (Law 143(I)/2021)',
          coverage: 'CySEC supervisory circulars (metadata only)',
          languages: ['en'],
        },
      ],
      database: {
        tier: meta.tier,
        schema_version: meta.schema_version,
        built_at: meta.built_at,
        document_count: safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents'),
        provision_count: safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions'),
      },
    },
    _metadata: generateResponseMetadata(db),
  };
}
