import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  restoreSession,
  setSessionExpiredHandler,
  switchRole as apiSwitchRole,
} from './api';
import { isIdleExpired } from './secure-session';
import { registerForPush, unregisterPush } from './push';
import type { AuthUser, UserRole } from './types';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** True when the session is alive but the screen is hidden behind a lock. */
  locked: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  unlock: () => Promise<boolean>;
  /**
   * Act as a different one of your own roles.
   *
   * Same contract as web: the server re-checks the assignment and issues a new
   * access token. Nothing is widened — this only chooses which held role is in
   * use, and the choice is recorded on every audited action afterwards.
   */
  switchRole: (role: UserRole) => Promise<void>;
  /**
   * Re-read the session from the server.
   *
   * The server already sends the hospital's currency and timezone on every
   * authenticated request, but this context holds the last copy it was handed —
   * at sign-in, at restore, or at a role switch. So an admin who changed the
   * currency kept seeing the old symbol until they signed out, which reads as
   * the setting not having saved.
   *
   * Cheaper and less alarming than making them sign out, and it is the same
   * call `restoreSession` already makes.
   */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const pushToken = useRef<string | null>(null);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    restoreSession()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      setLocked(false);
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  /**
   * Lock the screen after 15 idle minutes in the background.
   *
   * A phone left on a ward desk is the realistic threat here — it is small
   * enough to be picked up and carried off, and unlike a workstation nobody
   * notices it is unattended. The session survives; the *display* does not.
   * Unlocking is a biometric prompt rather than a password, because typing a
   * password on a phone keyboard between patients is the kind of friction
   * that gets a security control disabled.
   */
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current = Date.now();
        return;
      }
      if (next === 'active' && backgroundedAt.current !== null) {
        if (user && isIdleExpired(backgroundedAt.current)) setLocked(true);
        backgroundedAt.current = null;
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [user]);

  const signIn = useCallback(async (email: string, password: string) => {
    const u = await apiLogin(email, password);
    setUser(u);
    setLocked(false);
    // Registered only after a successful sign-in, so an unauthenticated device
    // never ends up on the notification list.
    pushToken.current = await registerForPush();
  }, []);

  const switchRole = useCallback(async (role: UserRole) => {
    // The outbox is deliberately untouched. A queued bedside observation was
    // recorded as a nurse and must replay as one — the server stamps the actor
    // from the token in use when it lands, so switching hats mid-queue would
    // otherwise rewrite who gave a dose.
    const next = await apiSwitchRole(role);
    setUser(next);
  }, []);

  const refreshUser = useCallback(async () => {
    // Failure is swallowed: a stale currency symbol is a cosmetic problem, and
    // dropping the session over one would turn it into a real one. If the
    // session has genuinely ended, the next request trips the expiry handler.
    try {
      setUser(await fetchMe());
    } catch {
      /* keep the copy we have */
    }
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout(pushToken.current ?? undefined);
    await unregisterPush();
    pushToken.current = null;
    setUser(null);
    setLocked(false);
  }, []);

  const unlock = useCallback(async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();

    // A device with no biometrics configured cannot be unlocked in place —
    // falling through to "just let them in" would make the lock decorative.
    if (!hasHardware || !enrolled) {
      await signOut();
      return false;
    }

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Meridian HMS',
      cancelLabel: 'Sign out',
      disableDeviceFallback: false,
    });

    if (result.success) {
      setLocked(false);
      return true;
    }
    return false;
  }, [signOut]);

  const value = useMemo(
    () => ({ user, loading, locked, signIn, signOut, unlock, switchRole, refreshUser }),
    [user, loading, locked, signIn, signOut, unlock, switchRole, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
