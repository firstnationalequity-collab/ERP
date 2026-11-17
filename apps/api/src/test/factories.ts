// Test-only builders. They write through withTransaction as SYSTEM, so audit and guards apply as in production.
import { eq, inArray } from 'drizzle-orm';
import { systemContext, withTransaction } from '../db/client';
import { roles, userCredentials, userRoles, users } from '../db/schema/core';
import { hashPassword } from '../core/auth/password';

export const TEST_PASSWORD = 'Test-Password-2026';

export interface TestUserOptions {
  username: string;
  password?: string;
  fullName?: string;
  roleCodes?: string[];
  mustChangePassword?: boolean;
  isActive?: boolean;
  /** Defaults to now. Pass an old date to simulate an expired password. */
  passwordChangedAt?: Date;
}

export async function createTestUser(opts: TestUserOptions): Promise<string> {
  const hash = await hashPassword(opts.password ?? TEST_PASSWORD);
  return withTransaction(systemContext('test fixture'), async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: opts.username,
        fullName: opts.fullName ?? `Test ${opts.username}`,
        mustChangePassword: opts.mustChangePassword ?? false,
        isActive: opts.isActive ?? true,
        passwordChangedAt: opts.passwordChangedAt ?? new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('test user not created');
    await tx.insert(userCredentials).values({ userId: user.id, passwordHash: hash });
    if (opts.roleCodes?.length) {
      const found = await tx.select({ id: roles.id, code: roles.code }).from(roles).where(inArray(roles.code, opts.roleCodes));
      if (found.length !== opts.roleCodes.length) throw new Error(`unknown role in ${opts.roleCodes.join(', ')}`);
      await tx.insert(userRoles).values(found.map((r) => ({ userId: user.id, roleId: r.id })));
    }
    return user.id;
  });
}

export async function setUserFields(
  userId: string,
  values: Partial<{ isActive: boolean; mustChangePassword: boolean; passwordChangedAt: Date | null }>,
): Promise<void> {
  await withTransaction(systemContext('test fixture'), (tx) => tx.update(users).set(values).where(eq(users.id, userId)));
}
