// Sidebar entries and the permissions that show them (architecture §8: "the menu shows only what the
// user's permissions allow"). Pure data + one function, so it can be tested without a browser.
import type { PermissionKey } from '@albert/shared';

export interface MenuEntry {
  key: string;
  label: string;
  path: string;
  group?: 'Administration' | 'Finance' | 'Compliance';
  /** Visible when the user holds ANY of these; omitted = everyone signed in. */
  anyOf?: PermissionKey[];
}

export const MENU: MenuEntry[] = [
  { key: 'home', label: 'Home', path: '/' },
  { key: 'inbox', label: 'My approvals', path: '/approvals', anyOf: ['core.approval.inbox'] },
  { key: 'periods', label: 'Fiscal periods', path: '/fiscal-periods', group: 'Finance', anyOf: ['core.period.manage', 'core.period.close', 'fin.view'] },
  { key: 'audit', label: 'Audit trail', path: '/audit', group: 'Compliance', anyOf: ['core.audit.view'] },
  { key: 'users', label: 'Users', path: '/admin/users', group: 'Administration', anyOf: ['core.user.manage'] },
  { key: 'roles', label: 'Roles', path: '/admin/roles', group: 'Administration', anyOf: ['core.role.manage', 'core.user.manage'] },
  { key: 'approval-rules', label: 'Approval rules', path: '/admin/approval-rules', group: 'Administration', anyOf: ['core.settings.manage'] },
  { key: 'number-series', label: 'Number series', path: '/admin/number-series', group: 'Administration', anyOf: ['core.settings.manage'] },
];

export function visibleMenu(permissions: readonly PermissionKey[]): MenuEntry[] {
  const held = new Set(permissions);
  return MENU.filter((m) => !m.anyOf || m.anyOf.some((k) => held.has(k)));
}
