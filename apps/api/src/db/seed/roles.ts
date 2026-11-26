// Phase 1 roles and their permission bundles — a transcription of docs/roles.md ("Role → keys").
// Change docs/roles.md first, then this file (a test keeps them identical). The seed creates missing roles
// and ADDS missing keys to existing roles; it never removes a key — if a role holds a key not listed here,
// the seed stops for the owner's decision (decisions.md 18-11-2026).
// master.item.manage → Warehouse Manager + Purchase Manager; master.formula.manage → Production Manager
// (owner decision, corrected 18-11-2026; migration 0010 removed the earlier Planner / QA Officer grants).
import { ViewPermissionKeys, type PermissionKey } from '@albert/shared';

export interface RoleSeed {
  code: string;
  name: string;
  keys: readonly PermissionKey[];
}

/** Every role except the SYSTEM user holds the approvals inbox. */
const INBOX: PermissionKey = 'core.approval.inbox';

const roles: RoleSeed[] = [
  {
    code: 'CEO',
    name: 'CEO / Director',
    keys: ViewPermissionKeys.filter((k) => k !== INBOX), // all view keys and nothing else
  },
  {
    code: 'SALES_EXECUTIVE',
    name: 'Sales Executive',
    keys: ['sales.view', 'master.view', 'inv.stock.view', 'fg.view', 'master.customer.manage', 'sales.quotation.manage', 'sales.order.manage'],
  },
  {
    code: 'SALES_MANAGER',
    name: 'Sales Manager',
    keys: ['sales.view', 'master.view', 'inv.stock.view', 'fg.view', 'sales.quotation.approve', 'master.customer.approve',
      'master.product.manage', 'master.price.manage'],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    keys: ['fin.view', 'fin.report.view', 'purch.view', 'master.view', 'fin.journal.manage', 'fin.invoice.manage', 'fin.bank.reconcile'],
  },
  {
    code: 'AR_OFFICER',
    name: 'AR Officer',
    keys: ['fin.view', 'sales.view', 'fg.view', 'master.view', 'fin.invoice.manage', 'fin.receipt.manage'],
  },
  {
    code: 'AP_OFFICER',
    name: 'AP Officer',
    keys: ['fin.view', 'purch.view', 'master.view', 'fin.payment.manage'],
  },
  {
    code: 'FINANCE_MANAGER',
    name: 'Finance Manager',
    keys: [
      'fin.view', 'fin.report.view', 'fin.costing.view', 'sales.view', 'purch.view', 'inv.stock.view', 'master.view',
      'fin.payment.approve', 'sales.order.credit_override', 'sales.quotation.approve', 'purch.po.approve',
      'inv.adjustment.approve', 'core.period.manage', 'core.period.close', 'fin.approval_rules.countersign',
      'fin.master.manage', 'fin.rate.manage', 'purch.landed_cost.correct', 'fin.invoice.match_release',
    ],
  },
  {
    code: 'PURCHASE_OFFICER',
    name: 'Purchase Officer',
    keys: ['purch.view', 'master.view', 'inv.stock.view', 'purch.pr.manage', 'purch.po.manage', 'master.vendor.manage', 'purch.landed_cost.manage'],
  },
  {
    code: 'PURCHASE_MANAGER',
    name: 'Purchase Manager',
    keys: ['purch.view', 'master.view', 'inv.stock.view', 'purch.po.approve', 'master.vendor.approve', 'master.item.manage'],
  },
  {
    code: 'STOREKEEPER',
    name: 'Storekeeper',
    keys: [
      'inv.stock.view', 'purch.view', 'prod.view', 'fg.view', 'master.view',
      'purch.grn.post', 'inv.movement.post', 'inv.label.print', 'fg.delivery.manage', 'fg.dispatch.post',
    ],
  },
  {
    code: 'WAREHOUSE_MANAGER',
    name: 'Warehouse Manager',
    keys: [
      'inv.stock.view', 'purch.view', 'prod.view', 'fg.view', 'master.view',
      'inv.adjustment.request', 'purch.grn.reverse', 'fg.gatepass.approve', 'fg.delivery.manage', 'inv.lot.dispose', 'master.location.manage', 'master.item.manage',
    ],
  },
  {
    code: 'PLANNER',
    name: 'Planner',
    keys: ['prod.view', 'sales.view', 'inv.stock.view', 'master.view', 'prod.order.manage'],
  },
  {
    code: 'PRODUCTION_OPERATOR',
    name: 'Production Operator',
    keys: ['prod.view', 'prod.stage.sign'],
  },
  {
    code: 'PRODUCTION_SUPERVISOR',
    name: 'Production Supervisor',
    keys: ['prod.view', 'inv.stock.view', 'prod.stage.sign', 'prod.output.verify', 'prod.batch.close'],
  },
  {
    code: 'PRODUCTION_MANAGER',
    name: 'Production Manager',
    keys: ['prod.view', 'qa.view', 'inv.stock.view', 'master.view', 'prod.batch.approve_close', 'qa.deviation.manage', 'master.formula.manage'],
  },
  {
    code: 'QC_ANALYST',
    name: 'QC Analyst',
    keys: ['qc.view', 'inv.stock.view', 'master.view', 'qc.result.enter', 'qc.spec.manage'],
  },
  {
    code: 'QC_MANAGER',
    name: 'QC Manager',
    keys: ['qc.view', 'inv.stock.view', 'master.view', 'qc.result.review', 'qc.lot.change_status', 'qc.coa.issue', 'qc.spec.approve'],
  },
  {
    code: 'QA_OFFICER',
    name: 'QA Officer',
    keys: ['qa.view', 'qc.view', 'prod.view', 'master.view', 'qa.deviation.manage'],
  },
  {
    code: 'QA_MANAGER',
    name: 'QA Manager',
    keys: [
      'qa.view', 'qc.view', 'prod.view', 'inv.stock.view', 'master.view', 'core.audit.view',
      'qa.deviation.manage', 'qa.deviation.close', 'qa.batch.release', 'qa.lot.hold', 'qa.lot.witness', 'qa.lot.reject_fg',
      'qa.access.countersign', 'master.avl.approve', 'master.formula.approve', 'inv.adjustment.approve',
      'qa.product.countersign', 'master.item.approve', 'qa.attachment.countersign',
    ],
  },
  {
    code: 'SYSTEM_ADMIN',
    name: 'System Admin',
    keys: ['core.audit.view', 'core.user.manage', 'core.role.manage', 'core.settings.manage'],
  },
];

export const ROLE_SEEDS: readonly RoleSeed[] = roles.map((r) => ({
  ...r,
  keys: [...new Set<PermissionKey>([...r.keys, INBOX])],
}));

export const FIRST_ADMIN_USERNAME = 'admin';
