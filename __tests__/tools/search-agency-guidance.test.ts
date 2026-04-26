/**
 * Unit + light-integration tests for search_agency_guidance.
 *
 * These run against an in-memory SQLite created from the canonical schema,
 * so they don't depend on the seed database having premium data. Real-data
 * smoke happens in fleet contract tests via backstage manifests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { searchAgencyGuidance } from '../../src/tools/search-agency-guidance.js';

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(':memory:');
  // Schema mirrors the canonical agency_guidance table from build-db-paid.ts.
  // Statements are run individually because better-sqlite3's prepare() does
  // not accept multiple statements in one call.
  db.prepare(`
    CREATE TABLE agency_guidance (
      id INTEGER PRIMARY KEY,
      agency TEXT NOT NULL,
      document_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      document_type TEXT,
      summary TEXT,
      full_text TEXT,
      issued_date TEXT,
      url TEXT,
      related_statute_id TEXT,
      provenance_tier TEXT
    )
  `).run();
  db.prepare(`
    CREATE VIRTUAL TABLE agency_guidance_fts USING fts5(
      title, summary, full_text,
      content='agency_guidance', content_rowid='id', tokenize='unicode61'
    )
  `).run();
  db.prepare(`
    CREATE TRIGGER agency_guidance_fts_insert AFTER INSERT ON agency_guidance BEGIN
      INSERT INTO agency_guidance_fts(rowid, title, summary, full_text)
      VALUES (new.id, new.title, new.summary, new.full_text);
    END
  `).run();

  // Seed: 2 DPA decisions and 2 CySEC circulars
  const insert = db.prepare(`
    INSERT INTO agency_guidance
      (agency, document_id, title, document_type, summary, full_text, issued_date, url, provenance_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'Commissioner for Personal Data Protection (Cyprus)',
    'cy-dpa-decision-001',
    'Commissioner Decision 1/2023 — Data minimisation breach',
    'decision',
    'A controller failed to apply data minimisation principles when sharing membership status with insurers.',
    'The Commissioner found that the controller breached Article 5(1)(c) of the GDPR by sharing more personal data than necessary.',
    '2023-04-12',
    'https://dataprotection.gov.cy/decisions/1-2023',
    'amber',
  );
  insert.run(
    'Commissioner for Personal Data Protection (Cyprus)',
    'cy-dpa-decision-002',
    'Commissioner Decision 2/2023 — Right to erasure',
    'decision',
    'A data subject requested erasure under Article 17 GDPR; controller refused.',
    'The Commissioner ruled in favour of the data subject and ordered erasure.',
    '2023-09-30',
    'https://dataprotection.gov.cy/decisions/2-2023',
    'amber',
  );
  insert.run(
    'Cyprus Securities and Exchange Commission (CySEC)',
    'cysec-circular-c001',
    'CySEC Circular C001 — MiCA implementation timeline',
    'circular',
    'CySEC supervisory expectations for MiCA-regulated entities.',
    'Crypto-asset service providers must register before the transitional period ends.',
    '2024-01-15',
    'https://cysec.gov.cy/circulars/c001',
    'amber',
  );
  insert.run(
    'Cyprus Securities and Exchange Commission (CySEC)',
    'cysec-circular-c002',
    'CySEC Circular C002 — DORA operational resilience',
    'circular',
    'Operational resilience expectations under DORA.',
    'Investment firms must implement ICT risk management frameworks.',
    '2024-03-20',
    'https://cysec.gov.cy/circulars/c002',
    'amber',
  );
});

describe('search_agency_guidance', () => {
  it('returns empty results for empty query', async () => {
    const r = await searchAgencyGuidance(db, { query: '' });
    expect(r.results).toEqual([]);
    expect(r._metadata).toBeDefined();
  });

  it('returns empty results for whitespace-only query', async () => {
    const r = await searchAgencyGuidance(db, { query: '   ' });
    expect(r.results).toEqual([]);
  });

  it('finds DPA decisions via FTS', async () => {
    const r = await searchAgencyGuidance(db, { query: 'data minimisation' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]?.agency).toContain('Commissioner');
    expect(r.results[0]?.snippet).toContain('>>>');
    expect(r.results[0]?.snippet).toContain('<<<');
  });

  it('filters by agency name (partial match)', async () => {
    const r = await searchAgencyGuidance(db, { query: 'circular', agency: 'CySEC' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every(x => x.agency.includes('CySEC'))).toBe(true);
  });

  it('filters by document_type', async () => {
    const r = await searchAgencyGuidance(db, { query: 'CySEC', document_type: 'circular' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every(x => x.document_type === 'circular')).toBe(true);
  });

  it('filters by date range', async () => {
    const r = await searchAgencyGuidance(db, {
      query: 'data',
      date_from: '2023-01-01',
      date_to: '2023-12-31',
    });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every(x => x.issued_date && x.issued_date.startsWith('2023'))).toBe(true);
  });

  it('respects limit parameter', async () => {
    const r = await searchAgencyGuidance(db, { query: 'circular', limit: 1 });
    expect(r.results.length).toBeLessThanOrEqual(1);
  });

  it('caps limit at MAX_LIMIT', async () => {
    const r = await searchAgencyGuidance(db, { query: 'circular', limit: 10000 });
    expect(r.results.length).toBeLessThanOrEqual(50);
  });

  it('falls back to LIKE when FTS variants miss', async () => {
    const r = await searchAgencyGuidance(db, { query: 'minimisation' });
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('returns _metadata with jurisdiction + disclaimer', async () => {
    const r = await searchAgencyGuidance(db, { query: 'GDPR' });
    expect(r._metadata.jurisdiction).toBe('CY');
    expect(r._metadata.disclaimer).toBeTruthy();
  });
});
