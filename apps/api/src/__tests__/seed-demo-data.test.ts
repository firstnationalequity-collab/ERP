// pnpm db:seed:demo-data: development-only sample data written through the normal services as the demo users.
// Same guard as db:seed:dev; a second run changes nothing.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../config/env';
import { DEMO_PO_APPROVED_NOTE, DEMO_PO_WAITING_NOTE, DEMO_USD_RATE, runDemoDataSeed } from '../db/seed/demo-data';
import { companyToday } from '../core/dates';

const client = new pg.Client({ connectionString: databaseUrl });
const DEMO = 'Demo-Password-2026';
const opts = { nodeEnv: 'development', databaseUrl, demoPassword: DEMO };

const one = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await client.query<T>(text, params)).rows;
const userId = async (username: string) => (await one<{ id: string }>(`SELECT id::text FROM core.users WHERE username = $1`, [username]))[0]!.id;

/**
 * Row counts of every table the seed writes to, plus the history and audit it leaves. Sign-ins are left out: each run
 * signs the demo users in and out (sessions, and the last-login stamp on core.users, which the audit trigger records).
 */
async function footprint(): Promise<Record<string, number>> {
  const tables = [
    'master.uoms', 'master.item_categories', 'master.items', 'master.vendors', 'master.approved_sources', 'master.customers',
    'master.warehouses', 'master.locations', 'master.products', 'master.master_formulas', 'master.master_formula_lines',
    'fin.exchange_rates', 'purch.purchase_orders', 'purch.po_lines', 'core.approvals', 'core.approval_steps',
    'core.attachments', 'core.status_history', 'core.e_signatures', 'core.users',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n;
  const audit = await one<{ t: string; n: number }>(
    `SELECT table_name AS t, count(*)::int AS n FROM core.audit_log WHERE table_name NOT IN ('core.sessions', 'core.users') GROUP BY 1`,
  );
  for (const r of audit) out[`audit_log ${r.t}`] = r.n;
  return out;
}

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe('db:seed:demo-data guard', () => {
  it('refuses outside development, on a production-looking database and without the demo password; writes nothing', async () => {
    await expect(runDemoDataSeed({ ...opts, nodeEnv: 'production' })).rejects.toThrow(/db:seed:demo-data refused: .*must be "development"/);
    await expect(runDemoDataSeed({ ...opts, nodeEnv: 'test' })).rejects.toThrow(/must be "development"/);
    await expect(runDemoDataSeed({ ...opts, databaseUrl: 'postgres://a:b@h/albert_erp_prod' })).rejects.toThrow(/looks like production/);
    await expect(runDemoDataSeed({ ...opts, demoPassword: undefined })).rejects.toThrow(/DEV_DEMO_PASSWORD/);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM master.items`))[0]!.n).toBe(0);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM core.users WHERE username LIKE 'demo.%'`))[0]!.n).toBe(0);
  });
});

