import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  getAccessToken,
  login,
  setAccessToken,
  setSessionExpiredHandler,
} from './api';

/**
 * The refresh dance is the part of this client most likely to break quietly.
 *
 * If it stops working, nothing throws visibly — users just get logged out
 * every fifteen minutes and assume the app is flaky. These tests pin the
 * behaviour that keeps that from happening.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSessionExpiredHandler(null);
  });

  it('sends the access token as a bearer header', async () => {
    setAccessToken('token-abc');
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api('/patients');

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
  });

  it('sends credentials so the httpOnly refresh cookie travels', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await api('/patients');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('prefixes every request with /api/v1 so the Next proxy handles it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await api('/patients/7');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/patients/7');
  });

  describe('401 handling', () => {
    it('refreshes and retries once, transparently', async () => {
      setAccessToken('expired');
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401)) // original
        .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' })) // refresh
        .mockResolvedValueOnce(jsonResponse({ id: 1 })); // retry

      const result = await api<{ id: number }>('/patients/1');

      expect(result).toEqual({ id: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/refresh');
      expect(getAccessToken()).toBe('fresh');
    });

    it('retries with the NEW token, not the stale one', async () => {
      setAccessToken('expired');
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }))
        .mockResolvedValueOnce(jsonResponse({}));

      await api('/patients');

      const retryHeaders = fetchMock.mock.calls[2][1].headers as Record<string, string>;
      expect(retryHeaders.Authorization).toBe('Bearer fresh');
    });

    it('shares one refresh across concurrent 401s', async () => {
      // Three screens loading at once must not fire three refreshes — refresh
      // tokens rotate, so the second and third would present an already-used
      // token and the server would revoke the whole family as a replay.
      setAccessToken('expired');
      fetchMock.mockImplementation((url: string) => {
        if (url === '/api/v1/auth/refresh') return Promise.resolve(jsonResponse({ accessToken: 'fresh' }));
        const headers = (fetchMock.mock.calls.at(-1)?.[1]?.headers ?? {}) as Record<string, string>;
        if (headers.Authorization === 'Bearer expired') return Promise.resolve(jsonResponse({}, 401));
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      await Promise.all([api('/a'), api('/b'), api('/c')]);

      const refreshCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/refresh');
      expect(refreshCalls).toHaveLength(1);
    });

    it('clears the token and throws when refresh fails', async () => {
      setAccessToken('expired');
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({}, 401)); // refresh rejected

      await expect(api('/patients')).rejects.toThrow(/session has expired/i);
      expect(getAccessToken()).toBeNull();
    });

    it('notifies the app when the session is truly over', async () => {
      // Without this the user sits on a dead screen: every action fails with
      // an inline "session expired" and nothing takes them to the login page.
      const onExpired = vi.fn();
      setSessionExpiredHandler(onExpired);
      setAccessToken('expired');
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({}, 401)); // refresh rejected

      await expect(api('/patients')).rejects.toThrow();
      expect(onExpired).toHaveBeenCalledOnce();
    });

    it('does not fire the session handler when a refresh succeeds', async () => {
      const onExpired = vi.fn();
      setSessionExpiredHandler(onExpired);
      setAccessToken('expired');
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }))
        .mockResolvedValueOnce(jsonResponse({}));

      await api('/patients');
      expect(onExpired).not.toHaveBeenCalled();
    });

    it('does not fire the session handler for a non-401 error', async () => {
      const onExpired = vi.fn();
      setSessionExpiredHandler(onExpired);
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'nope' }, 403));

      await expect(api('/patients')).rejects.toThrow();
      expect(onExpired).not.toHaveBeenCalled();
    });

    it('does not attempt a refresh when skipRefresh is set', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
      await expect(api('/auth/me', { skipRefresh: true })).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('errors', () => {
    it('surfaces the problem+json detail rather than a bare status', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ title: 'Conflict', detail: 'That slot is already booked for this doctor' }, 409),
      );
      await expect(api('/appointments', { method: 'POST', body: {} })).rejects.toThrow(
        /already booked/i,
      );
    });

    it('carries the status code and field errors', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ title: 'Validation failed', detail: 'Invalid', errors: ['dob must be a date'] }, 400),
      );
      const err: unknown = await api('/patients', { method: 'POST', body: {} }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).errors).toEqual(['dob must be a date']);
    });

    it('survives a non-JSON error body', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
      await expect(api('/patients')).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('login', () => {
    it('stores the token in memory only — never in browser storage', async () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ accessToken: 'tok', user: { userId: 1, role: 'DOCTOR' } }),
      );

      await login('doctor@demo.test', 'ChangeMe123!');

      expect(getAccessToken()).toBe('tok');
      expect(setItem).not.toHaveBeenCalled();
    });

    it('propagates a failed login rather than silently returning null', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Invalid email or password' }, 401));
      await expect(login('nobody@demo.test', 'wrong')).rejects.toThrow(/invalid email or password/i);
    });
  });
});
