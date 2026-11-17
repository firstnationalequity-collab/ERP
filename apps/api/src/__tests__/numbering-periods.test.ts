// core/numbering (Q16) and fiscal periods (rule 11, Q16): service, HTTP and database guards.
import pg from 'pg';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { databaseUrl } from '../config/env';
import { systemContext, withTransaction } from '../db/client';
import { runSeed } from '../db/seed/run';
import { companyToday } from '../core/dates';
import { nextDocNo } from '../core/settings/numbering.service';
import { assertPeriodOpen, closePeriod } from '../core/settings/periods.service';
import { authenticateToken, login } from '../core/auth/auth.service';
import { createTestUser, TEST_PASSWORD } from '../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};

const as = (who: string) => ({
  get: (url: string) => request(app).get(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object) => request(app).patch(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body),
});

/** Take a number in its own transaction (as a document-creating service would). */
const take = (docType: string, date?: string) => withTransaction(systemContext('test'), (tx) => nextDocNo(tx, docType, date));

async function periodId(name: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM core.fiscal_periods WHERE name = $1`, [name]);
  return rows[0]!.id;
}

async function asSystem(statements: (c: pg.Client) => Promise<unknown>): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await statements(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, role] of [
    ['fm', 'FINANCE_MANAGER'],
    ['admin', 'SYSTEM_ADMIN'],
    ['ceo', 'CEO'],
  ] as const) {
    await createTestUser({ username: `p_${name}`, roleCodes: [role] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `p_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await client.query(`
    CREATE TABLE core.t_post (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id BIGINT NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id),
      status TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED','REVERSED')),
      doc_date DATE
    );
    SELECT core.require_open_period('core.t_post', 'doc_date');
    CREATE TABLE core.t_ledger (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id BIGINT NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id),
      posted_on DATE NOT NULL
    );
    SELECT core.require_open_period('core.t_ledger', 'posted_on');
  `);
});

afterAll(async () => {
  await client.end();
});

// ------------------------------------------------------------------ numbering

describe('document numbers', () => {
  it('issues the documented defaults: PO-2627-00001, then 00002', async () => {
    expect(await take('PO', '2026-11-17')).toBe('PO-2627-00001');
    expect(await take('PO', '2026-11-18')).toBe('PO-2627-00002');
  });

  it('resets PO numbers each fiscal year, choosing the year from the document date', async () => {
    expect(await take('PO', '2027-07-01')).toBe('PO-2728-00001');
    expect(await take('PO', '2027-06-30')).toBe('PO-2627-00003');
  });

  it('resets batch numbers each calendar year: AP26-0001, AP27-0001', async () => {
    expect(await take('BATCH', '2026-12-31')).toBe('AP26-0001');
    expect(await take('BATCH', '2027-01-01')).toBe('AP27-0001');
    expect(await take('BATCH', '2027-06-30')).toBe('AP27-0002');
  });

  it('leaves no gap when the document transaction rolls back', async () => {
    await expect(
      withTransaction(systemContext('test'), async (tx) => {
        expect(await nextDocNo(tx, 'PO', '2026-12-01')).toBe('PO-2627-00004');
        throw new Error('document failed');
      }),
    ).rejects.toThrow('document failed');
    expect(await take('PO', '2026-12-01')).toBe('PO-2627-00004');
  });

  it('never hands out the same number twice under concurrency (20 parallel documents)', async () => {
    await asSystem((c) =>
      c.query(`INSERT INTO core.number_series (doc_type, name, prefix, pattern, reset) VALUES ('TST','Test','T','{PREFIX}-{SEQ:4}','NEVER')`),
    );
    const numbers = await Promise.all(Array.from({ length: 20 }, () => take('TST', '2026-11-17')));
    expect(new Set(numbers).size).toBe(20);
    expect([...numbers].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `T-${String(i + 1).padStart(4, '0')}`));
  });

  it('refuses an unknown series and an invalid date', async () => {
    await expect(take('NOPE', '2026-11-17')).rejects.toMatchObject({ code: 'NUMBER_SERIES_MISSING', status: 422 });
    await expect(take('PO', '2026-02-30')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps counters moving forward only and never deleted', async () => {
    await expect(asSystem((c) => c.query(`UPDATE core.number_series_counters SET next_value = 1`))).rejects.toThrow(/APPEND_ONLY/);
    await expect(asSystem((c) => c.query(`DELETE FROM core.number_series_counters`))).rejects.toThrow(/APPEND_ONLY/);
  });

  it("uses the company's date (Asia/Karachi), not UTC: 20:00 UTC on 30 June is 1 July in Karachi", () => {
    expect(companyToday(new Date('2026-06-30T20:00:00Z'))).toBe('2026-07-01');
    expect(companyToday(new Date('2026-06-30T18:59:00Z'))).toBe('2026-06-30');
  });
});

