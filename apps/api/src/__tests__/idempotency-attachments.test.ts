// Idempotency-Key (Q11) and attachments (Q17).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { databaseUrl, env } from '../config/env';
import { withTransaction } from '../db/client';
import { runSeed } from '../db/seed/run';
import { AppError, errorHandler } from '../core/errors';
import { authenticate } from '../core/auth/middleware';
import { authenticateToken, txContext } from '../core/auth/auth.service';
import { idempotent, purgeExpiredIdempotencyKeys, requestHash } from '../core/idempotency/idempotency';
import { registerAttachmentTarget } from '../core/attachments/attachments.service';
import { LocalDiskStorage } from '../core/storage/storage';
import { registerApprovalHandler, startApproval } from '../core/approvals/approvals.service';
import { createTestUser, TEST_PASSWORD } from '../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};

// ---- a test app with idempotent "posting" routes
let posted = 0;
let failOnce = false;
const testApp = express();
testApp.use(express.json());
testApp.post('/post/:id', authenticate, idempotent(), (req, res, next) => {
  const delay = Number(req.query.delay ?? 0);
  setTimeout(() => {
    if (failOnce) {
      failOnce = false;
      next(new Error('database down'));
      return;
    }
    if (req.body?.amount === 'refuse') {
      next(new AppError('PERIOD_CLOSED', 'Period closed'));
      return;
    }
    posted += 1;
    res.status(201).json({ posted, id: req.params.id, amount: req.body?.amount });
  }, delay);
});
testApp.use(errorHandler);

