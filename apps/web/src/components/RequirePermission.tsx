import type { ReactNode } from 'react';
import { Result } from 'antd';
import type { PermissionKey } from '@albert/shared';
import { useAuth } from '../auth/AuthContext';

/** Show the page only to holders of one of `anyOf`. The API checks again; this only avoids a dead screen. */
export function RequirePermission({ anyOf, children }: { anyOf: PermissionKey[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(...anyOf)) {
    return <Result status="403" title="Not allowed" subTitle="Your roles do not include access to this page." />;
  }
  return <>{children}</>;
}
