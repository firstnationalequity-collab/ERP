import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@albert/shared';
import { selectedMenuPath, visibleMenu } from './menu';

const keys = (perms: PermissionKey[]) => visibleMenu(perms).map((m) => m.key);

describe('permission-driven sidebar', () => {
  it('shows a System Admin the admin pages but no finance pages', () => {
    expect(keys(['core.user.manage', 'core.role.manage', 'core.settings.manage', 'core.audit.view', 'core.approval.inbox'])).toEqual([
      'home',
      'inbox',
      'audit',
      'users',
      'roles',
      'approval-rules',
      'number-series',
    ]);
  });

  it('shows the CEO (view keys only) the audit trail and fiscal periods, no admin pages', () => {
    expect(keys(['core.audit.view', 'fin.view', 'dash.ceo.view'])).toEqual(['home', 'journals', 'accounts', 'posting-rules', 'cost-centers', 'exchange-rates', 'periods', 'audit']);
  });

  it('shows purch.view holders requisitions, purchase orders and exchange rates, not journals', () => {
    const k = keys(['purch.view']);
    expect(k).toEqual(expect.arrayContaining(['requisitions', 'purchase-orders', 'grns', 'exchange-rates']));
    expect(k).not.toContain('journals');
    expect(keys(['master.view'])).not.toContain('purchase-orders');
  });

  it('shows master.view holders every master screen and the finance masters, but not journals (fin.view)', () => {
    const k = keys(['master.view']);
    expect(k).toContain('items');
    expect(k).toContain('avl');
    expect(k).toContain('formulas');
    expect(k).toContain('accounts');
    expect(k).not.toContain('journals');
    expect(k).not.toContain('users');
  });

  it('highlights the entry a nested page belongs to', () => {
    expect(selectedMenuPath('/master/items')).toBe('/master/items');
    expect(selectedMenuPath('/master/items/12')).toBe('/master/items');
    expect(selectedMenuPath('/admin/users')).toBe('/admin/users');
    expect(selectedMenuPath('/')).toBe('/');
    expect(selectedMenuPath('/fin/journals')).toBe('/fin/journals');
  });

  it('shows a user with no keys only Home', () => {
    expect(keys([])).toEqual(['home']);
  });
});
