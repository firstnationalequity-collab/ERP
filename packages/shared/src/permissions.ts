// Every permission key in the system. Format: <module>.<resource>.<action>.
// Add keys here first; the seed syncs them into core.permissions; roles bundle them (docs/roles.md).
// Class (docs/roles.md): ADMIN = manage users/roles/settings; VIEW = read-only; ACTION = changes business data.
// A role holding an ADMIN key never holds an ACTION key (enforced in the service and in the database).
import type { PermissionClass } from './enums';

interface PermissionDef {
  readonly class: PermissionClass;
  readonly description: string;
}

const admin = (description: string): PermissionDef => ({ class: 'ADMIN', description });
const view = (description: string): PermissionDef => ({ class: 'VIEW', description });
const action = (description: string): PermissionDef => ({ class: 'ACTION', description });

export const Permissions = {
  // core
  'core.user.manage': admin('Create, change, deactivate, unlock users; assign roles'),
  'core.role.manage': admin('Manage roles and permission bundles'),
  'core.settings.manage': admin('Number series, approval rules, settings'),
  'core.audit.view': view('View audit trail'),
  'core.approval.inbox': view('See "my approvals" inbox (acting still needs the document\'s approve key)'),
  'core.period.manage': action('Create fiscal years and periods'),
  'core.period.close': action('Close and reopen fiscal periods'),

  // masters
  'master.view': view('View all masters'),
  'master.item.manage': action('Items, categories, UoM (draft items; activates non-GMP items)'),
  'master.item.approve': action('Activate, deactivate and countersign GMP items (QA)'),
  'master.customer.manage': action('Create/edit customers (draft)'),
  'master.customer.approve': action('Activate customers'),
  'master.vendor.manage': action('Create/edit vendors (draft)'),
  'master.vendor.approve': action('Activate vendors'),
  'master.avl.approve': action('Add/block approved sources (QA)'),
  'master.formula.manage': action('Draft master formulas'),
  'master.formula.approve': action('Approve master formula versions (QA)'),
  'master.location.manage': action('Warehouses and locations'),
  'master.product.manage': action('Products (registration, artwork and quality agreement changes need a QA countersign)'),
  'master.price.manage': action('Price lists'),

  // inventory
  'inv.stock.view': view('View stock, lots, movements'),
  'inv.movement.post': action('Put-away, transfers, issues'),
  'inv.adjustment.request': action('Request stock adjustments'),
  'inv.adjustment.approve': action('Approve stock adjustments'),
  'inv.label.print': action('Print labels'),
  'inv.lot.dispose': action('Move a REJECTED lot to DESTROYED / RETURNED (needs QA witness)'),

  // sales
  'sales.view': view('View quotations, orders, customer ledger'),
  'sales.quotation.manage': action('Create/edit quotations'),
  'sales.quotation.approve': action('Approve quotations and discounts'),
  'sales.order.manage': action('Create/confirm sales orders, delivery requests'),
  'sales.order.credit_override': action('Release orders on credit hold'),

  // procurement
  'purch.view': view('View PRs, POs, GRNs, vendor ledger'),
  'purch.pr.manage': action('Create purchase requisitions'),
  'purch.po.manage': action('Create/edit purchase orders'),
  'purch.po.approve': action('Approve purchase orders'),
  'purch.grn.post': action('Post goods receipts'),
  'purch.landed_cost.manage': action('Enter landed costs'),

  // qc
  'qc.view': view('View specs, samples, results, CoAs'),
  'qc.spec.manage': action('Draft specifications'),
  'qc.spec.approve': action('Approve specifications'),
  'qc.result.enter': action('Take samples, enter results'),
  'qc.result.review': action('Review results'),
  'qc.lot.change_status': action('Approve / reject lots'),
  'qc.coa.issue': action('Issue certificates of analysis'),

  // production
  'prod.view': view('View production orders, stages, outputs'),
  'prod.order.manage': action('Create, release, cancel production orders'),
  'prod.stage.sign': action('Execute and sign batch stages, record yield and resource hours'),
  'prod.batch.close': action('Submit batch close (Supervisor)'),
  'prod.batch.approve_close': action('Approve batch close with e-signature (Production Manager)'),

  // qa
  'qa.view': view('View deviations and batch releases'),
  'qa.deviation.manage': action('Raise and investigate deviations'),
  'qa.deviation.close': action('Close deviations'),
  'qa.batch.release': action('Release or reject batches (and their FG lots)'),
  'qa.lot.hold': action('Place or lift HOLD on a lot'),
  'qa.lot.witness': action('Witness e-signature for lot destruction / return'),
  'qa.access.countersign': action('Countersign role changes touching qc.* / qa.* action keys'),
  'qa.product.countersign': action('Countersign product registration no., artwork version and quality agreement changes'),

  // finished goods and dispatch
  'fg.view': view('View delivery orders, gate passes, returns'),
  'fg.delivery.manage': action('Delivery orders, picking, returns receipt'),
  'fg.dispatch.post': action('Post dispatch, gate pass'),
  'fg.gatepass.approve': action('Approve gate passes'),

  // finance
  'fin.view': view('View journals, invoices, receipts, payments, ledgers'),
  'fin.journal.manage': action('Journal vouchers'),
  'fin.invoice.manage': action('Sales and vendor invoices'),
  'fin.receipt.manage': action('Customer receipts'),
  'fin.payment.manage': action('Create payments'),
  'fin.payment.approve': action('Approve payments'),
  'fin.master.manage': action('Chart of accounts, cost centres, tax codes, posting rules'),
  'fin.approval_rules.countersign': action('Countersign changes to the approval matrix (Finance Manager)'),
  'fin.bank.reconcile': action('Bank reconciliation'),
  'fin.costing.view': view('Batch cost and margin'),
  'fin.report.view': view('Financial statements and ledgers'),

  // dashboard
  'dash.ceo.view': view('Executive dashboard (view only)'),
} as const satisfies Record<string, PermissionDef>;

export type PermissionKey = keyof typeof Permissions;
export const PermissionKeys = Object.keys(Permissions) as PermissionKey[];

export function permissionClass(key: PermissionKey): PermissionClass {
  return Permissions[key].class;
}

export const ViewPermissionKeys = PermissionKeys.filter((k) => Permissions[k].class === 'VIEW');

/** Keys whose role changes need a QA Manager countersign (Q1): qc.* / qa.* ACTION keys. */
export function isQualityActionKey(key: PermissionKey): boolean {
  return Permissions[key].class === 'ACTION' && (key.startsWith('qc.') || key.startsWith('qa.'));
}
