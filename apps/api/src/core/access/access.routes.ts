// /api/v1/core/users, /api/v1/core/roles, /api/v1/core/permissions.
// Mounted behind authenticate + requireCurrentPassword (app.ts). Every route declares its permission.
// Status-like changes use action endpoints (POST /:id/activate | /deactivate | /unlock | /reset-password),
// never PATCH (CLAUDE.md conventions).
import { Router } from 'express';
import { z } from 'zod';
import {
  CreateRoleRequest,
  CreateUserRequest,
  ListQuery,
  ResetPasswordRequest,
  RoleActionRequest,
  SetRolePermissionsRequest,
  SetUserRolesRequest,
  UpdateRoleRequest,
  UpdateUserRequest,
} from '@albert/shared';
import { requireAnyPermission, requirePermission } from '../rbac/require-permission';
import { asyncHandler, authOf, requestMeta } from '../auth/middleware';
import { unlockUser } from '../auth/auth.service';
import * as access from './access.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });

export const accessRouter = Router();

// ---------------------------------------------------------------- users (core.user.manage)

accessRouter.get(
  '/users',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    res.json(await access.listUsers(authOf(req), ListQuery.parse(req.query)));
  }),
);

accessRouter.post(
  '/users',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await access.createUser(authOf(req), CreateUserRequest.parse(req.body)));
  }),
);

accessRouter.get(
  '/users/:id',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    res.json(await access.getUser(authOf(req), IdParam.parse(req.params).id));
  }),
);

accessRouter.patch(
  '/users/:id',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await access.updateUser(authOf(req), id, UpdateUserRequest.parse(req.body)));
  }),
);

accessRouter.post(
  '/users/:id/deactivate',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    res.json(await access.setUserActive(authOf(req), IdParam.parse(req.params).id, false));
  }),
);

accessRouter.post(
  '/users/:id/activate',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    res.json(await access.setUserActive(authOf(req), IdParam.parse(req.params).id, true));
  }),
);

accessRouter.post(
  '/users/:id/unlock',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    await unlockUser(authOf(req), IdParam.parse(req.params).id, requestMeta(req));
    res.status(204).end();
  }),
);

accessRouter.post(
  '/users/:id/reset-password',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    await access.resetPassword(authOf(req), id, ResetPasswordRequest.parse(req.body), requestMeta(req));
    res.status(204).end();
  }),
);

accessRouter.put(
  '/users/:id/roles',
  requirePermission('core.user.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await access.setUserRoles(authOf(req), id, SetUserRolesRequest.parse(req.body), requestMeta(req)));
  }),
);

// ---------------------------------------------------------------- roles and permissions

// Reading roles is needed both to manage roles and to assign them to users.
const canReadRoles = requireAnyPermission('core.role.manage', 'core.user.manage');

accessRouter.get(
  '/permissions',
  canReadRoles,
  asyncHandler(async (_req, res) => {
    res.json(await access.listPermissions());
  }),
);

accessRouter.get(
  '/roles',
  canReadRoles,
  asyncHandler(async (req, res) => {
    res.json(await access.listRoles(authOf(req)));
  }),
);

accessRouter.get(
  '/roles/:id',
  canReadRoles,
  asyncHandler(async (req, res) => {
    res.json(await access.getRole(authOf(req), IdParam.parse(req.params).id));
  }),
);

accessRouter.post(
  '/roles',
  requirePermission('core.role.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await access.createRole(authOf(req), CreateRoleRequest.parse(req.body), requestMeta(req)));
  }),
);

accessRouter.patch(
  '/roles/:id',
  requirePermission('core.role.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await access.updateRole(authOf(req), id, UpdateRoleRequest.parse(req.body)));
  }),
);

accessRouter.put(
  '/roles/:id/permissions',
  requirePermission('core.role.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await access.setRolePermissions(authOf(req), id, SetRolePermissionsRequest.parse(req.body), requestMeta(req)));
  }),
);

accessRouter.post(
  '/roles/:id/deactivate',
  requirePermission('core.role.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await access.setRoleActive(authOf(req), id, false, RoleActionRequest.parse(req.body), requestMeta(req)));
  }),
);

accessRouter.post(
  '/roles/:id/activate',
  requirePermission('core.role.manage'),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await access.setRoleActive(authOf(req), id, true, RoleActionRequest.parse(req.body), requestMeta(req)));
  }),
);
