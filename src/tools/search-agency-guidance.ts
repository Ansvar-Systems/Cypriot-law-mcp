/**
 * search_agency_guidance — Full-text search across regulatory agency guidance.
 *
 * Currently indexed agencies:
 *   - Cyprus Securities and Exchange Commission (CySEC) — 943 circular metadata
 *
 * Adapter sources are documented in scripts/premium-ingestion/cypriot/sources.yml.
 */

import type Database from '@ansvar/mcp-sqlite';
import { buildFtsQueryVariants, buildLikePattern, sanitizeFtsInput } from '../utils/fts-query.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface SearchAgencyGuidanceInput {
  query: string;
  agency?: string;
  document_type?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface AgencyGuidanceResult {
  document_id: string;
  agency: string;
  title: string;
  document_type: string | null;
  issued_date: string | null;
  url: string | null;
  related_statute_id: string | null;
  snippet: string;
  relevance: number;
  provenance_tier: string | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function searchAgencyGuidance(
  db: InstanceType<typeof Database>,
  input: SearchAgencyGuidanceInput,
): Promise<ToolResponse<AgencyGuidanceResult[]>> {
  if (!input.query || input.query.trim().length === 0) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const fetchLimit = limit * 2;
  const queryVariants = buildFtsQueryVariants(sanitizeFtsInput(input.query));

  let queryStrategy: 'exact' | 'fallback' | 'like_fallback' | 'none' = 'none';

  for (const ftsQuery of queryVariants) {
    let sql = `
      SELECT
        ag.document_id,
        ag.agency,
        ag.title,
        ag.document_type,
        ag.issued_date,
        ag.url,
        ag.related_statute_id,
        ag.provenance_tier,
        snippet(agency_guidance_fts, 1, '>>>', '<<<', '...', 32) as snippet,
        bm25(agency_guidance_fts) as relevance
      FROM agency_guidance_fts
      JOIN agency_guidance ag ON ag.id = agency_guidance_fts.rowid
      WHERE agency_guidance_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (input.agency) {
      sql += ' AND ag.agency LIKE ? COLLATE NOCASE';
      params.push(`%${input.agency}%`);
    }
    if (input.document_type) {
      sql += ' AND ag.document_type = ?';
      params.push(input.document_type);
    }
    if (input.date_from) {
      sql += ' AND ag.issued_date >= ?';
      params.push(input.date_from);
    }
    if (input.date_to) {
      sql += ' AND ag.issued_date <= ?';
      params.push(input.date_to);
    }

    sql += ' ORDER BY relevance LIMIT ?';
    params.push(fetchLimit);

    try {
      const rows = db.prepare(sql).all(...params) as AgencyGuidanceResult[];
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
      // FTS query syntax error — try next variant
      continue;
    }
  }

  // LIKE fallback — last resort when all FTS5 variants return empty.
  // Searches title and summary (full_text can be very large; the FTS index
  // already covers it via the snippet column).
  {
    const likePattern = buildLikePattern(sanitizeFtsInput(input.query));
    let likeSql = `
      SELECT
        ag.document_id,
        ag.agency,
        ag.title,
        ag.document_type,
        ag.issued_date,
        ag.url,
        ag.related_statute_id,
        ag.provenance_tier,
        substr(coalesce(ag.summary, ag.full_text, ''), 1, 200) as snippet,
        0 as relevance
      FROM agency_guidance ag
      WHERE (ag.title LIKE ? COLLATE NOCASE OR ag.summary LIKE ? COLLATE NOCASE)
    `;
    const likeParams: (string | number)[] = [likePattern, likePattern];

    if (input.agency) {
      likeSql += ' AND ag.agency LIKE ? COLLATE NOCASE';
      likeParams.push(`%${input.agency}%`);
    }
    if (input.document_type) {
      likeSql += ' AND ag.document_type = ?';
      likeParams.push(input.document_type);
    }
    if (input.date_from) {
      likeSql += ' AND ag.issued_date >= ?';
      likeParams.push(input.date_from);
    }
    if (input.date_to) {
      likeSql += ' AND ag.issued_date <= ?';
      likeParams.push(input.date_to);
    }

    likeSql += ' ORDER BY ag.issued_date DESC LIMIT ?';
    likeParams.push(fetchLimit);

    try {
      const rows = db.prepare(likeSql).all(...likeParams) as AgencyGuidanceResult[];
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
      // LIKE failed — fall through
    }
  }

  return { results: [], _metadata: generateResponseMetadata(db) };
}

/**
 * Deduplicate by document_id. The same decision can be matched twice if
 * multiple FTS columns hit. Keeps the highest-ranked occurrence.
 */
function deduplicate(rows: AgencyGuidanceResult[], limit: number): AgencyGuidanceResult[] {
  const seen = new Set<string>();
  const deduped: AgencyGuidanceResult[] = [];
  for (const row of rows) {
    if (seen.has(row.document_id)) continue;
    seen.add(row.document_id);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}
