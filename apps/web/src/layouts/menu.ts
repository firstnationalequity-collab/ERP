// Sidebar entries and the permissions that show them (architecture §8: "the menu shows only what the
// user's permissions allow"). Pure data + one function, so it can be tested without a browser.
import type { PermissionKey } from '@albert/shared';

export interface MenuEntry {
  key: string;
  label: string;
  path: string;
  group?: 'Procurement' | 'Masters' | 'Finance' | 'Compliance' | 'Administration';
  /** Visible when the user holds ANY of these; omitted = everyone signed in. */
  anyOf?: PermissionKey[];
}

export const MENU: MenuEntry[] = [
  { key: 'home', label: 'Home', path: '/' },
  { key: 'inbox', label: 'My approvals', path: '/approvals', anyOf: ['core.approval.inbox'] },
  { key: 'requisitions', label: 'Requisitions', path: '/purch/requisitions', group: 'Procurement', anyOf: ['purch.view'] },
  { key: 'purchase-orders', label: 'Purchase orders', path: '/purch/orders', group: 'Procurement', anyOf: ['purch.view'] },
  { key: 'grns', label: 'Goods received (GRN)', path: '/purch/grns', group: 'Procurement', anyOf: ['purch.view'] },
  { key: 'items', label: 'Items', path: '/master/items', group: 'Masters', anyOf: ['master.view'] },
  { key: 'formulas', label: 'Master formulas', path: '/master/formulas', group: 'Masters', anyOf: ['master.view'] },
  { key: 'products', label: 'Products', path: '/master/products', group: 'Masters', anyOf: ['master.view'] },
  { key: 'customers', label: 'Customers', path: '/master/customers', group: 'Masters', anyOf: ['master.view'] },
  { key: 'price-lists', label: 'Price lists', path: '/master/price-lists', group: 'Masters', anyOf: ['master.view'] },
  { key: 'vendors', label: 'Vendors', path: '/master/vendors', group: 'Masters', anyOf: ['master.view'] },
  { key: 'avl', label: 'Approved sources (AVL)', path: '/master/approved-sources', group: 'Masters', anyOf: ['master.view'] },
  { key: 'categories', label: 'Item categories', path: '/master/item-categories', group: 'Masters', anyOf: ['master.view'] },
  { key: 'uoms', label: 'Units of measure', path: '/master/uoms', group: 'Masters', anyOf: ['master.view'] },
  { key: 'conversions', label: 'UoM conversions', path: '/master/uom-conversions', group: 'Masters', anyOf: ['master.view'] },
  { key: 'warehouses', label: 'Warehouses', path: '/master/warehouses', group: 'Masters', anyOf: ['master.view'] },
  { key: 'locations', label: 'Locations', path: '/master/locations', group: 'Masters', anyOf: ['master.view'] },
  { key: 'tax-codes', label: 'Tax codes', path: '/master/tax-codes', group: 'Masters', anyOf: ['master.view'] },
  { key: 'journals', label: 'Journals', path: '/fin/journals', group: 'Finance', anyOf: ['fin.view'] },
  { key: 'accounts', label: 'Chart of accounts', path: '/fin/accounts', group: 'Finance', anyOf: ['fin.view', 'master.view'] },
  { key: 'posting-rules', label: 'Posting rules', path: '/fin/posting-rules', group: 'Finance', anyOf: ['fin.view', 'master.view'] },
  { key: 'cost-centers', label: 'Cost centres', path: '/fin/cost-centers', group: 'Finance', anyOf: ['fin.view', 'master.view'] },
  { key: 'exchange-rates', label: 'Exchange rates', path: '/fin/exchange-rates', group: 'Finance', anyOf: ['fin.view', 'purch.view'] },
  { key: 'periods', label: 'Fiscal periods', path: '/fiscal-periods', group: 'Finance', anyOf: ['core.period.manage', 'core.period.close', 'fin.view'] },
  { key: 'audit', label: 'Audit trail', path: '/audit', group: 'Compliance', anyOf: ['core.audit.view'] },
  { key: 'users', label: 'Users', path: '/admin/users', group: 'Administration', anyOf: ['core.user.manage'] },
  { key: 'roles', label: 'Roles', path: '/admin/roles', group: 'Administration', anyOf: ['core.role.manage', 'core.user.manage'] },
  { key: 'approval-rules', label: 'Approval rules', path: '/admin/approval-rules', group: 'Administration', anyOf: ['core.settings.manage'] },
  { key: 'number-series', label: 'Number series', path: '/admin/number-series', group: 'Administration', anyOf: ['core.settings.manage'] },
];

/** The menu entry a location belongs to: the longest entry path that prefixes it (for highlighting). */
export function selectedMenuPath(pathname: string): string {
  const hits = MENU.filter((m) => (m.path === '/' ? pathname === '/' : pathname === m.path || pathname.startsWith(`${m.path}/`)));
  return hits.sort((a, b) => b.path.length - a.path.length)[0]?.path ?? pathname;
}

export function visibleMenu(permissions: readonly PermissionKey[]): MenuEntry[] {
  const held = new Set(permissions);
  return MENU.filter((m) => !m.anyOf || m.anyOf.some((k) => held.has(k)));
}
