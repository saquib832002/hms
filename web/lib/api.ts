/**
 * API client.
 *
 * The access token lives in a module variable — in memory only, never in
 * localStorage. Anything readable by JavaScript is readable by an XSS payload,
 * and a stolen token here reads patient records. The long-lived credential is
 * the httpOnly refresh cookie, which script cannot touch at all.
 *
 * The cost is that a page reload loses the token, so the app silently
 * re-establishes one from the cookie on boot. That is the intended trade.
 */

import type { AuthUser } from './types';

let accessToken: string | null = null;

/** In-flight refresh, shared so a burst of 401s triggers one refresh, not five. */
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Called when the session is definitively over — the refresh token was
 * rejected, so there is no way back without signing in again.
 *
 * Without this, a dead session surfaces as an inline "session expired" message
 * on whatever screen the user happened to be on, and they sit there looking at
 * an application that no longer works. Every subsequent action fails the same
 * way. The app has to actually get them out.
 *
 * AuthProvider registers the handler; the module stays framework-agnostic so
 * it remains testable without React.
 */
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null) {
  onSessionExpired = handler;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
    public errors?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skips the 401-refresh-retry. Used by the auth calls themselves. */
  skipRefresh?: boolean;
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = res.statusText;
  let errors: string[] | undefined;
  try {
    const body = await res.json();
    // The API speaks RFC 7807 problem+json.
    detail = body.detail ?? body.title ?? detail;
    if (Array.isArray(body.errors)) errors = body.errors;
  } catch {
    /* non-JSON error body; the status is all we have */
  }
  return new ApiError(res.status, detail, detail, errors);
}

async function doRefresh(): Promise<string | null> {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken: string };
    accessToken = data.accessToken;
    return data.accessToken;
  } catch {
    return null;
  }
}

/**
 * At most one refresh in flight at a time.
 *
 * This matters more than it looks: refresh tokens rotate, and presenting an
 * already-used one is treated by the server as a replay — it revokes the
 * entire token family and forces a re-login. Three screens loading at once
 * and each firing its own refresh would log the user out.
 *
 * The slot is cleared when the promise *settles*, not on a timer. Concurrent
 * callers that arrived while it was pending already hold the same promise and
 * still get the result; anyone arriving afterwards correctly starts a new
 * refresh rather than reusing a token that has since been rotated again.
 */
/**
 * Exported for `lib/documents.ts`, which fetches PDFs rather than JSON and so
 * cannot go through `api()` — but must share the one in-flight refresh, or a
 * print and a page load racing each other would each start their own.
 */
export async function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipRefresh, headers, ...rest } = options;

  const doFetch = (token: string | null) =>
    fetch(`/api/v1${path}`, {
      ...rest,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string>),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let res = await doFetch(accessToken);

  // Access tokens last 15 minutes, so a 401 mid-session is expected rather
  // than exceptional. Refresh once and retry transparently.
  if (res.status === 401 && !skipRefresh) {
    const fresh = await refreshAccessToken();
    if (!fresh) {
      accessToken = null;
      // Fire-and-forget: the handler navigates to the login screen. The error
      // is still thrown so the calling screen stops rather than rendering
      // half-loaded state during the redirect.
      onSessionExpired?.();
      throw new ApiError(401, 'Your session has expired. Please sign in again.');
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
 * `hospital` is the tenant's own code, and it is only needed by somebody whose
 * address exists at more than one hospital.
 *
 * The API has accepted it since login was written and neither client could send
 * it, so anybody in that position got *Invalid email or password* against a
 * password that was perfectly correct — reported as a newly provisioned
 * hospital's temporary password not working. Omitted when blank rather than
 * sent as an empty string, which the DTO's slug pattern would refuse outright.
 */
export async function login(
  email: string,
  password: string,
  hospital?: string,
): Promise<AuthUser> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, ...(hospital ? { hospital } : {}) }),
  });
  if (!res.ok) throw await parseError(res);

  const data = (await res.json()) as { accessToken: string; user: AuthUser };
  accessToken = data.accessToken;
  return data.user;
}

/** Re-establishes a session from the refresh cookie. Null if there isn't one. */
export async function bootstrapSession(): Promise<AuthUser | null> {
  const token = await refreshAccessToken();
  if (!token) return null;
  try {
    return await api<AuthUser>('/auth/me', { skipRefresh: true });
  } catch {
    accessToken = null;
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } finally {
    accessToken = null;
  }
}
