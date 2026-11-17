// Database guarantees from 0001_core_identity.sql (docs/architecture.md §3, §5; decisions Q1–Q9).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import argon2 from 'argon2';
import { databaseUrl } from '../config/env';
import { fromDbError } from '../core/errors';

const client = new pg.Client({ connectionString: databaseUrl });

/** Run statements in one transaction as the given user (like withTransaction does). Rolls back on error. */
async function asUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id', '1', true)`, [
      userId,
    ]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function createUser(username: string, actor = '1'): Promise<string> {
  return asUser(actor, async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.users (username, full_name) VALUES ($1, $2) RETURNING id`,
      [username, `Test ${username}`],
    );
    return rows[0]!.id;
  });
}

async function createPermission(key: string, cls: 'ADMIN' | 'VIEW' | 'ACTION'): Promise<string> {
  return asUser('1', async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.permissions (key, class, description) VALUES ($1, $2, $1) RETURNING id`,
      [key, cls],
    );
    return rows[0]!.id;
  });
}

async function createRole(code: string): Promise<string> {
  return asUser('1', async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.roles (code, name) VALUES ($1, $1) RETURNING id`,
      [code],
    );
    return rows[0]!.id;
  });
}

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('bootstrap rows', () => {
  it('has the one company and the SYSTEM user', async () => {
    const company = await client.query(`SELECT id, code, name FROM core.companies`);
    expect(company.rows).toEqual([{ id: '1', code: 'ALBERT', name: 'Albert Pharmaceuticals' }]);
    const system = await client.query(`SELECT id, username, is_system FROM core.users WHERE is_system`);
    expect(system.rows).toEqual([{ id: '1', username: 'SYSTEM', is_system: true }]);
  });

  it('protects the SYSTEM user from change, deletion and duplication', async () => {
    await expect(asUser('1', () => client.query(`UPDATE core.users SET is_active = false WHERE id = 1`))).rejects.toThrow(
      /FORBIDDEN/,
    );
    await expect(asUser('1', () => client.query(`DELETE FROM core.users WHERE id = 1`))).rejects.toThrow(/FORBIDDEN/);
    await expect(
      asUser('1', () => client.query(`INSERT INTO core.users (username, full_name, is_system) VALUES ('sys2','x',true)`)),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('never lets the SYSTEM user have a password', async () => {
    const hash = await argon2.hash('Whatever123');
    await expect(
      asUser('1', () => client.query(`INSERT INTO core.user_credentials (user_id, password_hash) VALUES (1, $1)`, [hash])),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});

describe('actor columns and audit', () => {
  it('fills company_id, created_by, updated_by from the transaction and audits the insert', async () => {
    const id = await createUser('emp001');
    const user = await client.query(`SELECT company_id, created_by, updated_by FROM core.users WHERE id = $1`, [id]);
    expect(user.rows[0]).toEqual({ company_id: '1', created_by: '1', updated_by: '1' });
    const audit = await client.query(
      `SELECT action, changed_by FROM core.audit_log WHERE table_name = 'core.users' AND record_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([{ action: 'INSERT', changed_by: '1' }]);
  });

  it('refuses a write with no acting user (no anonymous rows)', async () => {
    await expect(
      client.query(`INSERT INTO core.users (company_id, username, full_name) VALUES (1, 'nobody', 'Nobody')`),
    ).rejects.toThrow(/null value in column "created_by"/);
  });

  it('stamps updated_by with the acting user on update', async () => {
    const actor = await createUser('emp002');
    const target = await createUser('emp003');
    await asUser(actor, () => client.query(`UPDATE core.users SET full_name = 'Renamed' WHERE id = $1`, [target]));
    const { rows } = await client.query(`SELECT updated_by FROM core.users WHERE id = $1`, [target]);
    expect(rows[0]).toEqual({ updated_by: actor });
  });
});

