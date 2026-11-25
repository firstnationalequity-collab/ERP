// /api/v1/purch/* — mounted behind authenticate + requireCurrentPassword (app.ts). M3 task 2.
// Reads need purch.view; each write declares its key. Status changes are action endpoints
// (POST /:id/submit | /cancel | /convert), never PATCH; PATCH edits a DRAFT only (CLAUDE.md conventions).
// Actions accept an optional Idempotency-Key so a double click replays the first result.
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ConvertPrRequest,
  CreateGrnRequest,
  CreatePoRequest,
  CreatePrRequest,
  PurchActionRequest,
  PurchListQuery,
  UpdateGrnRequest,
  UpdatePoRequest,
  UpdatePrRequest,
} from '@albert/shared';
import { requirePermission } from '../../core/rbac/require-permission';
import { asyncHandler, authOf } from '../../core/auth/middleware';
import { idempotent } from '../../core/idempotency/idempotency';
import * as prs from './requisitions.service';
import * as pos from './orders.service';
import * as grns from './grns.service';
import { grnLabelsPdf } from './grn-labels';

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
r.get('/grns/:id/labels.pdf', requirePermission('inv.label.print'), asyncHandler(async (req, res) => {
  const { fileName, pdf } = await grnLabelsPdf(authOf(req), idOf(req));
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${fileName}"`).send(pdf);
}));
