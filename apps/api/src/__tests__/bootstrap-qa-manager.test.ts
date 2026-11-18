// First QA Manager bootstrap (decision Q19): one-time, SYSTEM-attributed, audited, refused afterwards.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../config/env';
import { runSeed } from '../db/seed/run';
import { bootstrapQaManager } from '../db/seed/bootstrap-qa-manager';
import { createTestUser, setUserFields } from '../test/factories';

const client = new pg.Client({ connectionString: databaseUrl });

async function rolesOf(userId: string): Promise<string[]> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT r.code FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
    [userId],
  );
  return rows.map((r) => r.code);
}

let qa1: string;
let qa2: string;
let inactive: string;
let adminUser: string;

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  qa1 = await createTestUser({ username: 'qa001' });
  qa2 = await createTestUser({ username: 'qa002' });
  inactive = await createTestUser({ username: 'qa003', isActive: false });
  adminUser = await createTestUser({ username: 'adm001', roleCodes: ['SYSTEM_ADMIN'] });
});

afterAll(async () => {
  await client.end();
});

describe('refusals before any QA Manager exists', () => {
  it('needs a reason', async () => {
    await expect(bootstrapQaManager({ username: 'qa001', reason: ' ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await rolesOf(qa1)).toEqual([]);
  });

  it('refuses an unknown or SYSTEM user', async () => {
    await expect(bootstrapQaManager({ username: 'nobody', reason: 'first QA head' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bootstrapQaManager({ username: 'SYSTEM', reason: 'first QA head' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a deactivated user', async () => {
    await expect(bootstrapQaManager({ username: 'qa003', reason: 'first QA head' })).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    expect(await rolesOf(inactive)).toEqual([]);
  });

  it('refuses a user who holds an admin role (admin roles never approve)', async () => {
    await expect(bootstrapQaManager({ username: 'adm001', reason: 'first QA head' })).rejects.toMatchObject({
      code: 'SEGREGATION_OF_DUTIES',
    });
    expect(await rolesOf(adminUser)).toEqual(['SYSTEM_ADMIN']);
  });
});

describe('the first run', () => {
  it('gives QA_MANAGER to the user, as SYSTEM, with the reason in the audit trail', async () => {
    await bootstrapQaManager({ username: 'QA001', reason: 'Head of QA joined' });
    expect(await rolesOf(qa1)).toEqual(['QA_MANAGER']);
    const { rows } = await client.query(
      `SELECT action, changed_by, reason FROM core.audit_log
        WHERE table_name = 'core.user_roles' AND new_data->>'user_id' = $1`,
      [qa1],
    );
    expect(rows).toEqual([{ action: 'INSERT', changed_by: '1', reason: 'BOOTSTRAP_QA_MANAGER: Head of QA joined' }]);
  });

  it('refuses every later run while an active QA Manager exists', async () => {
    await expect(bootstrapQaManager({ username: 'qa002', reason: 'second QA head' })).rejects.toMatchObject({
      code: 'QA_MANAGER_EXISTS',
    });
    expect(await rolesOf(qa2)).toEqual([]);
  });

  it('works again only if no active QA Manager is left (e.g. the only one was deactivated)', async () => {
    await setUserFields(qa1, { isActive: false });
    await bootstrapQaManager({ username: 'qa002', reason: 'Previous QA head left' });
    expect(await rolesOf(qa2)).toEqual(['QA_MANAGER']);
  });
});
