// Password hashing (argon2id). Hashes are stored only in core.user_credentials and never leave core/auth.
import argon2 from 'argon2';
import { passwordPolicyErrors } from '@albert/shared';
import { AppError } from '../errors';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Throws PASSWORD_POLICY (422) listing every broken rule. */
export function assertPasswordPolicy(password: string, username: string): void {
  const errors = passwordPolicyErrors(password, username);
  if (errors.length > 0) {
    throw new AppError('PASSWORD_POLICY', 'Password does not meet the policy', { rules: errors });
  }
}
