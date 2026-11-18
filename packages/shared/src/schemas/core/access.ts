// User and role administration (docs/architecture.md §3, §7.1; decisions Q1, Q5–Q7, Q14).
import { z } from 'zod';
import { PermissionKeys, type PermissionKey } from '../../permissions';
import type { PermissionClass } from '../../enums';
import { WitnessSignRequest } from './esign';

const permissionKey = z.enum(PermissionKeys as [PermissionKey, ...PermissionKey[]]);
const id = z.string().regex(/^\d+$/, 'Invalid id');
/** Why the change is made; stored in the audit log. */
const changeReason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);

export const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------- users

export const CreateUserRequest = z
  .object({
    username: z.string().trim().regex(/^[A-Za-z0-9._-]{2,40}$/, 'Employee code: 2–40 letters, digits, . _ -'),
    fullName: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200).optional(),
    /** Given to the user; they must change it at first login. */
    temporaryPassword: z.string().min(1).max(200),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

/** Details only. Activation, roles and passwords have their own action endpoints. */
export const UpdateUserRequest = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
  })
  .strict();
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const ResetPasswordRequest = z.object({ temporaryPassword: z.string().min(1).max(200) }).strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

/**
 * Replace a user's roles. Adding or removing a role that holds a QA-controlled key (`qaControlled`) needs a
 * QA Manager countersign (`countersign`, signed at the same terminal).
 */
export const SetUserRolesRequest = z
  .object({
    roleIds: z.array(id).max(50),
    reason: changeReason,
    countersign: WitnessSignRequest.optional(),
  })
  .strict();
export type SetUserRolesRequest = z.infer<typeof SetUserRolesRequest>;

export interface UserDto {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  passwordExpired: boolean;
  lastLoginAt: string | null;
  roles: { id: string; code: string; name: string }[];
}

// ---------------------------------------------------------------- roles

export const CreateRoleRequest = z
  .object({
    code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Code: upper case letters, digits and _'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    keys: z.array(permissionKey).max(200),
    reason: changeReason,
    countersign: WitnessSignRequest.optional(),
  })
  .strict();
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

/** Name and description only; the bundle, activation and assignments have their own endpoints. */
export const UpdateRoleRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;

export const SetRolePermissionsRequest = z
  .object({
    keys: z.array(permissionKey).max(200),
    reason: changeReason,
    countersign: WitnessSignRequest.optional(),
  })
  .strict();
export type SetRolePermissionsRequest = z.infer<typeof SetRolePermissionsRequest>;

/** Activate / deactivate a role. */
export const RoleActionRequest = z
  .object({
    reason: changeReason,
    countersign: WitnessSignRequest.optional(),
  })
  .strict();
export type RoleActionRequest = z.infer<typeof RoleActionRequest>;

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  keys: PermissionKey[];
  userCount: number;
  /** True when the role holds a QA-controlled key (`qaControlled`): changes need a QA Manager countersign. */
  needsCountersign: boolean;
}

export interface PermissionDto {
  key: PermissionKey;
  class: PermissionClass;
  description: string;
}
