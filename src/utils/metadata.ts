/**
 * Response metadata utilities for Cypriot Law MCP.
 */

import type Database from '@ansvar/mcp-sqlite';

export interface ResponseMetadata {
  data_source: string;
  jurisdiction: string;
  disclaimer: string;
  freshness?: string;
  note?: string;
  query_strategy?: string;
}

export interface ToolResponse<T> {
  results: T;
  _metadata: ResponseMetadata;
  _citation?: import('./citation.js').CitationMetadata;
}

export function generateResponseMetadata(
  db: InstanceType<typeof Database>,
): ResponseMetadata {
  let freshness: string | undefined;
  try {
    const row = db.prepare(
      "SELECT value FROM db_metadata WHERE key = 'built_at'"
    ).get() as { value: string } | undefined;
    if (row) freshness = row.value;
  } catch {
    // Ignore
  }

  return {
    data_source: 'Premium adapters (CySEC circulars under Cyprus-PSI, EUR-Lex SPARQL under EUR-Lex-Decision-2011-833) — primary-source-only',
    jurisdiction: 'CY',
    disclaimer:
      'This data is sourced from primary government and EU portals. ' +
      'Always verify with the original publisher of each cited document.',
    freshness,
  };
}
