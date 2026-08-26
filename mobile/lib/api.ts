import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { SecureSession, SecureStorage } from './secure-session';
import type { AuthUser, UserRole } from './types';

/** Roles with a real mobile experience. Everything else is desk work. */
export const MOBILE_ROLES: UserRole[] = ['DOCTOR', 'NURSE', 'PHARMACIST', 'ADMIN'];

/**
 * API client.
 *
 * Mirrors web/lib/api.ts in behaviour — one shared in-flight refresh, retry
 * once with the new token, sign out when the refresh itself is rejected — with
 * one difference that matters: there is no cookie jar to lean on.
 *
 * The web client keeps the refresh token in an httpOnly cookie that JavaScript
 * cannot read. A React Native app has no such thing, so the token is handed
 * back in the login response body (the backend was built to do this) and
 * stored in the Keychain. That is why `SecureSession` exists and why nothing
 * here ever touches AsyncStorage.
 */

const expoStorage: SecureStorage = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) =>
    SecureStore.setItemAsync(k, v, {
      // Not readable while the device is locked, and never included in an
      // iCloud or iTunes backup.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: (k) => SecureStore.deleteItemAsync(k),
};

export const session = new SecureSession(expoStorage);

/**
 * On a device this must be the dev machine's LAN IP — `localhost` on a phone
 * is the phone. Set it in app.json under `expo.extra.apiOrigin`.
 */
export function apiOrigin(): string {
  const configured = (Constants.expoConfig?.extra as { apiOrigin?: string } | undefined)?.apiOrigin;
  return configured ?? 'http://localhost:3000';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let refreshInFlight: Promise<string | null> | null = null;
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null) {
  onSessionExpired = handler;
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = res.statusText || 'Request failed';
  let errors: string[] | undefined;
  try {
    const body = await res.json();
    detail = body.detail ?? body.title ?? detail;
    if (Array.isArray(body.errors)) errors = body.errors;
  } catch {
    /* non-JSON body */
  }
  return new ApiError(res.status, detail, errors);
}

async function doRefresh(): Promise<string | null> {
  try {
    const refreshToken = await session.getRefreshToken();
    if (!refreshToken) return null;

    const res = await fetch(`${apiOrigin()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    session.setAccessToken(data.accessToken);
    // Refresh tokens rotate — storing the new one is not optional. Miss this
    // and the next refresh presents a used token, which the server treats as
    // a replay and revokes the whole family.
    await session.setRefreshToken(data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  skipRefresh?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipRefresh, headers, ...rest } = options;

  const doFetch = (token: string | null) =>
    fetch(`${apiOrigin()}/api/v1${path}`, {
      ...rest,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string>),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let res = await doFetch(session.getAccessToken());

  if (res.status === 401 && !skipRefresh) {
    const fresh = await refreshAccessToken();
    if (!fresh) {
      await session.clear();
      onSessionExpired?.();
      throw new ApiError(401, 'Your session has ended. Please sign in again.');
    }
    res = await doFetch(fresh);
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return (await res.text()) as T;
  return (await res.json()) as T;
}

// ── auth ──────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${apiOrigin()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await parseError(res);

  const data = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: AuthUser;
  };

  // Only roles with screens here. Letting reception sign in would give them a
  // shell with nothing in it and a confusing set of 403s; the backend would
  // refuse every clinical call anyway.
  if (!MOBILE_ROLES.includes(data.user.role)) {
    throw new ApiError(
      403,
      'This app is not available for your role. Please use the web application.',
    );
  }

  session.setAccessToken(data.accessToken);
  await session.setRefreshToken(data.refreshToken);
  return data.user;
}

/**
 * Act as a different one of your own roles.
 *
 * Mirrors login in one important way: the role must be one this app has
 * screens for. An owner-doctor can hold RECEPTIONIST too, and switching into
 * it here would leave them in a shell with no tabs and a string of 403s — so
 * the refusal is explicit and names the web app instead.
 *
 * `switchableRoles` is what the UI should offer; this is the enforcement.
 */
export async function switchRole(role: string): Promise<AuthUser> {
  if (!MOBILE_ROLES.includes(role as AuthUser['role'])) {
    throw new ApiError(
      400,
      'That role has no screens in this app. Please use the web application.',
    );
  }

  const data = await api<{ accessToken: string; user: AuthUser }>('/auth/switch-role', {
    method: 'POST',
    body: { role },
  });

  session.setAccessToken(data.accessToken);
  return data.user;
}

/** The roles this app can actually show, out of those the user holds. */
export function switchableRoles(user: AuthUser | null): AuthUser['role'][] {
  return (user?.availableRoles ?? []).filter((r) => MOBILE_ROLES.includes(r));
}

export async function restoreSession(): Promise<AuthUser | null> {
  const token = await refreshAccessToken();
  if (!token) return null;
  try {
    return await api<AuthUser>('/auth/me', { skipRefresh: true });
  } catch {
    await session.clear();
    return null;
  }
}

export async function logout(pushToken?: string): Promise<void> {
  const refreshToken = await session.getRefreshToken();
  try {
    // Unregister the device first — otherwise this phone keeps receiving
    // alerts about patients for a doctor who has signed off.
    if (pushToken) {
      await api('/devices', { method: 'DELETE', body: { pushToken } }).catch(() => {});
    }
    if (refreshToken) {
      await fetch(`${apiOrigin()}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    }
  } finally {
    await session.clear();
  }
}
