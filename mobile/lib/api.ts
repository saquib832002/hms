import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { SecureSession, SecureStorage } from './secure-session';
import type { AuthUser, UserRole } from './types';
import { actableRoles } from './nav';

/**
 * Every role has screens here.
 *
 * This used to be a subset — doctor, nurse, pharmacist, admin — and reception
 * and billing were refused at login with a message pointing them at the web
 * app. The comment above the check said the backend "would refuse every
 * clinical call anyway", which was simply untrue: reception has its own
 * perfectly good endpoints and always did. The real reason was that nobody had
 * built reception screens, and an absence of screens had been written up as
 * though it were a policy.
 *
 * It also failed the people this product is for. A small clinic where the
 * receptionist has a phone and no desktop is the normal case, not the edge
 * case — and check-in is *better* on a phone, since you are standing next to
 * the person you are checking in.
 *
 * The security argument pointed the other way too: reception sees the least
 * PHI in the system — `toPatientResponse` withholds allergies and diagnoses
 * from them — while doctors and nurses, who already carried the app, see the
 * most.
 *
 * Kept as a named list rather than deleted, because `role-screens.test.ts`
 * asserts every UserRole appears here *and* has a tab. That way the next role
 * added to the enum fails the build instead of silently getting a blank app.
 */
export const MOBILE_ROLES: UserRole[] = [
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'ADMIN',
  'RECEPTIONIST',
  'BILLING_STAFF',
  'LAB_TECHNICIAN',
];

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
 * Where the API lives, from the phone's point of view.
 *
 * WHY THIS IS DERIVED RATHER THAN CONFIGURED
 * ------------------------------------------
 * `localhost` on a phone is the phone. The obvious fix is to write the dev
 * machine's LAN IP into app.json — which works exactly until the router hands
 * out a different lease, someone joins a different network, or the file is read
 * from a stale Metro cache. Every one of those presents identically: a
 * connection error with a correct-looking IP sitting in the config.
 *
 * So in development the host is taken from the Expo dev server instead. That
 * address is *known* to be reachable, because the JavaScript bundle currently
 * running was downloaded over it. It costs nothing to compute and cannot go
 * stale.
 *
 * `extra.apiOrigin` still wins when there is no dev server — a standalone or
 * production build — where a real hostname has to be configured. That value
 * comes from `app.config.js`, chosen by `APP_ENV` at build time, so shipping a
 * release no longer means editing a committed file and remembering to change
 * it back.
 */
function devServerHost(): string | null {
  // hostUri is the modern field; the others are fallbacks across SDK versions
  // and launch modes. Shape is always "host:port", e.g. "192.168.1.42:8081".
  // Cast rather than trust the published types: `hostUri` and `debuggerHost`
  // are present at runtime but move between the typed surfaces across SDK
  // versions, and a compile error here would be a worse outcome than a
  // null check.
  const c = Constants as unknown as {
    expoConfig?: { hostUri?: string } | null;
    expoGoConfig?: { debuggerHost?: string } | null;
    manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } } | null;
  };

  const candidates = [
    c.expoConfig?.hostUri,
    c.expoGoConfig?.debuggerHost,
    c.manifest2?.extra?.expoGo?.debuggerHost,
  ];

  for (const candidate of candidates) {
    const host = candidate?.split(':')[0]?.trim();
    // A dev server on localhost means the simulator, where localhost is right.
    if (host && host.length > 0) return host;
  }
  return null;
}

let loggedOrigin = false;

export function apiOrigin(): string {
  const extra = Constants.expoConfig?.extra as
    | { apiOrigin?: string | null; apiPort?: number; appEnv?: string }
    | undefined;
  const port = extra?.apiPort ?? 3000;

  const host = devServerHost();
  /*
   * The dev server's host wins where there is one — that is what makes the app
   * work on any LAN without configuration. `extra.apiOrigin` is set by
   * `app.config.js` per environment and is what a standalone build falls back
   * to, which is precisely when a wrong value is hardest to spot: no Metro
   * terminal, no log to read, just "network request failed".
   */
  const resolved = host ? `http://${host}:${port}` : (extra?.apiOrigin ?? `http://localhost:${port}`);

  /*
   * Logged once, on purpose.
   *
   * "Connection error" with no indication of what was dialled is the single
   * least debuggable failure in this app — it looks the same whether the IP is
   * wrong, the firewall is closed, or the config never loaded. One line in the
   * Metro terminal removes the guesswork.
   */
  if (__DEV__ && !loggedOrigin) {
    loggedOrigin = true;
    console.log(
      `[api] using ${resolved}` +
        (host ? ` (derived from Expo dev server host ${host})` : ' (no dev server — from app.config.js)'),
    );
  }

  return resolved;
}

