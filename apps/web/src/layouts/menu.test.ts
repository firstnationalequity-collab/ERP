import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@albert/shared';
import { visibleMenu } from './menu';

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
    expect(keys(['core.audit.view', 'fin.view', 'dash.ceo.view'])).toEqual(['home', 'periods', 'audit']);
  });

  it('shows a user with no keys only Home', () => {
    expect(keys([])).toEqual(['home']);
  });
});
