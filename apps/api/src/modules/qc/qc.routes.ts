// /api/v1/qc/* — mounted behind authenticate + requireCurrentPassword (app.ts). M4.
// Reads need qc.view; each write declares its key. Status changes are action endpoints (POST /:id/submit |
// /approve | /reject), never PATCH; PATCH edits a DRAFT only (CLAUDE.md conventions).
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ApproveSpecRequest,
  CreateSpecRequest,
  EnterResultsRequest,
  RejectSpecRequest,
  ReviewResultsRequest,
  SampleListQuery,
  SetSpecTestsRequest,
  SpecListQuery,
  TakeSampleRequest,
  UpdateSpecRequest,
} from '@albert/shared';
import { requirePermission } from '../../core/rbac/require-permission';
import { asyncHandler, authOf, requestMeta } from '../../core/auth/middleware';
import { idempotent } from '../../core/idempotency/idempotency';
import * as specs from './specs.service';
import * as samples from './samples.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });
const idOf = (req: Request) => IdParam.parse(req.params).id;
const VIEW = requirePermission('qc.view');
const once = idempotent({ required: false });

export const qcRouter = Router();
const r = qcRouter;

// ---------------------------------------------------------------- specifications (M4 task 1; 0034)
// QC Analyst drafts and submits (qc.spec.manage); QC Manager approves with an e-signature or rejects (qc.spec.approve).
r.get('/specs', VIEW, asyncHandler(async (req, res) => { res.json(await specs.listSpecs(authOf(req), SpecListQuery.parse(req.query))); }));
r.get('/specs/:id', VIEW, asyncHandler(async (req, res) => { res.json(await specs.getSpec(authOf(req), idOf(req))); }));
r.post('/specs', requirePermission('qc.spec.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await specs.createSpec(authOf(req), CreateSpecRequest.parse(req.body)));
}));
r.patch('/specs/:id', requirePermission('qc.spec.manage'), asyncHandler(async (req, res) => {
  res.json(await specs.updateSpec(authOf(req), idOf(req), UpdateSpecRequest.parse(req.body)));
}));
r.put('/specs/:id/tests', requirePermission('qc.spec.manage'), asyncHandler(async (req, res) => {
  res.json(await specs.setSpecTests(authOf(req), idOf(req), SetSpecTestsRequest.parse(req.body)));
}));
r.post('/specs/:id/submit', requirePermission('qc.spec.manage'), once, asyncHandler(async (req, res) => {
  res.json(await specs.submitSpec(authOf(req), idOf(req)));
}));
r.post('/specs/:id/approve', requirePermission('qc.spec.approve'), once, asyncHandler(async (req, res) => {
  res.json(await specs.approveSpec(authOf(req), idOf(req), ApproveSpecRequest.parse(req.body), requestMeta(req)));
}));
r.post('/specs/:id/reject', requirePermission('qc.spec.approve'), once, asyncHandler(async (req, res) => {
  res.json(await specs.rejectSpec(authOf(req), idOf(req), RejectSpecRequest.parse(req.body).reason));
}));

// ---------------------------------------------------------------- sample queue, results, review (M4 task 2; 0035, 0036)
// QC Analyst takes the sample (posts SAMPLE_ISSUE: Idempotency-Key required) and enters results (qc.result.enter);
// QC Manager reviews them with an e-signature (qc.result.review).
r.get('/samples', VIEW, asyncHandler(async (req, res) => { res.json(await samples.listSamples(authOf(req), SampleListQuery.parse(req.query))); }));
r.get('/samples/:id', VIEW, asyncHandler(async (req, res) => { res.json(await samples.getSample(authOf(req), idOf(req))); }));
r.post('/samples/:id/take', requirePermission('qc.result.enter'), idempotent(), asyncHandler(async (req, res) => {
  res.json(await samples.takeSample(authOf(req), idOf(req), TakeSampleRequest.parse(req.body)));
}));
r.post('/samples/:id/results', requirePermission('qc.result.enter'), once, asyncHandler(async (req, res) => {
  res.json(await samples.enterResults(authOf(req), idOf(req), EnterResultsRequest.parse(req.body)));
}));
r.post('/samples/:id/review', requirePermission('qc.result.review'), once, asyncHandler(async (req, res) => {
  res.json(await samples.reviewResults(authOf(req), idOf(req), ReviewResultsRequest.parse(req.body), requestMeta(req)));
}));
