// One-time setup: give the QA Manager role to the first person (decision Q19, docs/decisions.md).
// Role changes touching qc.* / qa.* keys need a QA Manager countersign, so the very first QA Manager
// cannot be created through the app. This runs only from the server terminal, acts as SYSTEM, writes
// the audit trail with the reason, and refuses once any active user can countersign.
import { sql } from 'drizzle-orm';
import type { PermissionKey } from '@albert/shared';
import { systemContext, withTransaction } from '../client';
import { AppError } from '../../core/errors';

const COUNTERSIGN_KEY: PermissionKey = 'qa.access.countersign';
const QA_MANAGER_ROLE = 'QA_MANAGER';

export interface BootstrapQaManagerInput {
  username: string;
  reason: string;
}

export async function bootstrapQaManager(input: BootstrapQaManagerInput): Promise<{ userId: string }> {
  const username = input.username.trim();
  const reason = input.reason.trim();
  if (!username) throw new AppError('VALIDATION_FAILED', 'Give the employee code of the first QA Manager');
  if (reason.length < 5) throw new AppError('VALIDATION_FAILED', 'Give a reason (at least 5 characters); it is stored in the audit trail');

  return withTransaction(systemContext(`BOOTSTRAP_QA_MANAGER: ${reason}`), async (tx) => {
    // Serialise concurrent runs: only one first QA Manager.
    await tx.execute(sql`LOCK TABLE core.user_roles IN SHARE ROW EXCLUSIVE MODE`);

    const holders = await tx.execute<{ n: number }>(sql`
      SELECT count(DISTINCT u.id)::int AS n
        FROM core.users u
        JOIN core.user_roles ur ON ur.user_id = u.id
        JOIN core.roles r ON r.id = ur.role_id AND r.is_active
        JOIN core.role_permissions rp ON rp.role_id = r.id
        JOIN core.permissions p ON p.id = rp.permission_id AND p.is_active AND p.key = ${COUNTERSIGN_KEY}
       WHERE u.is_active AND NOT u.is_system`);
    if ((holders.rows[0]?.n ?? 0) > 0) {
      throw new AppError(
        'QA_MANAGER_EXISTS',
        'An active QA Manager already exists; assign QA roles in the app with their countersign',
      );
    }

    const users = await tx.execute<{ id: string; is_active: boolean; is_system: boolean }>(sql`
      SELECT id::text AS id, is_active, is_system FROM core.users WHERE lower(username) = lower(${username})`);
    const user = users.rows[0];
    if (!user || user.is_system) throw new AppError('NOT_FOUND', `No user with employee code "${username}"`);
    if (!user.is_active) throw new AppError('ACCOUNT_INACTIVE', 'That user is deactivated');

    // Admin roles never approve (rules review A): a holder of an admin key cannot become QA Manager.
    const admin = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM core.user_roles ur
        JOIN core.role_permissions rp ON rp.role_id = ur.role_id
        JOIN core.permissions p ON p.id = rp.permission_id AND p.is_active AND p.class = 'ADMIN'
       WHERE ur.user_id = ${user.id}`);
    if ((admin.rows[0]?.n ?? 0) > 0) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'This user holds an admin role; the QA Manager must be a different person');
    }

    const roles = await tx.execute<{ id: string; is_active: boolean }>(sql`
      SELECT id::text AS id, is_active FROM core.roles WHERE code = ${QA_MANAGER_ROLE}`);
    const role = roles.rows[0];
    if (!role || !role.is_active) throw new AppError('NOT_FOUND', 'The QA Manager role is missing or inactive; run pnpm db:seed');

    await tx.execute(sql`
      INSERT INTO core.user_roles (user_id, role_id) VALUES (${user.id}, ${role.id})
      ON CONFLICT DO NOTHING`);
    return { userId: user.id };
  });
}
