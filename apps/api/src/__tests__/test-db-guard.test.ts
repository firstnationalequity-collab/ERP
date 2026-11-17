import { describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../test/db';

describe('test database guard', () => {
  it('allows a *_test database under NODE_ENV=test', () => {
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/albert_erp_test', 'test')).not.toThrow();
  });

  it('refuses the development database', () => {
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/albert_erp', 'test')).toThrow(/Refusing/);
  });

  it('refuses a *_test database when NODE_ENV is not test', () => {
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/albert_erp_test', 'development')).toThrow(
      /Refusing/,
    );
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/albert_erp_test', 'production')).toThrow(
      /Refusing/,
    );
  });
});
