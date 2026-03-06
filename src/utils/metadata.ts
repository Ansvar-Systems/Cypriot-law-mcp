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
    data_source: 'Cyprus Law Commissioner (cylaw.org) — Law Commissioner of the Republic of Cyprus',
    jurisdiction: 'CY',
    disclaimer:
      'This data is sourced from the Cyprus Law Commissioner portal (cylaw.org) under public domain. ' +
      'The authoritative versions are maintained by the Law Commissioner of the Republic of Cyprus. ' +
      'Always verify with the official Cyprus laws portal (cylaw.org).',
    freshness,
  };
}
