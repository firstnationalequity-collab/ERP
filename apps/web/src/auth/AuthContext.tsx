// Who is signed in, what they may do, and the 30-minute idle logout (decision Q4).
// The UI only hides what the API would refuse; the API is the authority (architecture §2).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CurrentUser, LoginRequest, LoginResponse, PermissionKey } from '@albert/shared';
import { api, onSessionLost, refreshSession, setAccessToken } from '../api/client';

export const IDLE_LOGOUT_MS = 30 * 60 * 1000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'] as const;

interface AuthState {
  user: CurrentUser | null;
  /** True until the first silent refresh has finished (page load). */
  restoring: boolean;
  /** Why the user was signed out, shown on the login page. */
  signedOutReason: string | null;
  login(input: LoginRequest): Promise<void>;
  logout(reason?: string): Promise<void>;
  /** Reload the current user (after a password change). */
  reload(): Promise<void>;
  can(key: PermissionKey): boolean;
  canAny(...keys: PermissionKey[]): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  const clear = useCallback((reason: string | null) => {
    setAccessToken(null);
    setUser(null);
    setSignedOutReason(reason);
  }, []);

  const logout = useCallback(
    async (reason?: string) => {
      await api('/core/auth/logout', { method: 'POST' }).catch(() => undefined);
      clear(reason ?? null);
    },
    [clear],
  );

  // Restore the session after a page reload (refresh cookie), once.
  useEffect(() => {
    onSessionLost(() => clear('Your session has ended. Please sign in again.'));
    void refreshSession()
      .then((res) => {
        if (res) setUser(res.user);
      })
      .finally(() => setRestoring(false));
  }, [clear]);

  // Idle logout: any activity restarts the 30-minute timer.
  useEffect(() => {
    if (!user) return undefined;
    const restart = () => {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        void logout('You were signed out after 30 minutes without activity.');
      }, IDLE_LOGOUT_MS);
    };
    restart();
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, restart, { passive: true });
    return () => {
      window.clearTimeout(idleTimer.current);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, restart);
    };
  }, [user, logout]);

  const login = useCallback(async (input: LoginRequest) => {
    const res = await api<LoginResponse>('/core/auth/login', { method: 'POST', body: input });
    setAccessToken(res.accessToken);
    setSignedOutReason(null);
    setUser(res.user);
  }, []);

  const reload = useCallback(async () => {
    setUser(await api<CurrentUser>('/core/auth/me'));
  }, []);

  const value = useMemo<AuthState>(() => {
    const keys = new Set(user?.permissions ?? []);
    return {
      user,
      restoring,
      signedOutReason,
      login,
      logout,
      reload,
      can: (key) => keys.has(key),
      canAny: (...k) => k.some((x) => keys.has(x)),
    };
  }, [user, restoring, signedOutReason, login, logout, reload]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
