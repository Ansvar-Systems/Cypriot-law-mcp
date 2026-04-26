/**
 * Unit + light-integration tests for search_case_law.
 *
 * In-memory SQLite with the canonical case_law schema. Real-data smoke
 * happens in fleet contract tests once the Supreme Court adapter ships.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { searchCaseLaw } from '../../src/tools/search-case-law.js';

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(':memory:');
  db.prepare(`
    CREATE TABLE case_law (
      id INTEGER PRIMARY KEY,
      court TEXT NOT NULL,
      case_number TEXT NOT NULL,
      decision_date TEXT,
      document_id TEXT UNIQUE,
      title TEXT,
      summary TEXT,
      full_text TEXT,
      legal_field TEXT,
      keywords TEXT,
      norms_cited TEXT,
      ecli TEXT,
      url TEXT,
      court_type TEXT,
      proceeding_type TEXT,
      source TEXT NOT NULL DEFAULT 'official',
      provenance_tier TEXT
    )
  `).run();
  db.prepare(`
    CREATE VIRTUAL TABLE case_law_fts USING fts5(
      summary, full_text, title,
      content='case_law', content_rowid='id', tokenize='unicode61'
    )
  `).run();
  db.prepare(`
    CREATE TRIGGER case_law_fts_insert AFTER INSERT ON case_law BEGIN
      INSERT INTO case_law_fts(rowid, summary, full_text, title)
      VALUES (new.id, new.summary, new.full_text, new.title);
    END
  `).run();

  const insert = db.prepare(`
    INSERT INTO case_law
      (court, case_number, decision_date, document_id, title, summary, full_text,
       legal_field, ecli, url, source, provenance_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'Supreme Court of Cyprus', 'Civil Appeal 123/2018', '2018-06-15',
    'cy-sc-2018-123',
    'Civil Appeal 123/2018 — unjust enrichment',
    'The Supreme Court considered the elements of unjust enrichment under Cypriot law.',
    'The court reviewed the trial judge\'s findings on enrichment, deprivation, and absence of juristic reason.',
    'contract', 'ECLI:CY:AD:2018:123', 'https://supremecourt.gov.cy/aad/2018/123',
    'official', 'blue',
  );
  insert.run(
    'Supreme Court of Cyprus', 'Constitutional Reference 5/2020', '2020-11-04',
    'cy-sc-2020-cr5',
    'Constitutional Reference 5/2020 — separation of powers',
    'The Supreme Court interpreted the constitutional limits of executive rule-making.',
    'The court held that primary legislation was required for the contested measure.',
    'constitutional', 'ECLI:CY:AD:2020:CR5', 'https://supremecourt.gov.cy/aad/2020/cr5',
    'official', 'blue',
  );
  insert.run(
    'European Court of Human Rights', 'Application 12345/19', '2022-03-10',
    'echr-cy-12345-19',
    'X v. Cyprus (Application 12345/19) — Article 8',
    'ECHR found a violation of Article 8 (right to private life) regarding data retention.',
    'The Court held that the retention scheme lacked sufficient safeguards.',
    'data protection', 'ECLI:CE:ECHR:2022:0310JUD001234519', 'https://hudoc.echr.coe.int/eng?i=001-216123',
    'official', 'blue',
  );
});

describe('search_case_law', () => {
  it('returns empty results for empty query', async () => {
    const r = await searchCaseLaw(db, { query: '' });
    expect(r.results).toEqual([]);
  });

  it('finds Supreme Court cases via FTS', async () => {
    const r = await searchCaseLaw(db, { query: 'unjust enrichment' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]?.court).toContain('Supreme Court');
  });

  it('returns ECHR cases via FTS', async () => {
    const r = await searchCaseLaw(db, { query: 'data retention' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.some(x => x.court.includes('European Court'))).toBe(true);
  });

  it('ECLI exact match short-circuits FTS', async () => {
    const r = await searchCaseLaw(db, {
      query: 'ignored when ECLI present',
      ecli: 'ECLI:CY:AD:2018:123',
    });
    expect(r.results.length).toBe(1);
    expect(r.results[0]?.ecli).toBe('ECLI:CY:AD:2018:123');
    expect(r._metadata.query_strategy).toBe('ecli_exact');
  });

  it('ECLI miss falls through to FTS', async () => {
    const r = await searchCaseLaw(db, {
      query: 'unjust enrichment',
      ecli: 'ECLI:CY:AD:9999:NOPE',
    });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r._metadata.query_strategy).not.toBe('ecli_exact');
  });

  it('filters by court (partial match)', async () => {
    const r = await searchCaseLaw(db, { query: 'court', court: 'Supreme' });
    expect(r.results.every(x => x.court.includes('Supreme'))).toBe(true);
  });

  it('filters by legal_field', async () => {
    const r = await searchCaseLaw(db, { query: 'court', legal_field: 'constitutional' });
    expect(r.results.every(x => x.legal_field === 'constitutional')).toBe(true);
  });

  it('filters by date range', async () => {
    const r = await searchCaseLaw(db, {
      query: 'court',
      date_from: '2020-01-01',
      date_to: '2021-12-31',
    });
    expect(r.results.every(x => x.decision_date && x.decision_date >= '2020-01-01' && x.decision_date <= '2021-12-31')).toBe(true);
  });

  it('respects limit parameter', async () => {
    const r = await searchCaseLaw(db, { query: 'court', limit: 1 });
    expect(r.results.length).toBeLessThanOrEqual(1);
  });

  it('falls back to LIKE when FTS finds nothing', async () => {
    // case_number is not indexed in FTS; LIKE fallback should pick it up
    const r = await searchCaseLaw(db, { query: '12345/19' });
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('returns _metadata with jurisdiction + disclaimer', async () => {
    const r = await searchCaseLaw(db, { query: 'court' });
    expect(r._metadata.jurisdiction).toBe('CY');
    expect(r._metadata.disclaimer).toBeTruthy();
  });

  it('snippet contains FTS markers when matching', async () => {
    const r = await searchCaseLaw(db, { query: 'enrichment' });
    if (r.results.length > 0 && r._metadata.query_strategy !== 'like_fallback') {
      expect(r.results[0]?.snippet).toContain('>>>');
    }
  });
});
