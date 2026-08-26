'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a screen current without the user pressing anything.
 *
 * WHY POLLING RATHER THAN SSE OR WEBSOCKETS
 * -----------------------------------------
 * The obvious "live" answer is server-sent events, and it was the first thing
 * I reached for. It does not survive contact with this auth model: EventSource
 * cannot set an Authorization header, so the access token would have to travel
 * in the query string — and the query string is exactly what the audit
 * interceptor records in `path`. That would write a live credential into the
 * audit table on every connection, in the one table that is deliberately
 * append-only and widely read by admins.
 *
 * Cookie-authenticated SSE would work, but the access token is deliberately
 * not a cookie (see lib/api.ts), so that means a second auth path existing
 * solely for one transport.
 *
 * Polling every 15 seconds costs one indexed query per doctor per 15s. For a
 * hospital-sized staff list that is nothing, and it needs no new infrastructure
 * and no second way of proving who you are. Revisit if a screen ever needs
 * sub-second freshness — vitals monitoring would.
 *
 * Two details that matter more than the interval:
 *  - polling stops while the tab is hidden. A screen left open overnight on a
 *    ward terminal should not spend the night querying.
 *  - it refreshes immediately when the tab becomes visible again, so returning
 *    to a screen never shows stale data while waiting for the next tick.
 */
export function useAutoRefresh(
  refresh: () => void | Promise<void>,
  { intervalMs = 15_000, enabled = true }: { intervalMs?: number; enabled?: boolean } = {},
) {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Held in a ref so a new callback identity each render does not restart the
  // interval — otherwise a screen that re-renders often never actually ticks.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const run = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshRef.current();
      setLastUpdated(new Date());
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void run(), intervalMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void run();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [enabled, intervalMs, run]);

  return { lastUpdated, refreshing, refreshNow: run, setLastUpdated };
}

/** "just now" / "2 min ago" — staff should always know how old the data is. */
export function relativeAge(from: Date | null, now: Date = new Date()): string {
  if (!from) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
