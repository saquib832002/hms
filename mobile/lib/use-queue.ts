import { useCallback, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { api } from './api';
import type { DoctorQueue } from './types';

const CACHE_KEY = 'hms.queue.cache';

export interface QueueState {
  queue: DoctorQueue | null;
  loading: boolean;
  error: string | null;
  /** When the data on screen was actually fetched from the server. */
  fetchedAt: Date | null;
  /** True when showing cached data because the network is unavailable. */
  stale: boolean;
  refresh: () => Promise<void>;
}

/**
 * The doctor's queue, tolerant of hospital wifi.
 *
 * Coverage inside a hospital is genuinely bad — lifts, stairwells, older wings
 * with thick walls. A doctor opening this between wards and getting a spinner
 * and an error has an app that is useless exactly where they need it. So the
 * last successful queue is cached and shown immediately, clearly marked with
 * its age, while a fresh fetch is attempted behind it.
 *
 * The cache lives in SecureStore rather than AsyncStorage. It holds patient
 * names, ages and an allergy flag — that is PHI sitting on a device that gets
 * left on desks and taken home, and it belongs behind the Keychain like the
 * refresh token does.
 *
 * It is wiped on sign-out along with the tokens.
 *
 * WHY IT TAKES `enabled`
 * ----------------------
 * `/me/queue` is a doctor endpoint. Expo Router opens the tab group on the
 * queue screen for *every* role, and that screen redirects anyone who is not a
 * doctor — but a redirect is a return value and hooks run first. So a
 * receptionist, a pharmacist or an administrator signing in fired one
 * `GET /me/queue`, got a 403, and left a denied clinical access in that
 * hospital's audit log before the screen they actually wanted had rendered.
 *
 * The API refusing was correct. The app asking was not. A denial row is
 * supposed to mean somebody reached for data they should not have; it is worth
 * much less once logging in is enough to produce one.
 *
 * This cannot be solved by moving the `<Redirect>` earlier — no position in the
 * component is earlier than its own hooks. The fetch has to know it should not
 * happen, which is what this flag is.
 */
export function useDoctorQueue(enabled = true): QueueState {
  const [queue, setQueue] = useState<DoctorQueue | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);

  /*
   * Read through a ref, not the closure. `refresh` is handed to `useLiveData`,
   * which polls every 15s and on every focus — capturing `enabled` in the
   * callback would let a stale `true` keep firing the request after the role
   * that may make it has gone.
   */
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabledRef.current) return;
    setError(null);
    try {
      const fresh = await api<DoctorQueue>('/me/queue');
      if (!mounted.current) return;
      setQueue(fresh);
      setFetchedAt(new Date());
      setStale(false);
      await SecureStore.setItemAsync(
        CACHE_KEY,
        JSON.stringify({ queue: fresh, at: new Date().toISOString() }),
      ).catch(() => {});
    } catch (err) {
      if (!mounted.current) return;
      // Fall back to the cache rather than showing nothing. An out-of-date
      // queue with a visible timestamp beats an empty screen — the doctor can
      // judge whether four-minute-old data is good enough; a spinner tells
      // them nothing.
      const cached = await SecureStore.getItemAsync(CACHE_KEY).catch(() => null);
      if (cached && mounted.current) {
        try {
          const parsed = JSON.parse(cached) as { queue: DoctorQueue; at: string };
          setQueue(parsed.queue);
          setFetchedAt(new Date(parsed.at));
          setStale(true);
        } catch {
          setError(err instanceof Error ? err.message : 'Could not load your queue');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Could not load your queue');
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Depends on `enabled` as well as `refresh`, so the fetch starts the moment
  // the session resolves to a doctor — the first render has no user yet.
  useEffect(() => {
    if (enabled) void refresh();
  }, [refresh, enabled]);

  return { queue, loading, error, fetchedAt, stale, refresh };
}

export async function clearQueueCache(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHE_KEY).catch(() => {});
}