const post = (who: string, url: string, key: string | null, body: object) => {
  const r = request(testApp).post(url).set('Authorization', `Bearer ${tokens[who]}`);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

// ---- an attachment target: records 1 and 2 of test.records exist
registerAttachmentTarget('test.records', {
  readPermission: 'qc.view',
  writePermission: 'qc.result.enter',
  exists: async (_q, id) => id === '1' || id === '2',
});

const upload = (who: string, url: string, body: Buffer, contentType: string, fileName: string) =>
  request(app)
    .post(`/api/v1/core${url}`)
    .set('Authorization', `Bearer ${tokens[who]}`)
    .set('Content-Type', contentType)
    .set('X-File-Name', encodeURIComponent(fileName))
    .send(body);

const PDF = Buffer.from('%PDF-1.4\n% test certificate of analysis\n%%EOF\n');

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, role] of [
    ['a', 'QC_ANALYST'],
    ['b', 'QC_ANALYST'],
    ['qcm', 'QC_MANAGER'],
    ['planner', 'PLANNER'],
    ['buyer', 'PURCHASE_OFFICER'],
    ['pm', 'PURCHASE_MANAGER'],
    ['fm', 'FINANCE_MANAGER'],
  ] as const) {
    await createTestUser({ username: `i_${name}`, roleCodes: [role] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `i_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
});

afterAll(async () => {
  await client.end();
});

// ------------------------------------------------------------------ idempotency

describe('Idempotency-Key on posting actions', () => {
  it('requires the header on a posting action and checks its format', async () => {
    expect((await post('a', '/post/1', null, { amount: '10' })).status).toBe(400);
    const bad = await post('a', '/post/1', 'short', { amount: '10' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('runs once and replays the stored response for the same key and request', async () => {
    const before = posted;
    const first = await post('a', '/post/7', 'key-replay-0001', { amount: '10', note: 'x' });
    expect(first.status).toBe(201);
    const second = await post('a', '/post/7', 'key-replay-0001', { note: 'x', amount: '10' }); // same body, keys reordered
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(posted).toBe(before + 1);
  });

  it('refuses the same key for a different body or a different document (409 DUPLICATE_REQUEST)', async () => {
    await post('a', '/post/8', 'key-dup-00000001', { amount: '10' });
    const otherBody = await post('a', '/post/8', 'key-dup-00000001', { amount: '11' });
    expect(otherBody.status).toBe(409);
    expect(otherBody.body.error.code).toBe('DUPLICATE_REQUEST');
    expect((await post('a', '/post/9', 'key-dup-00000001', { amount: '10' })).status).toBe(409);
  });

  it('keeps keys per user', async () => {
    const before = posted;
    await post('a', '/post/10', 'key-per-user-001', { amount: '1' });
    await post('b', '/post/10', 'key-per-user-001', { amount: '1' });
    expect(posted).toBe(before + 2);
  });

  it('refuses a second request while the first is still running (double click)', async () => {
    const before = posted;
    // supertest sends lazily: .then() fires the first request now.
    const slow = post('a', '/post/11?delay=300', 'key-double-click1', { amount: '5' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 80));
    const fast = await post('a', '/post/11?delay=300', 'key-double-click1', { amount: '5' });
    expect(fast.status).toBe(409);
    expect(fast.body.error.message).toMatch(/still being processed/);
    expect((await slow).status).toBe(201);
    expect(posted).toBe(before + 1);
  });

  it('stores and replays a business refusal (4xx)', async () => {
    const first = await post('a', '/post/12', 'key-refusal-0001', { amount: 'refuse' });
    expect(first.status).toBe(422);
    const again = await post('a', '/post/12', 'key-refusal-0001', { amount: 'refuse' });
    expect(again.status).toBe(422);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });

  it('releases the key after a server error (5xx) so the retry runs', async () => {
    const before = posted;
    failOnce = true;
    expect((await post('a', '/post/13', 'key-retry-500-01', { amount: '3' })).status).toBe(500);
    const retry = await post('a', '/post/13', 'key-retry-500-01', { amount: '3' });
    expect(retry.status).toBe(201);
    expect(posted).toBe(before + 1);
  });

  it('lets an expired key be used again, and purges expired keys', async () => {
    const userId = (await authenticateToken(tokens.a!)).userId;
    await withTransaction({ userId, companyId: '1' }, (tx) =>
      tx.execute(sql`
        INSERT INTO core.idempotency_keys (user_id, key, endpoint, request_hash, status, expires_at)
        VALUES (${userId}, 'key-expired-0001', 'POST /x', ${'0'.repeat(64)}, 'IN_PROGRESS', now() - interval '1 hour')`),
    );
    const res = await post('a', '/post/14', 'key-expired-0001', { amount: '1' });
    expect(res.status).toBe(201);
    await withTransaction({ userId, companyId: '1' }, (tx) =>
      tx.execute(sql`
        INSERT INTO core.idempotency_keys (user_id, key, endpoint, request_hash, status, expires_at)
        VALUES (${userId}, 'key-expired-0002', 'POST /x', ${'0'.repeat(64)}, 'IN_PROGRESS', now() - interval '1 hour')`),
    );
    expect(await purgeExpiredIdempotencyKeys()).toBeGreaterThanOrEqual(1);
  });

  it('never stores passwords: they are left out of the request hash', () => {
    expect(requestHash({ signature: { password: 'One-Pass-1', meaning: 'APPROVED' } })).toBe(
      requestHash({ signature: { password: 'Other-Pass-2', meaning: 'APPROVED' } }),
    );
  });

  it('keeps completed keys until they expire', async () => {
    await expect(client.query(`DELETE FROM core.idempotency_keys WHERE status = 'COMPLETED'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(client.query(`UPDATE core.idempotency_keys SET response_status = 200 WHERE status = 'COMPLETED'`)).rejects.toThrow(
      /APPEND_ONLY/,
    );
  });

  it('makes a double-clicked approval replay instead of failing', async () => {
    registerApprovalHandler('TEST_IDEM', { onApproved: async () => undefined, onRejected: async () => undefined });
    const pmRole = (await client.query(`SELECT id FROM core.roles WHERE code = 'PURCHASE_MANAGER'`)).rows[0].id as string;
    await createTestUser({ username: 'i_admin', roleCodes: ['SYSTEM_ADMIN'] });
    const adminToken = (await request(app).post('/api/v1/core/auth/login').send({ username: 'i_admin', password: TEST_PASSWORD })).body
      .accessToken as string;
    await request(app)
      .put('/api/v1/core/approval-rules/TEST_IDEM')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        measure: 'NONE',
        bands: [{ steps: [{ stepNo: 1, roleId: pmRole }] }],
        reason: 'test rule',
        countersign: { username: 'i_fm', password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'Finance agrees' },
      });
    const buyer = await authenticateToken(tokens.buyer!);
    const approval = await withTransaction(txContext(buyer), (tx) =>
      startApproval(tx, buyer, { docType: 'TEST_IDEM', docTable: 'test.documents', docId: '1', value: { measure: 'NONE' } }),
    );
    const click = () =>
      request(app)
        .post(`/api/v1/core/approvals/${approval.id}/approve`)
        .set('Authorization', `Bearer ${tokens.pm}`)
        .set('Idempotency-Key', 'approve-click-0001')
        .send({ signature: { password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'Fine' } });
    const first = await click();
    const second = await click();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.status).toBe('APPROVED');
  });
});