describe('credentials never reach the audit log', () => {
  it('stores the hash only in user_credentials; audit_log never contains it', async () => {
    const id = await createUser('emp010');
    const first = await argon2.hash('FirstPass123');
    const second = await argon2.hash('SecondPass123');
    await asUser('1', async () => {
      await client.query(`INSERT INTO core.user_credentials (user_id, password_hash) VALUES ($1, $2)`, [id, first]);
    });
    // Rotate: retire the old row, add a new one — the normal password-change path.
    await asUser('1', async () => {
      await client.query(`UPDATE core.user_credentials SET is_current = false WHERE user_id = $1 AND is_current`, [id]);
      await client.query(`INSERT INTO core.user_credentials (user_id, password_hash) VALUES ($1, $2)`, [id, second]);
    });

    const credAudit = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'core.user_credentials'`);
    expect(credAudit.rows[0]).toEqual({ n: 0 });
    const leaked = await client.query(
      `SELECT count(*)::int AS n FROM core.audit_log
        WHERE coalesce(old_data::text, '') LIKE '%$argon2%' OR coalesce(new_data::text, '') LIKE '%$argon2%'
           OR coalesce(old_data::text, '') LIKE $1 OR coalesce(new_data::text, '') LIKE $2`,
      [`%${first}%`, `%${second}%`],
    );
    expect(leaked.rows[0]).toEqual({ n: 0 });
  });

  it('refuses to rewrite a hash, revive an old credential, or delete one', async () => {
    const id = await createUser('emp011');
    const hash = await argon2.hash('Original123');
    const other = await argon2.hash('Other12345');
    await asUser('1', () =>
      client.query(`INSERT INTO core.user_credentials (user_id, password_hash) VALUES ($1, $2)`, [id, hash]),
    );
    await expect(
      asUser('1', () => client.query(`UPDATE core.user_credentials SET password_hash = $2 WHERE user_id = $1`, [id, other])),
    ).rejects.toThrow(/APPEND_ONLY/);
    await asUser('1', () => client.query(`UPDATE core.user_credentials SET is_current = false WHERE user_id = $1`, [id]));
    await expect(
      asUser('1', () => client.query(`UPDATE core.user_credentials SET is_current = true WHERE user_id = $1`, [id])),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(asUser('1', () => client.query(`DELETE FROM core.user_credentials WHERE user_id = $1`, [id]))).rejects.toThrow(
      /APPEND_ONLY/,
    );
  });

  it('allows only one current credential per user and only argon2 hashes', async () => {
    const id = await createUser('emp012');
    await asUser('1', async () =>
      client.query(`INSERT INTO core.user_credentials (user_id, password_hash) VALUES ($1, $2)`, [id, await argon2.hash('Aaaaaaaa11')]),
    );
    const again = await argon2.hash('Bbbbbbbb22');
    await expect(
      asUser('1', () => client.query(`INSERT INTO core.user_credentials (user_id, password_hash) VALUES ($1, $2)`, [id, again])),
    ).rejects.toThrow(/user_credentials_current_uq/);
    await expect(
      asUser('1', () =>
        client.query(`INSERT INTO core.user_credentials (user_id, password_hash, is_current) VALUES ($1, 'plaintext', false)`, [id]),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('auth events and sessions', () => {
  it('keeps auth_events insert-only', async () => {
    await asUser('1', () => client.query(`INSERT INTO core.auth_events (username, event) VALUES ('ghost', 'LOGIN_FAIL')`));
    await expect(client.query(`UPDATE core.auth_events SET event = 'LOGIN_OK'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(client.query(`DELETE FROM core.auth_events`)).rejects.toThrow(/APPEND_ONLY/);
  });

  it('refuses unknown auth event types', async () => {
    await expect(
      asUser('1', () => client.query(`INSERT INTO core.auth_events (username, event) VALUES ('x', 'HACKED')`)),
    ).rejects.toThrow(/check constraint/);
  });

  it('keeps a revoked session revoked and never deletes sessions', async () => {
    const userId = await createUser('emp020');
    const sessionId = await asUser('1', async () => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO core.sessions (user_id, current_token_hash, expires_at) VALUES ($1, 'h1', now() + interval '12 hours') RETURNING id`,
        [userId],
      );
      return rows[0]!.id;
    });
    await asUser('1', () =>
      client.query(`UPDATE core.sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE id = $1`, [sessionId]),
    );
    await expect(
      asUser('1', () => client.query(`UPDATE core.sessions SET revoked_at = NULL, revoke_reason = NULL WHERE id = $1`, [sessionId])),
    ).rejects.toThrow(/SESSION_REVOKED/);
    await expect(asUser('1', () => client.query(`DELETE FROM core.sessions WHERE id = $1`, [sessionId]))).rejects.toThrow(
      /APPEND_ONLY/,
    );
  });

  it('does not audit sessions (token hashes stay out of audit_log)', async () => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'core.sessions'`);
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe('role guards (Q1)', () => {
  it('refuses an action key on a role that holds an admin key, and the reverse', async () => {
    const adminKey = await createPermission('core.test_admin.manage', 'ADMIN');
    const actionKey = await createPermission('qa.test_action.release', 'ACTION');
    const viewKey = await createPermission('qa.test_view.view', 'VIEW');

    const adminRole = await createRole('TEST_ADMIN');
    await asUser('1', () => client.query(`INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)`, [adminRole, adminKey]));
    await asUser('1', () => client.query(`INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)`, [adminRole, viewKey]));
    await expect(
      asUser('1', () => client.query(`INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)`, [adminRole, actionKey])),
    ).rejects.toThrow(/ROLE_ADMIN_CONFLICT/);

    const businessRole = await createRole('TEST_QA');
    await asUser('1', () => client.query(`INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)`, [businessRole, actionKey]));
    await expect(
      asUser('1', () => client.query(`INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)`, [businessRole, adminKey])),
    ).rejects.toThrow(/ROLE_ADMIN_CONFLICT/);
  });

  it('refuses to change the class of a permission that roles already use', async () => {
    await expect(
      asUser('1', () => client.query(`UPDATE core.permissions SET class = 'ADMIN' WHERE key = 'qa.test_action.release'`)),
    ).rejects.toThrow(/ROLE_ADMIN_CONFLICT/);
  });

  it('refuses any change to your own role assignments', async () => {
    const admin = await createUser('emp030');
    const other = await createUser('emp031');
    const role = await createRole('TEST_SELF');
    // Someone else may assign roles to the admin…
    await asUser('1', () => client.query(`INSERT INTO core.user_roles (user_id, role_id) VALUES ($1, $2)`, [admin, role]));
    // …and the admin may assign roles to others…
    await asUser(admin, () => client.query(`INSERT INTO core.user_roles (user_id, role_id) VALUES ($1, $2)`, [other, role]));
    // …but never add, move or remove their own.
    const role2 = await createRole('TEST_SELF2');
    await expect(
      asUser(admin, () => client.query(`INSERT INTO core.user_roles (user_id, role_id) VALUES ($1, $2)`, [admin, role2])),
    ).rejects.toThrow(/SELF_ROLE_CHANGE/);
    await expect(
      asUser(admin, () => client.query(`DELETE FROM core.user_roles WHERE user_id = $1`, [admin])),
    ).rejects.toThrow(/SELF_ROLE_CHANGE/);
    await expect(
      asUser(admin, () => client.query(`UPDATE core.user_roles SET user_id = $1 WHERE user_id = $2`, [admin, other])),
    ).rejects.toThrow(/SELF_ROLE_CHANGE/);
  });

  it('gives the SYSTEM user no roles', async () => {
    const role = await createRole('TEST_SYS');
    const actor = await createUser('emp032');
    await expect(
      asUser(actor, () => client.query(`INSERT INTO core.user_roles (user_id, role_id) VALUES (1, $1)`, [role])),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('maps a guard error to its API error code and status', async () => {
    const admin = await createUser('emp033');
    const role = await createRole('TEST_MAP');
    const err = await asUser(admin, () =>
      client.query(`INSERT INTO core.user_roles (user_id, role_id) VALUES ($1, $2)`, [admin, role]),
    ).catch((e: unknown) => e);
    const appError = fromDbError(err);
    expect(appError?.code).toBe('SELF_ROLE_CHANGE');
    expect(appError?.status).toBe(403);
  });
});
