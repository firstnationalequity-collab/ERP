// Request/response shapes for /api/v1/core/auth. Shared by the API (validation) and the web app (forms).
import { z } from 'zod';
import type { PermissionKey } from '../../permissions';

export const LoginRequest = z.object({
  username: z.string().trim().min(1, 'Username is required').max(40),
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export interface CurrentUser {
  id: string;
  username: string;
  fullName: string;
  /** First login or admin reset: only change-password, me and logout work until it is changed. */
  mustChangePassword: boolean;
  /** Older than 90 days: same restriction as mustChangePassword. */
  passwordExpired: boolean;
  permissions: PermissionKey[];
}

export interface LoginResponse {
  accessToken: string;
  /** ISO timestamp when the access token expires (15 min). */
  accessTokenExpiresAt: string;
  user: CurrentUser;
}
