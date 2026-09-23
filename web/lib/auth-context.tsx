'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  api,
  bootstrapSession,
  login as apiLogin,
  logout as apiLogout,
  setAccessToken,
  setSessionExpiredHandler,
} from './api';
import { landingFor } from './nav';
import type { AuthUser, UserRole } from './types';

interface AuthState {
  user: AuthUser | null;
  /** True until the initial silent refresh has settled. */
  loading: boolean;
  signIn: (email: string, password: string, hospital?: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  /**
   * Act as a different one of your own roles.
   *
   * The server issues a new access token for the requested role and re-checks
   * the assignment; this never widens what the session can do, it only chooses
   * which of the person's roles is in use.
   */
  switchRole: (role: UserRole) => Promise<AuthUser>;
  /**
   * Re-read the session from the server.
   *
   * The server resolves the hospital's currency and timezone on every request,
   * but this context holds the last copy it was handed — at sign-in, at
   * bootstrap, or at a role switch. An admin who changed the currency kept
   * seeing the old symbol until the next sign-in, which reads as the setting
   * not having saved at all.
   */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  // On boot, try to re-establish a session from the httpOnly refresh cookie.
  // The access token was lost with the page reload — by design.
  useEffect(() => {
    let cancelled = false;
    bootstrapSession()
      .then((u) => !cancelled && setUser(u))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Sessions end on their own — a 7-day refresh token expires, or an admin
   * deactivates the account mid-shift. When that happens the app has to get
   * the user out rather than leaving them on a screen where nothing works.
   *
   * The path they were on is carried through so signing back in returns them
   * there; a nurse bounced to the patient list after re-auth has lost their
   * place for no reason.
   */
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      const next = pathname && pathname !== '/login' ? `?next=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${next}`);
    });
    return () => setSessionExpiredHandler(null);
  }, [router, pathname]);

  const signIn = useCallback(async (email: string, password: string, hospital?: string) => {
    const u = await apiLogin(email, password, hospital);
    setUser(u);
    return u;
  }, []);

  const switchRole = useCallback(async (role: UserRole) => {
    const { accessToken, user: next } = await api<{ accessToken: string; user: AuthUser }>(
      '/auth/switch-role',
      { method: 'POST', body: { role } },
    );
    // Replace the in-memory token so the very next request carries the new
    // role. The old one stays valid until it expires — it is a signed bearer
    // token and cannot be recalled — which is safe because switching only ever
    // moves between roles this person already holds.
    setAccessToken(accessToken);
    setUser(next);
    return next;
  }, []);

  const refreshUser = useCallback(async () => {
    // Failure is swallowed: a stale currency symbol is cosmetic, and ending the
    // session over one would turn it into a real problem. A genuinely dead
    // session trips the expiry handler on the next request anyway.
    try {
      setUser(await api<AuthUser>('/auth/me'));
    } catch {
      /* keep the copy we have */
    }
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    router.push('/login');
  }, [router]);

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, switchRole, refreshUser }),
    [user, loading, signIn, signOut, switchRole, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/**
 * The authenticated user, guaranteed non-null.
 *
 * Only valid inside the (app) layout, which does not render children until a
 * user exists. Saves every screen from a `user &&` dance.
 */
export function useUser(): AuthUser {
  const { user } = useAuth();
  if (!user) throw new Error('useUser called outside an authenticated layout');
  return user;
}

export { landingFor };
