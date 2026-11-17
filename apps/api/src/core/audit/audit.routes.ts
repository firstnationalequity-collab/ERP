// /api/v1/core/audit-log, /status-history, /e-signatures, /auth-events (core.audit.view) and
// /api/v1/core/settings (core.settings.manage). Mounted behind authenticate + requireCurrentPassword.
import { Router } from 'express';
import { z } from 'zod';
import { AuditLogQuery, AuthEventQuery, RecordQuery, UpdateSettingRequest } from '@albert/shared';
import { requirePermission } from '../rbac/require-permission';
import { asyncHandler, authOf } from '../auth/middleware';
import * as audit from './audit.service';
import * as appSettings from '../settings/app-settings.service';

const KeyParam = z.object({ key: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/, 'Invalid setting key') });

export const auditRouter = Router();

auditRouter.get(
  '/audit-log',
  requirePermission('core.audit.view'),
  asyncHandler(async (req, res) => {
    res.json(await audit.listAudit(authOf(req), AuditLogQuery.parse(req.query)));
  }),
);

auditRouter.get(
  '/audit-log/tables',
  requirePermission('core.audit.view'),
  asyncHandler(async (_req, res) => {
    res.json(await audit.listAuditTables());
  }),
);

auditRouter.get(
  '/status-history',
  requirePermission('core.audit.view'),
  asyncHandler(async (req, res) => {
    const { table, recordId } = RecordQuery.parse(req.query);
    res.json(await audit.recordStatusHistory(authOf(req), table, recordId));
  }),
);

auditRouter.get(
  '/e-signatures',
  requirePermission('core.audit.view'),
  asyncHandler(async (req, res) => {
    const { table, recordId } = RecordQuery.parse(req.query);
    res.json(await audit.recordSignatures(authOf(req), table, recordId));
  }),
);

auditRouter.get(
  '/auth-events',
  requirePermission('core.audit.view'),
  asyncHandler(async (req, res) => {
    res.json(await audit.listAuthEvents(authOf(req), AuthEventQuery.parse(req.query)));
  }),
);

auditRouter.get(
  '/settings',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    res.json(await appSettings.listSettings(authOf(req)));
  }),
);

auditRouter.put(
  '/settings/:key',
  requirePermission('core.settings.manage'),
  asyncHandler(async (req, res) => {
    const { key } = KeyParam.parse(req.params);
    res.json(await appSettings.updateSetting(authOf(req), key, UpdateSettingRequest.parse(req.body)));
  }),
);