describe('db:seed:demo-data', () => {
  it('creates the sample masters, rate and POs through the services, as the demo user of each role', async () => {
    const report = await runDemoDataSeed(opts);
    expect(report.skipped).toEqual([]);

    const itemRows = await one<{ code: string; type: string; status: string; created_by: string }>(
      `SELECT code, type, status, created_by::text FROM master.items ORDER BY code`,
    );
    expect(itemRows).toHaveLength(10);
    expect(itemRows.map((i) => i.type).sort()).toEqual(['API', 'API', 'EXCIPIENT', 'EXCIPIENT', 'EXCIPIENT', 'FG', 'FG', 'PM', 'PM', 'PM']);
    expect(itemRows.every((i) => i.status === 'ACTIVE')).toBe(true);
    const wm = await userId('demo.warehouse_manager');
    const qa = await userId('demo.qa_manager');
    expect(itemRows.every((i) => i.created_by === wm)).toBe(true);
    const activations = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.status_history WHERE entity_table = 'master.items' AND to_status = 'ACTIVE' AND actor_id = $1`,
      [qa],
    );
    expect(activations[0]!.n).toBe(10);

    const vendorRows = await one<{ code: string; currency: string; is_foreign: boolean; status: string }>(
      `SELECT code, currency, is_foreign, status FROM master.vendors ORDER BY code`,
    );
    expect(vendorRows).toHaveLength(3);
    expect(vendorRows.every((v) => v.status === 'ACTIVE')).toBe(true);
    expect(vendorRows.filter((v) => v.is_foreign)).toEqual([expect.objectContaining({ code: 'DM-V-IMP', currency: 'USD' })]);

    // Every API, excipient and packing item has an APPROVED source, approved by the QA Manager on evidence.
    const sources = await one<{ status: string; files: number; approver: string }>(
      `SELECT s.status,
              (SELECT count(*)::int FROM core.attachments a WHERE a.record_table = 'master.approved_sources' AND a.record_id = s.id::text) AS files,
              (SELECT h.actor_id::text FROM core.status_history h
                WHERE h.entity_table = 'master.approved_sources' AND h.entity_id = s.id::text AND h.to_status = 'APPROVED') AS approver
         FROM master.approved_sources s`,
    );
    expect(sources).toHaveLength(8);
    expect(sources.every((s) => s.status === 'APPROVED' && s.files === 1 && s.approver === qa)).toBe(true);

    expect(await one(`SELECT code, status FROM master.customers ORDER BY code`)).toEqual([
      { code: 'DM-C-001', status: 'ACTIVE' },
      { code: 'DM-C-002', status: 'ACTIVE' },
    ]);
    expect(await one(`SELECT code, is_returns_area FROM master.locations ORDER BY code`)).toEqual([
      { code: 'APPR', is_returns_area: false },
      { code: 'QUAR', is_returns_area: false },
      { code: 'REJ', is_returns_area: false },
      { code: 'RET', is_returns_area: true },
    ]);

    const formula = await one<{ status: string; lines: number; created_by: string }>(
      `SELECT f.status, (SELECT count(*)::int FROM master.master_formula_lines l WHERE l.formula_id = f.id) AS lines, f.created_by::text
         FROM master.master_formulas f`,
    );
    expect(formula).toEqual([{ status: 'APPROVED', lines: 4, created_by: await userId('demo.production_manager') }]);

    expect(await one(`SELECT currency, rate_date::text AS d, rate::text FROM fin.exchange_rates`)).toEqual([
      { currency: 'USD', d: companyToday(), rate: DEMO_USD_RATE },
    ]);

    const pos = await one<{ notes: string; status: string; currency: string; total_amount: string; created_by: string }>(
      `SELECT notes, status, currency, total_amount::text, created_by::text FROM purch.purchase_orders ORDER BY id`,
    );
    const officer = await userId('demo.purchase_officer');
    expect(pos).toEqual([
      { notes: DEMO_PO_APPROVED_NOTE, status: 'APPROVED', currency: 'PKR', total_amount: '280250.00', created_by: officer },
      { notes: DEMO_PO_WAITING_NOTE, status: 'PENDING_APPROVAL', currency: 'USD', total_amount: '3100.00', created_by: officer },
    ]);
    // The waiting PO sits with the Finance Manager (PKR value above the Purchase Manager band).
    const waiting = await one<{ role: string; status: string }>(
      `SELECT r.code AS role, s.status FROM core.approvals a JOIN core.approval_steps s ON s.approval_id = a.id JOIN core.roles r ON r.id = s.role_id
        JOIN purch.purchase_orders p ON p.id::text = a.doc_id::text AND a.doc_table = 'purch.purchase_orders' WHERE p.notes = $1`,
      [DEMO_PO_WAITING_NOTE],
    );
    expect(waiting).toEqual([{ role: 'FINANCE_MANAGER', status: 'PENDING' }]);

    // Signed out afterwards.
    const open = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.sessions s JOIN core.users u ON u.id = s.user_id WHERE u.username LIKE 'demo.%' AND s.revoked_at IS NULL`,
    );
    expect(open[0]!.n).toBe(0);
  });

  it('is idempotent: a second run reports nothing and changes no business row', async () => {
    const before = await footprint();
    const report = await runDemoDataSeed(opts);
    expect(report).toEqual({ done: [], skipped: [] });
    expect(await footprint()).toEqual(before);
  });
});
