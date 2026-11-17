// Password policy (docs/architecture.md §7.1, decision Q6). Shared so the web form and the API agree.
export const PASSWORD_MIN_LENGTH = 10;
/** Number of previous passwords (including the current one) that cannot be reused. */
export const PASSWORD_HISTORY_DEPTH = 5;
export const PASSWORD_MAX_AGE_DAYS = 90;
export const MAX_FAILED_ATTEMPTS = 5;

/** Returns the list of broken policy rules; empty means the password is acceptable. */
export function passwordPolicyErrors(password: string, username: string): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) errors.push(`At least ${PASSWORD_MIN_LENGTH} characters`);
  if (!/[A-Z]/.test(password)) errors.push('At least one upper-case letter');
  if (!/[a-z]/.test(password)) errors.push('At least one lower-case letter');
  if (!/[0-9]/.test(password)) errors.push('At least one digit');
  const name = username.trim().toLowerCase();
  if (name.length > 0 && password.toLowerCase().includes(name)) errors.push('Must not contain the username');
  return errors;
}
