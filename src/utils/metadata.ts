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
    data_source: 'Official Legal Database (cylaw.org) — Government (State Chancellery of Cypriot)',
    jurisdiction: 'EE',
    disclaimer:
      'This data is sourced from the Official Legal Database under public domain. ' +
      'The authoritative versions are maintained by Government (State Chancellery of Cypriot). ' +
      'Always verify with the official Official Legal Database portal (cylaw.org).',
    freshness,
  };
}