/**
 * Which build this is — `development`, `staging` or `production`.
 *
 * Shown on the Account screen. Two builds with different package ids can sit on
 * one phone, and telling them apart by icon alone is how somebody records
 * vitals into the wrong database.
 */
export function appEnv(): string {
  const extra = Constants.expoConfig?.extra as { appEnv?: string } | undefined;
  return extra?.appEnv ?? 'development';
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

/**
 * `hospital` is the tenant's own code, needed only by somebody whose address
 * exists at more than one hospital.
 *
 * The API has accepted it since login was written and neither client could send
 * it, so anybody in that position got *Invalid email or password* against a
 * correct password. Omitted when blank rather than sent empty, which the DTO's
 * slug pattern would refuse outright.
 */
export async function login(
  email: string,
  password: string,
  hospital?: string,
): Promise<AuthUser> {
  const res = await fetch(`${apiOrigin()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, ...(hospital ? { hospital } : {}) }),
  });
  if (!res.ok) throw await parseError(res);

  const data = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: AuthUser;
  };

  /*
   * A backstop, not a policy. Every role in the enum has screens, and a test
   * asserts that. This stays only so a role added to `UserRole` without a tab
   * gets a clear refusal rather than an empty app — and the message says the
   * app is incomplete, because that is what it would mean.
   */
  if (!MOBILE_ROLES.includes(data.user.role)) {
    throw new ApiError(
      500,
      'This app has no screens for your role yet. Please use the web application and report this.',
    );
  }

  session.setAccessToken(data.accessToken);
  await session.setRefreshToken(data.refreshToken);
  return data.user;
}

/**
 * Act as a different one of your own roles.
 *
 * An owner-doctor who also holds RECEPTIONIST can now switch into it here and
 * get real screens, which is the point of the change: one person, several
 * hats, one login, and an audit trail that can still answer "what did Dr Smith
 * do today".
 *
 * `switchableRoles` is what the UI should offer; this is the enforcement.
 */
export async function switchRole(role: string): Promise<AuthUser> {
  if (!MOBILE_ROLES.includes(role as AuthUser['role'])) {
    throw new ApiError(
      500,
      'This app has no screens for that role yet. Please use the web application and report this.',
    );
  }

  const data = await api<{ accessToken: string; user: AuthUser }>('/auth/switch-role', {
    method: 'POST',
    body: { role },
  });

  session.setAccessToken(data.accessToken);
  return data.user;
}

/**
 * The roles this app can actually show, out of those the user holds.
 *
 * Two narrowings, and they answer different questions. `MOBILE_ROLES` is which
 * roles the phone has screens for — a curated subset, deliberately. `actableRoles`
 * is which the *hospital* can use: a module removed at the vendor never strips
 * an assignment, so somebody can still hold DOCTOR at a hospital that gave up
 * the clinic, and offering it would mean switching into an app with no tabs.
 *
 * `POST /auth/switch-role` refuses the same set, so this is the picker rather
 * than the boundary.
 */
export function switchableRoles(user: AuthUser | null): AuthUser['role'][] {
  return actableRoles(user?.availableRoles ?? [], user?.hospital.modules).filter((r) =>
    MOBILE_ROLES.includes(r),
  );
}

/**
 * Re-read the signed-in user.
 *
 * `JwtStrategy` resolves the user, their held roles and their hospital's
 * settings from the database on every request, so this is always current — it
 * is the client's *cached copy* that goes stale, not the server's answer.
 */
export async function fetchMe(): Promise<AuthUser> {
  return api<AuthUser>('/auth/me');
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
