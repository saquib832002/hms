'use client';

/**
 * The vendor console's API client. Deliberately not the hospital one.
 *
 * WHY A SECOND CLIENT AND NOT A FLAG ON THE FIRST
 * -----------------------------------------------
 * A platform token and a hospital token are different credentials for different
 * principals against different routes, and the server treats them that way:
 * separate audiences, and a `PlatformGuard` that sets no `req.user` at all, so
 * a hospital token cannot reach a vendor route however it is pointed.
 *
 * Sharing `lib/api.ts` would put both tokens in one module variable, and the
 * failure mode of getting that wrong is not a bug report — it is a vendor
 * engineer's credential being sent to a hospital endpoint, or the reverse. Two
 * modules cannot make that mistake.
 *
 * It is also what keeps `endpoint-coverage.spec.ts` enforceable: only files
 * under `web/app/(platform)` and `web/lib/platform*` may name the vendor API,
 * and every other file in the client fails the build if it does.
 *
 * IN MEMORY, LIKE THE HOSPITAL TOKEN
 * ----------------------------------
 * Same reasoning: anything in localStorage is readable by an XSS payload, and
 * this token can open a break-glass grant against any hospital on the
 * deployment. Losing it on reload is the intended cost — the console asks the
 * vendor to sign in again rather than persisting the most powerful credential
 * in the system where script can read it.
 *
 * There is no silent refresh here, unlike the hospital client. Platform
 * sessions are short by design and a vendor engineer signing in again is not
 * the interruption it would be for a nurse mid-round.
 */

let platformToken: string | null = null;

export function setPlatformToken(token: string | null) {
  platformToken = token;
}

export function getPlatformToken() {
  return platformToken;
}

export class PlatformApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export async function platformApi<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = options;

  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(platformToken ? { Authorization: `Bearer ${platformToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    /*
     * The server's own wording, where it has one.
     *
     * A slug collision, an already-approved application, a rejected timezone —
     * the API states each precisely, and replacing that with "Request failed"
     * would throw away the only thing that tells the reviewer what to change.
     */
    const message = Array.isArray(payload.message)
      ? (payload.message as string[]).join('; ')
      : typeof payload.message === 'string'
        ? payload.message
        : `Request failed (${res.status})`;
    throw new PlatformApiError(res.status, message);
  }

  return payload as T;
}
