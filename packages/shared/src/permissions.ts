// Every permission key in the system. Format: <module>.<resource>.<action>.
// Add keys here first; seed them into core.permissions; bundle them into roles (docs/architecture.md §3).

export const Permissions = {
  // core
  'core.user.manage': 'Create, change, deactivate users and assign roles',
  'core.role.manage': 'Manage roles and permission bundles',
  'core.settings.manage': 'Number series, approval rules, settings',
  'core.audit.view': 'View audit trail',
  'core.period.close': 'Close and reopen fiscal periods',

  // masters
  'master.item.manage': 'Items, categories, UoM',
  'master.customer.manage': 'Create/edit customers (draft)',
  'master.customer.approve': 'Activate customers',
  'master.vendor.manage': 'Create/edit vendors (draft)',
  'master.vendor.approve': 'Activate vendors',
  'master.avl.approve': 'Add/block approved sources (QA)',
  'master.formula.manage': 'Draft master formulas',
  'master.formula.approve': 'Approve master formula versions (QA)',
  'master.location.manage': 'Warehouses and locations',

  // inventory
  'inv.stock.view': 'View stock, lots, movements',
  'inv.movement.post': 'Put-away, transfers, issues',
  'inv.adjustment.request': 'Request stock adjustments',
  'inv.adjustment.approve': 'Approve stock adjustments',
  'inv.label.print': 'Print labels',

  // sales
  'sales.quotation.manage': 'Create/edit quotations',
  'sales.quotation.approve': 'Approve quotations and discounts',
  'sales.order.manage': 'Create/confirm sales orders',
  'sales.order.credit_override': 'Release orders on credit hold',

  // procurement
  'purch.pr.manage': 'Create purchase requisitions',
  'purch.po.manage': 'Create/edit purchase orders',
  'purch.po.approve': 'Approve purchase orders',
  'purch.grn.post': 'Post goods receipts',
  'purch.landed_cost.manage': 'Enter landed costs',

  // qc
  'qc.spec.manage': 'Draft specifications',
  'qc.spec.approve': 'Approve specifications',
  'qc.result.enter': 'Take samples, enter results',
  'qc.result.review': 'Review results',
  'qc.lot.change_status': 'Approve / reject / hold lots',
  'qc.coa.issue': 'Issue certificates of analysis',

  // production
  'prod.order.manage': 'Create and release production orders',
  'prod.stage.sign': 'Execute and sign batch stages',
  'prod.batch.close': 'Close batch (send to QA)',

  // qa
  'qa.deviation.manage': 'Raise and investigate deviations',
  'qa.deviation.close': 'Close deviations',
  'qa.batch.release': 'Release or reject batches',

  // dispatch
  'fg.delivery.manage': 'Delivery orders, picking',
  'fg.dispatch.post': 'Post dispatch, gate pass',

  // finance
  'fin.journal.manage': 'Journal vouchers',
  'fin.invoice.manage': 'Sales and vendor invoices',
  'fin.receipt.manage': 'Customer receipts',
  'fin.payment.manage': 'Create payments',
  'fin.payment.approve': 'Approve payments',
  'fin.bank.reconcile': 'Bank reconciliation',
  'fin.costing.view': 'Batch cost and margin',
  'fin.report.view': 'Financial statements and ledgers',

  // dashboard
  'dash.ceo.view': 'Executive dashboard (view only)',
} as const;

export type PermissionKey = keyof typeof Permissions;
export const PermissionKeys = Object.keys(Permissions) as PermissionKey[];