describe('number series admin (core.settings.manage)', () => {
  it('lists series with a preview of the next number, and refuses non-admins', async () => {
    const res = await as('admin').get('/number-series');
    expect(res.status).toBe(200);
    const po = res.body.find((s: { docType: string }) => s.docType === 'PO');
    expect(po).toMatchObject({ pattern: '{PREFIX}-{FY}-{SEQ:5}', reset: 'FISCAL_YEAR' });
    expect(po.preview).toMatch(/^PO-\d{4}-\d{5}$/);
    expect((await as('ceo').get('/number-series')).status).toBe(403);
    expect((await as('fm').get('/number-series')).status).toBe(403);
  });

  it('refuses a pattern that would repeat numbers', async () => {
    const res = await as('admin').post('/number-series', {
      docType: 'GRN',
      name: 'Goods receipt',
      prefix: 'GRN',
      pattern: '{PREFIX}-{SEQ:5}',
      reset: 'FISCAL_YEAR',
      reason: 'Set up GRN',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must contain \{FY\}/);
  });

  it('creates and edits a series, refusing an edit that breaks the pattern/reset pair, with the reason audited', async () => {
    const created = await as('admin').post('/number-series', {
      docType: 'GRN',
      name: 'Goods receipt',
      prefix: 'GRN',
      pattern: '{PREFIX}-{FY}-{SEQ:5}',
      reset: 'FISCAL_YEAR',
      reason: 'Set up GRN',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const bad = await as('admin').patch(`/number-series/${id}`, { reset: 'CALENDAR_YEAR', reason: 'Try calendar' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    const ok = await as('admin').patch(`/number-series/${id}`, { prefix: 'GR', reason: 'Shorter prefix' });
    expect(ok.status).toBe(200);
    expect(ok.body.preview).toMatch(/^GR-\d{4}-00001$/);
    const audit = await client.query(
      `SELECT reason FROM core.audit_log WHERE table_name = 'core.number_series' AND record_id = $1 AND action = 'UPDATE'`,
      [id],
    );
    expect(audit.rows).toEqual([{ reason: 'Shorter prefix' }]);

    const dup = await as('admin').post('/number-series', {
      docType: 'GRN',
      name: 'Again',
      prefix: 'G',
      pattern: '{PREFIX}-{FY}-{SEQ:5}',
      reset: 'FISCAL_YEAR',
      reason: 'Duplicate',
    });
    expect(dup.status).toBe(409);
  });
});

// ------------------------------------------------------------------ fiscal periods

describe('fiscal years and periods', () => {
  it('creates FY 2026-27 as 12 OPEN monthly periods, July to June, with status history', async () => {
    const res = await as('fm').post('/fiscal-years', { startYear: 2026 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(12);
    expect(res.body[0]).toMatchObject({ fiscalYear: '2026-27', periodNo: 1, name: 'Jul-2026', startDate: '2026-07-01', endDate: '2026-07-31', status: 'OPEN' });
    expect(res.body[11]).toMatchObject({ periodNo: 12, name: 'Jun-2027', startDate: '2027-06-01', endDate: '2027-06-30' });
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM core.status_history WHERE entity_table = 'core.fiscal_periods' AND from_status IS NULL AND to_status = 'OPEN'`,
    );
    expect(rows[0].n).toBe(12);
  });

  it('refuses creating the same fiscal year twice (409) and refuses non-finance users (403)', async () => {
    expect((await as('fm').post('/fiscal-years', { startYear: 2026 })).status).toBe(409);
    expect((await as('admin').post('/fiscal-years', { startYear: 2027 })).status).toBe(403);
    expect((await as('ceo').post('/fiscal-years', { startYear: 2027 })).status).toBe(403);
  });

  it('lets finance and the CEO read periods (CEO has fin.view)', async () => {
    expect((await as('ceo').get('/fiscal-periods?fiscalYear=2026-27')).body).toHaveLength(12);
    expect((await as('admin').get('/fiscal-periods')).status).toBe(403);
  });

  it('closes a period with a reason, refuses closing twice, and reopens with a reason', async () => {
    const id = await periodId('Jul-2026');
    expect((await as('fm').post(`/fiscal-periods/${id}/close`, {})).status).toBe(400);
    expect((await as('ceo').post(`/fiscal-periods/${id}/close`, { reason: 'Month end' })).status).toBe(403);

    const closed = await as('fm').post(`/fiscal-periods/${id}/close`, { reason: 'July month end' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    const again = await as('fm').post(`/fiscal-periods/${id}/close`, { reason: 'Again' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');

    const reopened = await as('fm').post(`/fiscal-periods/${id}/reopen`, { reason: 'Late supplier invoice' });
    expect(reopened.body.status).toBe('OPEN');
    const { rows } = await client.query(
      `SELECT from_status, to_status, reason FROM core.status_history
        WHERE entity_table = 'core.fiscal_periods' AND entity_id = $1 AND from_status IS NOT NULL ORDER BY id`,
      [id],
    );
    expect(rows).toEqual([
      { from_status: 'OPEN', to_status: 'CLOSED', reason: 'July month end' },
      { from_status: 'CLOSED', to_status: 'OPEN', reason: 'Late supplier invoice' },
    ]);
  });

  it('never changes period dates, never deletes a period, never changes status outside core/transition', async () => {
    const id = await periodId('Aug-2026');
    await expect(asSystem((c) => c.query(`UPDATE core.fiscal_periods SET end_date = '2026-08-30' WHERE id = $1`, [id]))).rejects.toThrow(
      /FORBIDDEN/,
    );
    await expect(asSystem((c) => c.query(`DELETE FROM core.fiscal_periods WHERE id = $1`, [id]))).rejects.toThrow(/APPEND_ONLY/);
    await expect(asSystem((c) => c.query(`UPDATE core.fiscal_periods SET status = 'CLOSED' WHERE id = $1`, [id]))).rejects.toThrow(
      /INVALID_TRANSITION/,
    );
  });
});

describe('rule 11: a closed period accepts no postings', () => {
  it('assertPeriodOpen: open passes, closed is PERIOD_CLOSED, no period is PERIOD_NOT_DEFINED', async () => {
    const sep = await periodId('Sep-2026');
    const fm = await authenticateToken((await login({ username: 'p_fm', password: TEST_PASSWORD }, { ip: null, userAgent: null })).accessToken);
    await closePeriod(fm, sep, 'September closed');

    await expect(withTransaction(systemContext(), (tx) => assertPeriodOpen(tx, '2026-10-15'))).resolves.toBeUndefined();
    await expect(withTransaction(systemContext(), (tx) => assertPeriodOpen(tx, '2026-09-15'))).rejects.toThrow(/PERIOD_CLOSED/);
    await expect(withTransaction(systemContext(), (tx) => assertPeriodOpen(tx, '2030-01-01'))).rejects.toThrow(/PERIOD_NOT_DEFINED/);
  });

  it('refuses a POSTED document dated in a closed period (database guard), but allows a DRAFT', async () => {
    await expect(asSystem((c) => c.query(`INSERT INTO core.t_post (status, doc_date) VALUES ('POSTED', '2026-09-10')`))).rejects.toThrow(
      /PERIOD_CLOSED/,
    );
    await asSystem((c) => c.query(`INSERT INTO core.t_post (status, doc_date) VALUES ('DRAFT', '2026-09-10')`));
    await expect(
      asSystem((c) => c.query(`UPDATE core.t_post SET status = 'POSTED' WHERE doc_date = '2026-09-10' AND status = 'DRAFT'`)),
    ).rejects.toThrow(/PERIOD_CLOSED/);
    await expect(asSystem((c) => c.query(`INSERT INTO core.t_post (status, doc_date) VALUES ('POSTED', '2030-01-01')`))).rejects.toThrow(
      /PERIOD_NOT_DEFINED/,
    );
  });

  it('refuses a ledger row (no status column) dated in a closed period', async () => {
    await expect(asSystem((c) => c.query(`INSERT INTO core.t_ledger (posted_on) VALUES ('2026-09-30')`))).rejects.toThrow(/PERIOD_CLOSED/);
    await asSystem((c) => c.query(`INSERT INTO core.t_ledger (posted_on) VALUES ('2026-10-01')`));
  });

  it('still lets an old document be marked REVERSED after its period closed (the reversal posts in an open period)', async () => {
    await asSystem((c) => c.query(`INSERT INTO core.t_post (status, doc_date) VALUES ('POSTED', '2026-11-05')`));
    const nov = await periodId('Nov-2026');
    const fm = await authenticateToken((await login({ username: 'p_fm', password: TEST_PASSWORD }, { ip: null, userAgent: null })).accessToken);
    await closePeriod(fm, nov, 'November closed');
    await asSystem((c) => c.query(`UPDATE core.t_post SET status = 'REVERSED' WHERE doc_date = '2026-11-05'`));
    await asSystem((c) => c.query(`INSERT INTO core.t_post (status, doc_date) VALUES ('POSTED', '2026-12-01')`));
  });

  it('makes a period close wait for a posting already in progress (share lock), so nothing slips in', async () => {
    const dec = await periodId('Dec-2026');
    const fm = await authenticateToken((await login({ username: 'p_fm', password: TEST_PASSWORD }, { ip: null, userAgent: null })).accessToken);
    const poster = new pg.Client({ connectionString: databaseUrl });
    await poster.connect();
    try {
      await poster.query('BEGIN');
      await poster.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
      await poster.query(`INSERT INTO core.t_post (status, doc_date) VALUES ('POSTED', '2026-12-15')`);

      let settled = false;
      const closing = closePeriod(fm, dec, 'December closed').finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // waiting for the posting transaction
      await poster.query('COMMIT');
      expect((await closing).status).toBe('CLOSED');
    } finally {
      await poster.end();
    }
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.t_post WHERE doc_date = '2026-12-15'`);
    expect(rows[0].n).toBe(1);
  });
});

describe('sql helper sanity', () => {
  it('runs nextDocNo in the caller transaction (same tx id as the document)', async () => {
    const [a, b] = await withTransaction(systemContext('test'), async (tx) => {
      const before = await tx.execute<{ t: string }>(sql`SELECT txid_current()::text AS t`);
      await nextDocNo(tx, 'BATCH', '2026-11-17');
      const after = await tx.execute<{ t: string }>(sql`SELECT txid_current()::text AS t`);
      return [before.rows[0]!.t, after.rows[0]!.t];
    });
    expect(a).toBe(b);
  });
});