// ------------------------------------------------------------------ attachments

describe('attachments', () => {
  it('uploads, lists and downloads a file with its checksum', async () => {
    const res = await upload('a', '/attachments/test.records/1?description=CoA', PDF, 'application/pdf', 'CoA lot 42.pdf');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fileName: 'CoA lot 42.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, description: 'CoA' });
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await request(app).get('/api/v1/core/attachments/test.records/1').set('Authorization', `Bearer ${tokens.qcm}`);
    expect(list.body.map((a: { id: string }) => a.id)).toContain(res.body.id);

    const file = await request(app)
      .get(`/api/v1/core/attachment-files/${res.body.id}`)
      .set('Authorization', `Bearer ${tokens.qcm}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    expect(file.headers['content-disposition']).toContain("filename*=UTF-8''CoA%20lot%2042.pdf");
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('checks the record type permissions: read-only users cannot upload, others cannot read', async () => {
    expect((await upload('qcm', '/attachments/test.records/1', PDF, 'application/pdf', 'a.pdf')).status).toBe(403);
    expect((await request(app).get('/api/v1/core/attachments/test.records/1').set('Authorization', `Bearer ${tokens.planner}`)).status).toBe(403);
  });

  it('refuses unknown record types and missing records', async () => {
    expect((await upload('a', '/attachments/purch.nothing/1', PDF, 'application/pdf', 'a.pdf')).status).toBe(404);
    expect((await upload('a', '/attachments/test.records/99', PDF, 'application/pdf', 'a.pdf')).status).toBe(404);
  });

  it('refuses file types outside the allow-list and mismatched extensions', async () => {
    const exe = await upload('a', '/attachments/test.records/1', Buffer.from('MZ'), 'application/x-msdownload', 'tool.exe');
    expect(exe.status).toBe(422);
    expect(exe.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((await upload('a', '/attachments/test.records/1', PDF, 'application/pdf', 'tool.exe')).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('refuses empty files and files over 20 MB', async () => {
    expect((await upload('a', '/attachments/test.records/1', Buffer.alloc(0), 'application/pdf', 'empty.pdf')).status).toBe(400);
    const big = await upload('a', '/attachments/test.records/1', Buffer.alloc(20 * 1024 * 1024 + 1, 1), 'application/pdf', 'big.pdf');
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('strips paths from file names and stores under a random key inside the storage folder', async () => {
    const res = await upload('a', '/attachments/test.records/2', PDF, 'application/pdf', '../../etc/passwd.pdf');
    expect(res.status).toBe(201);
    expect(res.body.fileName).toBe('passwd.pdf');
    const { rows } = await client.query<{ storage_key: string }>(`SELECT storage_key FROM core.attachments WHERE id = $1`, [res.body.id]);
    expect(rows[0]!.storage_key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    const store = new LocalDiskStorage(env.STORAGE_DIR);
    await expect(store.get('../../package.json')).rejects.toThrow(/Invalid storage key/);
  });

  it('refuses to serve a file that was changed on disk (checksum mismatch)', async () => {
    const res = await upload('a', '/attachments/test.records/2', PDF, 'application/pdf', 'tamper.pdf');
    const { rows } = await client.query<{ storage_key: string }>(`SELECT storage_key FROM core.attachments WHERE id = $1`, [res.body.id]);
    const file = path.resolve(env.STORAGE_DIR, rows[0]!.storage_key);
    expect(Buffer.compare(await readFile(file), PDF)).toBe(0);
    await writeFile(file, Buffer.from('%PDF-1.4 altered'));
    const dl = await request(app).get(`/api/v1/core/attachment-files/${res.body.id}`).set('Authorization', `Bearer ${tokens.a}`);
    expect(dl.status).toBe(500);
    expect(dl.body.error.code).toBe('FILE_INTEGRITY_FAILED');
  });

  it('keeps attachment records insert-only and audited', async () => {
    await expect(client.query(`UPDATE core.attachments SET file_name = 'x.pdf'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(client.query(`DELETE FROM core.attachments`)).rejects.toThrow(/APPEND_ONLY/);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'core.attachments'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
