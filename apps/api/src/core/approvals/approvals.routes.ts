// /api/v1/core/approvals (inbox, detail, approve, reject) and /api/v1/core/approval-rules.
// Mounted behind authenticate + requireCurrentPassword.
import { Router } from 'express';
import { z } from 'zod';
import { ApprovalDecisionRequest, ListQuery, SetApprovalRulesRequest } from '@albert/shared';
import { requirePermission } from '../rbac/require-permission';
import { asyncHandler, authOf, requestMeta } from '../auth/middleware';
import * as approvals from './approvals.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });
const DocTypeParam = z.object({ docType: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Invalid document type') });

export const approvalsRouter = Router();

approvalsRouter.get(
  '/approvals/inbox',
  requirePermission('core.approval.inbox'),
  asyncHandler(async (req, res) => {
    res.json(await approvals.inbox(authOf(req), ListQuery.parse(req.query)));
  }),
);

approvalsRouter.get(
  '/approvals/inbox/count',
  requirePermission('core.approval.inbox'),
  asyncHandler(async (req, res) => {
    res.json({ count: await approvals.inboxCount(authOf(req)) });
  }),
);

approvalsRouter.get(
  '/approvals/:id',
  requirePermission('core.approval.inbox'),
  asyncHandler(async (req, res) => {
    res.json(await approvals.getApproval(authOf(req), IdParam.parse(req.params).id));
  }),
);

approvalsRouter.post(
  '/approvals/:id/approve',
  requirePermission('core.approval.inbox'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await approvals.approve(authOf(req), id, ApprovalDecisionRequest.parse(req.body), requestMeta(req)));
  }),
);

approvalsRouter.post(
  '/approvals/:id/reject',
  requirePermission('core.approval.inbox'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await approvals.reject(authOf(req), id, ApprovalDecisionRequest.parse(req.body), requestMeta(req)));
  }),
);

approvalsRouter.get(
  '/approval-rules',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    res.json(await approvals.listRules(authOf(req)));
  }),
);

approvalsRouter.put(
  '/approval-rules/:docType',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    const { docType } = DocTypeParam.parse(req.params);
    res.json(await approvals.setRules(authOf(req), docType, SetApprovalRulesRequest.parse(req.body)));
  }),
);
