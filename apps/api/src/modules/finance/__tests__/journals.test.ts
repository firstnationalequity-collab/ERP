// Journals API (M2 task 7): read only, fin.view. Journals are written by engines/posting; there is no write route.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { systemContext, withTransaction, type Tx } from '../../../db/client';
import { runSeed } from '../../../db/seed/run';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';
import { postJournal, reverseJournal, type JournalEntry } from '../../../engines/posting';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const entries: Record<string, JournalEntry> = {};

const get = (who: string, url: string) => request(app).get(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  const ids: Record<string, string> = {};
  for (const [who, roleCodes] of [
    ['acc', ['ACCOUNTANT']],
    ['ceo', ['CEO']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['admin', ['SYSTEM_ADMIN']],
    ['store', ['STOREKEEPER']],
    ['fm', ['FINANCE_MANAGER']],
  ] as const) {
    ids[who] = await createTestUser({ username: `j_${who}`, roleCodes: [...roleCodes] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `j_${who}`, password: TEST_PASSWORD });
    tokens[who] = res.body.accessToken as string;
  }
  // Periods as the Finance Manager creates them (history row first, rule 7).
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id', '1', true)`, [ids.fm]);
  for (const [no, name, start, end] of [
    [5, 'Nov-2026', '2026-11-01', '2026-11-30'],
    [6, 'Dec-2026', '2026-12-01', '2026-12-31'],
  ] as const) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', $1, $2, $3, $4, 'OPEN') RETURNING id`,
      [no, name, start, end],
    );
    await client.query(
      `INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ('core.fiscal_periods', $1, NULL, 'OPEN', $2)`,
      [rows[0]!.id, ids.fm],
    );
  }
  await client.query('COMMIT');
  const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, ids.store!));
  const store: Actor = { userId: ids.store!, companyId: '1', permissions: new Set(keys) };
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    withTransaction({ userId: store.userId, companyId: '1' }, work);
  entries.a = await as((tx) =>
    postJournal(tx, store, {
      event: 'GRN_RECEIPT', sourceType: 'GRN', sourceId: '11', date: '2026-11-10', narration: 'Receipt of paracetamol',
      lines: [{ role: 'INVENTORY', debit: '1200.50' }, { role: 'GRNI', credit: '1200.50' }],
    }),
  );
  entries.b = await as((tx) =>
    postJournal(tx, store, {
      event: 'MATERIAL_ISSUE', sourceType: 'PROD_ORDER', sourceId: '12', date: '2026-12-02', narration: 'Issue to batch',
      lines: [{ role: 'WIP', debit: '300.00' }, { role: 'INVENTORY', credit: '300.00' }],
    }),
  );
  entries.rev = await as((tx) => reverseJournal(tx, store, { entryId: entries.b!.id, date: '2026-12-03', reason: 'issued in error' }));
});

afterAll(async () => {
  await client.end();
});

describe('GET /fin/journals', () => {
  it('needs fin.view: Accountant and CEO read; master.view alone or admin keys do not', async () => {
    expect((await get('acc', '/fin/journals')).status).toBe(200);
    expect((await get('ceo', `/fin/journals/${entries.a!.id}`)).status).toBe(200);
    expectError(await get('wm', '/fin/journals'), 403, 'FORBIDDEN');
    expectError(await get('admin', `/fin/journals/${entries.a!.id}`), 403, 'FORBIDDEN');
  });

  it('lists newest first with totals and filters by status, event, kind, source, date and text', async () => {
    const all = await get('acc', '/fin/journals');
    expect(all.body).toMatchObject({ total: 3, page: 1 });
    expect(all.body.items.map((e: { id: string }) => e.id)).toEqual([entries.rev!.id, entries.b!.id, entries.a!.id]);
    expect(all.body.items[2]).toMatchObject({ docNo: entries.a!.docNo, total: '1200.50', status: 'POSTED', event: 'GRN_RECEIPT' });
    expect(all.body.items.map((e: { total: string }) => e.total)).toEqual(['300.00', '300.00', '1200.50']);
    const ids = async (qs: string) => (await get('acc', `/fin/journals?${qs}`)).body.items.map((e: { id: string }) => e.id);
    expect(await ids('status=REVERSED')).toEqual([entries.b!.id]);
    expect(await ids('event=GRN_RECEIPT')).toEqual([entries.a!.id]);
    expect(await ids('kind=MANUAL')).toEqual([]);
    expect(await ids('sourceType=PROD_ORDER&sourceId=12')).toEqual([entries.rev!.id, entries.b!.id]);
    expect(await ids('dateFrom=2026-12-01&dateTo=2026-12-02')).toEqual([entries.b!.id]);
    expect(await ids('search=paracetamol')).toEqual([entries.a!.id]);
    expect(await ids(`search=${entries.rev!.docNo}`)).toEqual([entries.rev!.id]);
    expect(await ids('pageSize=1&page=2')).toEqual([entries.b!.id]);
    expectError(await get('acc', '/fin/journals?dateFrom=2026-12-02&dateTo=2026-12-01'), 400, 'VALIDATION_FAILED');
    expectError(await get('acc', '/fin/journals?status=OPEN'), 400, 'VALIDATION_FAILED');
  });

  it('shows one entry with its lines and accounts; reversal links both ways; 404 for an unknown id', async () => {
    const res = await get('acc', `/fin/journals/${entries.b!.id}`);
    expect(res.body).toMatchObject({ status: 'REVERSED', reversalId: entries.rev!.id, total: '300.00' });
    expect(res.body.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['1320', '300.00', '0.00'],
      ['1310', '0.00', '300.00'],
    ]);
    expect((await get('acc', `/fin/journals/${entries.rev!.id}`)).body).toMatchObject({ reversalOf: entries.b!.id, entryDate: '2026-12-03' });
    expectError(await get('acc', '/fin/journals/999999'), 404, 'NOT_FOUND');
  });

  it('has no write routes: journals are posted only by engines/posting', async () => {
    for (const method of ['post', 'patch', 'put', 'delete'] as const) {
      const res = await request(app)[method](`/api/v1/fin/journals/${entries.a!.id}`).set('Authorization', `Bearer ${tokens.acc}`).send({});
      expect(res.status).toBe(404);
    }
    expect((await request(app).post('/api/v1/fin/journals').set('Authorization', `Bearer ${tokens.acc}`).send({})).status).toBe(404);
  });
});
