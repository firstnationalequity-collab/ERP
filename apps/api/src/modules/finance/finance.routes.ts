// /api/v1/fin/* — mounted behind authenticate + requireCurrentPassword (app.ts).
// Finance masters (M2 task 4): reads need fin.view or master.view; writes need fin.master.manage.
// Activation is an action endpoint (POST /:id/activate | /deactivate), never PATCH.
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  CreateAccountRequest,
  CreateCostCenterRequest,
  CreatePostingRuleRequest,
  DeactivateRequest,
  FinListQuery,
  MasterActionRequest,
  UpdateAccountRequest,
  UpdateCostCenterRequest,
  UpdatePostingRuleRequest,
  type PermissionKey,
} from '@albert/shared';
import { requireAnyPermission, requirePermission } from '../../core/rbac/require-permission';
import { asyncHandler, authOf } from '../../core/auth/middleware';
import type { ActiveFlagTable } from './finance.repo';
import * as svc from './masters.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });
const idOf = (req: Request) => IdParam.parse(req.params).id;
const listQuery = (req: Request) => FinListQuery.parse(req.query);
const READ = requireAnyPermission('fin.view', 'master.view');
const MANAGE: PermissionKey = 'fin.master.manage';

export const financeRouter = Router();
const r = financeRouter;

function activeFlagRoutes(resource: ActiveFlagTable): void {
  r.post(
    `/${resource}/:id/activate`,
    requirePermission(MANAGE),
    asyncHandler(async (req, res) => {
      const { reason } = MasterActionRequest.parse(req.body ?? {});
      await svc.setFinanceMasterActive(authOf(req), resource, idOf(req), true, reason);
      res.status(204).end();
    }),
  );
  r.post(
    `/${resource}/:id/deactivate`,
    requirePermission(MANAGE),
    asyncHandler(async (req, res) => {
      const { reason } = DeactivateRequest.parse(req.body ?? {});
      await svc.setFinanceMasterActive(authOf(req), resource, idOf(req), false, reason);
      res.status(204).end();
    }),
  );
}

// ---------------------------------------------------------------- chart of accounts
r.get('/accounts', READ, asyncHandler(async (req, res) => { res.json(await svc.listAccounts(authOf(req), listQuery(req))); }));
r.get('/accounts/:id', READ, asyncHandler(async (req, res) => { res.json(await svc.getAccount(authOf(req), idOf(req))); }));
r.post('/accounts', requirePermission(MANAGE), asyncHandler(async (req, res) => {
  res.status(201).json(await svc.createAccount(authOf(req), CreateAccountRequest.parse(req.body)));
}));
r.patch('/accounts/:id', requirePermission(MANAGE), asyncHandler(async (req, res) => {
  res.json(await svc.updateAccount(authOf(req), idOf(req), UpdateAccountRequest.parse(req.body)));
}));
activeFlagRoutes('accounts');

// ---------------------------------------------------------------- cost centres
r.get('/cost-centers', READ, asyncHandler(async (req, res) => { res.json(await svc.listCostCenters(authOf(req), listQuery(req))); }));
r.get('/cost-centers/:id', READ, asyncHandler(async (req, res) => { res.json(await svc.getCostCenter(authOf(req), idOf(req))); }));
r.post('/cost-centers', requirePermission(MANAGE), asyncHandler(async (req, res) => {
  res.status(201).json(await svc.createCostCenter(authOf(req), CreateCostCenterRequest.parse(req.body)));
}));
r.patch('/cost-centers/:id', requirePermission(MANAGE), asyncHandler(async (req, res) => {
  res.json(await svc.updateCostCenter(authOf(req), idOf(req), UpdateCostCenterRequest.parse(req.body)));
}));
activeFlagRoutes('cost-centers');

// ---------------------------------------------------------------- posting rules
r.get('/posting-rules', READ, asyncHandler(async (req, res) => { res.json(await svc.listPostingRules(authOf(req), listQuery(req))); }));
r.get('/posting-rules/:id', READ, asyncHandler(async (req, res) => { res.json(await svc.getPostingRule(authOf(req), idOf(req))); }));
r.post('/posting-rules', requirePermission(MANAGE), asyncHandler(async (req, res) => {
  res.status(201).json(await svc.createPostingRule(authOf(req), CreatePostingRuleRequest.parse(req.body)));
}));
r.patch('/posting-rules/:id', requirePermission(MANAGE), asyncHandler(async (req, res) => {
  res.json(await svc.updatePostingRule(authOf(req), idOf(req), UpdatePostingRuleRequest.parse(req.body)));
}));
activeFlagRoutes('posting-rules');
