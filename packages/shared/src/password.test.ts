import { describe, expect, it } from 'vitest';
import { passwordPolicyErrors } from './password';

describe('password policy (Q6)', () => {
  it('accepts a password meeting every rule', () => {
    expect(passwordPolicyErrors('Albert-Pharma-2026', 'emp001')).toEqual([]);
  });

  it('requires 10 characters, upper, lower and a digit', () => {
    expect(passwordPolicyErrors('Ab1', 'x')).toContain('At least 10 characters');
    expect(passwordPolicyErrors('alllowercase1', 'x')).toContain('At least one upper-case letter');
    expect(passwordPolicyErrors('ALLUPPERCASE1', 'x')).toContain('At least one lower-case letter');
    expect(passwordPolicyErrors('NoDigitsHere', 'x')).toContain('At least one digit');
  });

  it('refuses a password containing the username, in any case', () => {
    expect(passwordPolicyErrors('MyEMP001Password', 'emp001')).toContain('Must not contain the username');
  });
});
