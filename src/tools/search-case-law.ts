/**
 * search_case_law — Full-text search across Cypriot court decisions.
 *
 * Indexes the case_law table populated from primary judiciary sources
 * (Supreme Court, ECHR Cyprus respondent cases, etc.). Sources are
 * documented in scripts/premium-ingestion/cypriot/sources.yml.
 *
 * As of 2026-04-26 the case_law table is schema-present but empty (0 rows)
 * — the Supreme Court Domino-XML adapter is the next ingestion task. This
 * tool returns empty results gracefully until that lands; the gateway
 * routing and tool discovery work today, so adding rows is the only work
 * needed to make the tool useful end-to-end.
 */

import type Database from '@ansvar/mcp-sqlite';
import { buildFtsQueryVariants, buildLikePattern, sanitizeFtsInput } from '../utils/fts-query.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface SearchCaseLawInput {
  query: string;
  court?: string;
  legal_field?: string;
  date_from?: string;
  date_to?: string;
  ecli?: string;
  limit?: number;
}

export interface CaseLawResult {
  document_id: string | null;
  court: string;
  case_number: string;
  decision_date: string | null;
  title: string | null;
  legal_field: string | null;
  ecli: string | null;
  url: string | null;
  snippet: string;
  relevance: number;
  provenance_tier: string | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function searchCaseLaw(
  db: InstanceType<typeof Database>,
  input: SearchCaseLawInput,
): Promise<ToolResponse<CaseLawResult[]>> {
  if (!input.query || input.query.trim().length === 0) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const fetchLimit = limit * 2;
  const queryVariants = buildFtsQueryVariants(sanitizeFtsInput(input.query));

  // ECLI exact match short-circuit: if the caller passes a fully-formed ECLI,
  // skip FTS and look it up directly. ECLIs are unique, so this is cheap and
  // returns immediately.
  if (input.ecli) {
    const sql = `
      SELECT
        cl.document_id,
        cl.court,
        cl.case_number,
        cl.decision_date,
        cl.title,
        cl.legal_field,
        cl.ecli,
        cl.url,
        cl.provenance_tier,
        substr(coalesce(cl.summary, cl.full_text, ''), 1, 300) as snippet,
        0 as relevance
      FROM case_law cl
      WHERE cl.ecli = ?
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(input.ecli, limit) as CaseLawResult[];
    if (rows.length > 0) {
      return {
        results: rows,
        _metadata: {
          ...generateResponseMetadata(db),
          query_strategy: 'ecli_exact',
        },
      };
    }
  }

  let queryStrategy: 'exact' | 'fallback' | 'like_fallback' | 'none' = 'none';

  for (const ftsQuery of queryVariants) {
    let sql = `
      SELECT
        cl.document_id,
        cl.court,
        cl.case_number,
        cl.decision_date,
        cl.title,
        cl.legal_field,
        cl.ecli,
        cl.url,
        cl.provenance_tier,
        snippet(case_law_fts, 0, '>>>', '<<<', '...', 32) as snippet,
        bm25(case_law_fts) as relevance
      FROM case_law_fts
      JOIN case_law cl ON cl.id = case_law_fts.rowid
      WHERE case_law_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (input.court) {
      sql += ' AND cl.court LIKE ? COLLATE NOCASE';
      params.push(`%${input.court}%`);
    }
    if (input.legal_field) {
      sql += ' AND cl.legal_field LIKE ? COLLATE NOCASE';
      params.push(`%${input.legal_field}%`);
    }
    if (input.date_from) {
      sql += ' AND cl.decision_date >= ?';
      params.push(input.date_from);
    }
    if (input.date_to) {
      sql += ' AND cl.decision_date <= ?';
      params.push(input.date_to);
    }

    sql += ' ORDER BY relevance LIMIT ?';
    params.push(fetchLimit);

    try {
      const rows = db.prepare(sql).all(...params) as CaseLawResult[];
      if (rows.length > 0) {
        queryStrategy = ftsQuery === queryVariants[0] ? 'exact' : 'fallback';
        return {
          results: deduplicate(rows, limit),
          _metadata: {
            ...generateResponseMetadata(db),
            ...(queryStrategy === 'fallback' ? { query_strategy: 'broadened' } : {}),
          },
        };
      }
    } catch {
      continue;
    }
  }

  // LIKE fallback
  {
    const likePattern = buildLikePattern(sanitizeFtsInput(input.query));
    let likeSql = `
      SELECT
        cl.document_id,
        cl.court,
        cl.case_number,
        cl.decision_date,
        cl.title,
        cl.legal_field,
        cl.ecli,
        cl.url,
        cl.provenance_tier,
        substr(coalesce(cl.summary, cl.full_text, ''), 1, 200) as snippet,
        0 as relevance
      FROM case_law cl
      WHERE (cl.title LIKE ? COLLATE NOCASE OR cl.summary LIKE ? COLLATE NOCASE OR cl.case_number LIKE ? COLLATE NOCASE)
    `;
    const likeParams: (string | number)[] = [likePattern, likePattern, likePattern];

    if (input.court) {
      likeSql += ' AND cl.court LIKE ? COLLATE NOCASE';
      likeParams.push(`%${input.court}%`);
    }
    if (input.legal_field) {
      likeSql += ' AND cl.legal_field LIKE ? COLLATE NOCASE';
      likeParams.push(`%${input.legal_field}%`);
    }
    if (input.date_from) {
      likeSql += ' AND cl.decision_date >= ?';
      likeParams.push(input.date_from);
    }
    if (input.date_to) {
      likeSql += ' AND cl.decision_date <= ?';
      likeParams.push(input.date_to);
    }

    likeSql += ' ORDER BY cl.decision_date DESC LIMIT ?';
    likeParams.push(fetchLimit);

    try {
      const rows = db.prepare(likeSql).all(...likeParams) as CaseLawResult[];
      if (rows.length > 0) {
        return {
          results: deduplicate(rows, limit),
          _metadata: {
            ...generateResponseMetadata(db),
            query_strategy: 'like_fallback',
          },
        };
      }
    } catch {
      // fall through
    }
  }

  return { results: [], _metadata: generateResponseMetadata(db) };
}

/**
 * Deduplicate by document_id (or ECLI as fallback for rows without a
 * document_id, e.g. early supreme-court ingestion). Keeps highest-ranked.
 */
function deduplicate(rows: CaseLawResult[], limit: number): CaseLawResult[] {
  const seen = new Set<string>();
  const deduped: CaseLawResult[] = [];
  for (const row of rows) {
    const key = row.document_id ?? row.ecli ?? `${row.court}::${row.case_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}
