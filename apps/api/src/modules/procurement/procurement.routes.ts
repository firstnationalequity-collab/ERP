// /api/v1/purch/* — mounted behind authenticate + requireCurrentPassword (app.ts). M3 task 2.
// Reads need purch.view; each write declares its key. Status changes are action endpoints
// (POST /:id/submit | /cancel | /convert), never PATCH; PATCH edits a DRAFT only (CLAUDE.md conventions).
// Actions accept an optional Idempotency-Key so a double click replays the first result.
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ApAgeingQuery,
  BillableQuery,
  ConvertPrRequest,
  CreateVendorInvoiceRequest,
  CreateVendorPaymentRequest,
  CreateDebitNoteRequest,
  DebitNoteListQuery,
  PostDebitNoteRequest,
  PostVendorPaymentRequest,
  ReverseVendorDocumentRequest,
  UpdateDebitNoteRequest,
  ReleaseVendorInvoiceRequest,
  UpdateVendorInvoiceRequest,
  UpdateVendorPaymentRequest,
  VendorInvoiceListQuery,
  VendorLedgerQuery,
  CreateGrnRequest,
  ApproveLandedCostCorrectionRequest,
  CreateLandedCostCorrectionRequest,
  CreateLandedCostRequest,
  CreateLandedCostTypeRequest,
  DeactivateRequest,
  LandedCostListQuery,
  MasterActionRequest,
  UpdateLandedCostRequest,
  UpdateLandedCostTypeRequest,
  CreatePoRequest,
  CreatePrRequest,
  GrnReverseRequest,
  PurchActionRequest,
  PurchListQuery,
  UpdateGrnRequest,
  UpdatePoRequest,
  UpdatePrRequest,
} from '@albert/shared';
import { requireAnyPermission, requirePermission } from '../../core/rbac/require-permission';
import { asyncHandler, authOf, requestMeta } from '../../core/auth/middleware';
import { idempotent } from '../../core/idempotency/idempotency';
import * as prs from './requisitions.service';
import * as pos from './orders.service';
import * as grns from './grns.service';
import { grnLabelsPdf } from './grn-labels';
import * as landed from './landed-costs.service';
import * as invoices from './invoices.service';
import * as payments from './payments.service';
import * as ap from './ap.service';
import * as notes from './debit-notes.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });
const idOf = (req: Request) => IdParam.parse(req.params).id;
const VIEW = requirePermission('purch.view');
const once = idempotent({ required: false });

export const procurementRouter = Router();
const r = procurementRouter;

