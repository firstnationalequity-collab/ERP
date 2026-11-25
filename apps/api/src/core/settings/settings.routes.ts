// /api/v1/core/number-series, /fiscal-years, /fiscal-periods. Mounted behind authenticate + requireCurrentPassword.
import { Router } from 'express';
import { z } from 'zod';
import {
  CreateFiscalYearRequest,
  CreateNumberSeriesRequest,
  FiscalPeriodQuery,
  PeriodActionRequest,
  PeriodReopenRequest,
  UpdateNumberSeriesRequest,
} from '@albert/shared';
import { requireAnyPermission, requirePermission } from '../rbac/require-permission';
import { asyncHandler, authOf, requestMeta } from '../auth/middleware';
import * as numbering from './numbering.service';
import * as periods from './periods.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });

export const settingsRouter = Router();

// ---------------------------------------------------------------- number series (core.settings.manage)

settingsRouter.get(
  '/number-series',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    res.json(await numbering.listSeries(authOf(req)));
  }),
);

settingsRouter.post(
  '/number-series',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await numbering.createSeries(authOf(req), CreateNumberSeriesRequest.parse(req.body)));
  }),
);

settingsRouter.patch(
  '/number-series/:id',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await numbering.updateSeries(authOf(req), id, UpdateNumberSeriesRequest.parse(req.body)));
  }),
);

// ---------------------------------------------------------------- fiscal periods

settingsRouter.get(
  '/fiscal-periods',
  requireAnyPermission('core.period.manage', 'core.period.close', 'fin.view'),
  asyncHandler(async (req, res) => {
    const { fiscalYear } = FiscalPeriodQuery.parse(req.query);
    res.json(await periods.listPeriods(authOf(req), fiscalYear));
  }),
);

settingsRouter.post(
  '/fiscal-years',
  requirePermission('core.period.manage'),
  asyncHandler(async (req, res) => {
    const { startYear } = CreateFiscalYearRequest.parse(req.body);
    res.status(201).json(await periods.createFiscalYear(authOf(req), startYear));
  }),
);

// The per-move permission (core.period.close) is enforced by core/transition; the route checks it too.
settingsRouter.post(
  '/fiscal-periods/:id/close',
  requirePermission('core.period.close'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await periods.closePeriod(authOf(req), id, PeriodActionRequest.parse(req.body).reason));
  }),
);

settingsRouter.post(
  '/fiscal-periods/:id/reopen',
  requirePermission('core.period.close'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await periods.reopenPeriod(authOf(req), id, PeriodReopenRequest.parse(req.body), requestMeta(req)));
  }),
);