// ---------------------------------------------------------------- purchase requisitions (purch.pr.manage)
r.get('/prs', VIEW, asyncHandler(async (req, res) => { res.json(await prs.listPrs(authOf(req), PurchListQuery.parse(req.query))); }));
r.get('/prs/:id', VIEW, asyncHandler(async (req, res) => { res.json(await prs.getPr(authOf(req), idOf(req))); }));
r.post('/prs', requirePermission('purch.pr.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await prs.createPr(authOf(req), CreatePrRequest.parse(req.body)));
}));
r.patch('/prs/:id', requirePermission('purch.pr.manage'), asyncHandler(async (req, res) => {
  res.json(await prs.updatePr(authOf(req), idOf(req), UpdatePrRequest.parse(req.body)));
}));
r.post('/prs/:id/submit', requirePermission('purch.pr.manage'), once, asyncHandler(async (req, res) => {
  res.json(await prs.submitPr(authOf(req), idOf(req)));
}));
r.post('/prs/:id/cancel', requirePermission('purch.pr.manage'), once, asyncHandler(async (req, res) => {
  res.json(await prs.cancelPr(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));
// Ordering a requisition creates a PO: the PO key.
r.post('/prs/:id/convert', requirePermission('purch.po.manage'), once, asyncHandler(async (req, res) => {
  res.status(201).json(await prs.convertPr(authOf(req), idOf(req), ConvertPrRequest.parse(req.body)));
}));

// ---------------------------------------------------------------- purchase orders (purch.po.manage; approval in the inbox)
r.get('/pos', VIEW, asyncHandler(async (req, res) => { res.json(await pos.listPos(authOf(req), PurchListQuery.parse(req.query))); }));
r.get('/pos/:id', VIEW, asyncHandler(async (req, res) => { res.json(await pos.getPo(authOf(req), idOf(req))); }));
r.post('/pos', requirePermission('purch.po.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await pos.createPo(authOf(req), CreatePoRequest.parse(req.body)));
}));
r.patch('/pos/:id', requirePermission('purch.po.manage'), asyncHandler(async (req, res) => {
  res.json(await pos.updatePo(authOf(req), idOf(req), UpdatePoRequest.parse(req.body)));
}));
r.post('/pos/:id/submit', requirePermission('purch.po.manage'), once, asyncHandler(async (req, res) => {
  res.json(await pos.submitPo(authOf(req), idOf(req)));
}));
r.post('/pos/:id/cancel', requirePermission('purch.po.manage'), once, asyncHandler(async (req, res) => {
  res.json(await pos.cancelPo(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));

// ---------------------------------------------------------------- goods received notes (purch.grn.post; M3 task 3)
const GrnListQuery = PurchListQuery.extend({ poId: z.string().regex(/^\d+$/).optional() });
const PoReceiptQuery = z
  .object({ poId: z.string().regex(/^\d+$/).optional(), docNo: z.string().trim().min(1).max(40).optional() })
  .refine((v) => v.poId || v.docNo, 'Give poId or docNo (scan the PO number)');
r.get('/grns', VIEW, asyncHandler(async (req, res) => { res.json(await grns.listGrns(authOf(req), GrnListQuery.parse(req.query))); }));
// "Scan the PO": what each line may still receive, and the APPROVED sources to pick from.
r.get('/grns/po-receipt', VIEW, asyncHandler(async (req, res) => { res.json(await grns.poReceipt(authOf(req), PoReceiptQuery.parse(req.query))); }));
r.get('/grns/:id', VIEW, asyncHandler(async (req, res) => { res.json(await grns.getGrn(authOf(req), idOf(req))); }));
r.post('/grns', requirePermission('purch.grn.post'), asyncHandler(async (req, res) => {
  res.status(201).json(await grns.createGrn(authOf(req), CreateGrnRequest.parse(req.body)));
}));
r.patch('/grns/:id', requirePermission('purch.grn.post'), asyncHandler(async (req, res) => {
  res.json(await grns.updateGrn(authOf(req), idOf(req), UpdateGrnRequest.parse(req.body)));
}));
// Posting action: Idempotency-Key required (CLAUDE.md conventions).
r.post('/grns/:id/post', requirePermission('purch.grn.post'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await grns.postGrn(authOf(req), idOf(req)));
}));
r.post('/grns/:id/cancel', requirePermission('purch.grn.post'), once, asyncHandler(async (req, res) => {
  res.json(await grns.cancelGrn(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));
// Owner 2026-11-25 (answer 5): Warehouse Manager, e-signature + reason; a posting action, so Idempotency-Key required.
r.post('/grns/:id/reverse', requirePermission('purch.grn.reverse'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await grns.reverseGrn(authOf(req), idOf(req), GrnReverseRequest.parse(req.body), requestMeta(req)));
}));
r.get('/grns/:id/labels.pdf', requirePermission('inv.label.print'), asyncHandler(async (req, res) => {
  const { fileName, pdf } = await grnLabelsPdf(authOf(req), idOf(req));
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${fileName}"`).send(pdf);
}));

// ---------------------------------------------------------------- landed cost (M3 task 4; owner Q21, Q2; 0029)
// Charge types are accounting policy (capitalise flag, tax role): Finance keeps them (fin.master.manage).
const TypesQuery = z.object({ active: z.enum(['true', 'false']).optional() });
r.get('/landed-cost-types', requireAnyPermission('purch.view', 'fin.view'), asyncHandler(async (req, res) => {
  res.json(await landed.listLandedCostTypes(authOf(req), TypesQuery.parse(req.query).active === 'true'));
}));
r.post('/landed-cost-types', requirePermission('fin.master.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await landed.createLandedCostType(authOf(req), CreateLandedCostTypeRequest.parse(req.body)));
}));
r.patch('/landed-cost-types/:id', requirePermission('fin.master.manage'), asyncHandler(async (req, res) => {
  res.json(await landed.updateLandedCostType(authOf(req), idOf(req), UpdateLandedCostTypeRequest.parse(req.body)));
}));
r.post('/landed-cost-types/:id/activate', requirePermission('fin.master.manage'), asyncHandler(async (req, res) => {
  res.json(await landed.setLandedCostTypeActive(authOf(req), idOf(req), true, MasterActionRequest.parse(req.body ?? {}).reason));
}));
r.post('/landed-cost-types/:id/deactivate', requirePermission('fin.master.manage'), asyncHandler(async (req, res) => {
  res.json(await landed.setLandedCostTypeActive(authOf(req), idOf(req), false, DeactivateRequest.parse(req.body ?? {}).reason));
}));

// Charges: the Purchase Officer enters them (purch.landed_cost.manage). A charge on a DRAFT GRN posts with the GRN
// (purch.grn.post); a later bill posts here, on its charge date (Idempotency-Key required).
r.get('/landed-costs', VIEW, asyncHandler(async (req, res) => { res.json(await landed.listLandedCosts(authOf(req), LandedCostListQuery.parse(req.query))); }));
r.get('/landed-costs/:id', VIEW, asyncHandler(async (req, res) => { res.json(await landed.getLandedCost(authOf(req), idOf(req))); }));
r.post('/landed-costs', requirePermission('purch.landed_cost.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await landed.createLandedCost(authOf(req), CreateLandedCostRequest.parse(req.body)));
}));
r.patch('/landed-costs/:id', requirePermission('purch.landed_cost.manage'), asyncHandler(async (req, res) => {
  res.json(await landed.updateLandedCost(authOf(req), idOf(req), UpdateLandedCostRequest.parse(req.body)));
}));
r.post('/landed-costs/:id/post', requirePermission('purch.landed_cost.manage'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await landed.postLandedCost(authOf(req), idOf(req)));
}));
// Corrections (owner 2026-11-25, 4b): entered by the Purchase Officer with a reason; a Finance Manager posts with an e-signature.
r.post('/landed-costs/:id/correct', requirePermission('purch.landed_cost.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await landed.createLandedCostCorrection(authOf(req), idOf(req), CreateLandedCostCorrectionRequest.parse(req.body)));
}));
r.post('/landed-costs/:id/approve', requirePermission('purch.landed_cost.correct'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await landed.approveLandedCostCorrection(authOf(req), idOf(req), ApproveLandedCostCorrectionRequest.parse(req.body), requestMeta(req)));
}));
r.post('/landed-costs/:id/cancel', requirePermission('purch.landed_cost.manage'), once, asyncHandler(async (req, res) => {
  res.json(await landed.cancelLandedCost(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));

// ---------------------------------------------------------------- vendor invoices, payments, ledger, ageing (M3 task 5; 0031)
// Finance reads them with fin.view, procurement with purch.view.
const AP_VIEW = requireAnyPermission('purch.view', 'fin.view');

// Invoices: the Accountant enters and posts (fin.invoice.manage); outside the match tolerances the invoice is held in
// MATCH_EXCEPTION and a Finance Manager releases it with an e-signature or returns it (fin.invoice.match_release).
r.get('/vendor-invoices', AP_VIEW, asyncHandler(async (req, res) => { res.json(await invoices.listVendorInvoices(authOf(req), VendorInvoiceListQuery.parse(req.query))); }));
r.get('/vendor-invoices/billable', AP_VIEW, asyncHandler(async (req, res) => { res.json(await invoices.billable(authOf(req), BillableQuery.parse(req.query))); }));
r.get('/vendor-invoices/:id', AP_VIEW, asyncHandler(async (req, res) => { res.json(await invoices.getVendorInvoice(authOf(req), idOf(req))); }));
r.post('/vendor-invoices', requirePermission('fin.invoice.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await invoices.createVendorInvoice(authOf(req), CreateVendorInvoiceRequest.parse(req.body)));
}));
r.patch('/vendor-invoices/:id', requirePermission('fin.invoice.manage'), asyncHandler(async (req, res) => {
  res.json(await invoices.updateVendorInvoice(authOf(req), idOf(req), UpdateVendorInvoiceRequest.parse(req.body)));
}));
r.post('/vendor-invoices/:id/post', requirePermission('fin.invoice.manage'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await invoices.postVendorInvoice(authOf(req), idOf(req)));
}));
r.post('/vendor-invoices/:id/release', requirePermission('fin.invoice.match_release'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await invoices.releaseVendorInvoice(authOf(req), idOf(req), ReleaseVendorInvoiceRequest.parse(req.body), requestMeta(req)));
}));
r.post('/vendor-invoices/:id/return', requirePermission('fin.invoice.match_release'), once, asyncHandler(async (req, res) => {
  res.json(await invoices.returnVendorInvoice(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));
r.post('/vendor-invoices/:id/cancel', requirePermission('fin.invoice.manage'), once, asyncHandler(async (req, res) => {
  res.json(await invoices.cancelVendorInvoice(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));
// Owner 2026-11-26 (task 5b): a Finance Manager reverses a posted invoice nothing is paid or debited against.
r.post('/vendor-invoices/:id/reverse', requirePermission('fin.invoice.reverse'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await invoices.reverseVendorInvoice(authOf(req), idOf(req), ReverseVendorDocumentRequest.parse(req.body), requestMeta(req)));
}));

// Payments: the AP Officer drafts, submits and posts (fin.payment.manage); the approval matrix (Finance Manager,
// /core/approvals/:id/approve) approves; creator ≠ approver.
r.get('/vendor-payments', AP_VIEW, asyncHandler(async (req, res) => { res.json(await payments.listVendorPayments(authOf(req), PurchListQuery.parse(req.query))); }));
r.get('/vendor-payments/:id', AP_VIEW, asyncHandler(async (req, res) => { res.json(await payments.getVendorPayment(authOf(req), idOf(req))); }));
r.post('/vendor-payments', requirePermission('fin.payment.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await payments.createVendorPayment(authOf(req), CreateVendorPaymentRequest.parse(req.body)));
}));
r.patch('/vendor-payments/:id', requirePermission('fin.payment.manage'), asyncHandler(async (req, res) => {
  res.json(await payments.updateVendorPayment(authOf(req), idOf(req), UpdateVendorPaymentRequest.parse(req.body)));
}));
r.post('/vendor-payments/:id/submit', requirePermission('fin.payment.manage'), once, asyncHandler(async (req, res) => {
  res.json(await payments.submitVendorPayment(authOf(req), idOf(req)));
}));
r.post('/vendor-payments/:id/post', requirePermission('fin.payment.manage'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await payments.postVendorPayment(authOf(req), idOf(req), PostVendorPaymentRequest.parse(req.body ?? {})));
}));
// Owner 2026-11-26 (task 5b): bounced cheque, wrong payment.
r.post('/vendor-payments/:id/reverse', requirePermission('fin.payment.reverse'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await payments.reverseVendorPayment(authOf(req), idOf(req), ReverseVendorDocumentRequest.parse(req.body), requestMeta(req)));
}));
r.post('/vendor-payments/:id/cancel', requirePermission('fin.payment.manage'), once, asyncHandler(async (req, res) => {
  res.json(await payments.cancelVendorPayment(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));

// Debit notes (owner 2026-11-26, task 5b; 0032): the Accountant enters, submits and posts price-claim / short-supply
// notes (fin.debit_note.manage); the approval matrix DEBIT_NOTE approves (fin.debit_note.approve); a return note is
// posted by the Warehouse Manager with a QA witness (inv.lot.dispose; the service picks the key by the note's reason).
r.get('/debit-notes', AP_VIEW, asyncHandler(async (req, res) => { res.json(await notes.listDebitNotes(authOf(req), DebitNoteListQuery.parse(req.query))); }));
r.get('/debit-notes/:id', AP_VIEW, asyncHandler(async (req, res) => { res.json(await notes.getDebitNote(authOf(req), idOf(req))); }));
r.get('/vendor-invoices/:id/debitable', AP_VIEW, asyncHandler(async (req, res) => { res.json(await notes.debitable(authOf(req), idOf(req))); }));
r.post('/debit-notes', requirePermission('fin.debit_note.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await notes.createDebitNote(authOf(req), CreateDebitNoteRequest.parse(req.body)));
}));
r.patch('/debit-notes/:id', requirePermission('fin.debit_note.manage'), asyncHandler(async (req, res) => {
  res.json(await notes.updateDebitNote(authOf(req), idOf(req), UpdateDebitNoteRequest.parse(req.body)));
}));
r.post('/debit-notes/:id/submit', requirePermission('fin.debit_note.manage'), once, asyncHandler(async (req, res) => {
  res.json(await notes.submitDebitNote(authOf(req), idOf(req)));
}));
r.post('/debit-notes/:id/post', requireAnyPermission('fin.debit_note.manage', 'inv.lot.dispose'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await notes.postDebitNote(authOf(req), idOf(req), PostDebitNoteRequest.parse(req.body ?? {}), requestMeta(req)));
}));
r.post('/debit-notes/:id/cancel', requirePermission('fin.debit_note.manage'), once, asyncHandler(async (req, res) => {
  res.json(await notes.cancelDebitNote(authOf(req), idOf(req), PurchActionRequest.parse(req.body).reason));
}));

// Vendor ledger and AP ageing.
r.get('/vendors/:id/open-invoices', AP_VIEW, asyncHandler(async (req, res) => { res.json(await payments.openInvoicesOfVendor(authOf(req), idOf(req))); }));
r.get('/vendors/:id/ledger', AP_VIEW, asyncHandler(async (req, res) => { res.json(await ap.vendorLedger(authOf(req), idOf(req), VendorLedgerQuery.parse(req.query))); }));
r.get('/ap-ageing', AP_VIEW, asyncHandler(async (req, res) => { res.json(await ap.apAgeing(authOf(req), ApAgeingQuery.parse(req.query))); }));
