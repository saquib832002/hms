import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { api, ApiError } from './api';
import { Outbox, OutboxEntry } from './outbox';

/**
 * Owns the write queue and flushes it whenever there is a plausible chance of
 * connectivity: on mount, when the app comes to the foreground, and after
 * every enqueue.
 *
 * There is no network-state listener. `expo-network` would tell us the radio
 * is up, which is not the same as the API being reachable — hospital wifi
 * associates happily and then routes nowhere. Attempting the request is the
 * only honest test, and a failed attempt costs one queued retry.
 */
interface OutboxState {
  pending: number;
  parked: OutboxEntry[];
  flushing: boolean;
  enqueueVitals: (body: Record<string, unknown>, summary: string) => Promise<void>;
  enqueueDose: (doseId: number, body: Record<string, unknown>, summary: string) => Promise<void>;
  flush: () => Promise<void>;
  dismissParked: (clientRef: string) => void;
  clear: () => Promise<void>;
}

const OutboxContext = createContext<OutboxState | null>(null);

const storage = {
  getItem: (k: string) => SecureStore.getItemAsync(k),
  setItem: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  deleteItem: (k: string) => SecureStore.deleteItemAsync(k),
};

export function OutboxProvider({ children }: { children: React.ReactNode }) {
  const outbox = useRef(new Outbox(storage, () => randomUUID())).current;
  const [pending, setPending] = useState(0);
  const [parked, setParked] = useState<OutboxEntry[]>([]);
  const [flushing, setFlushing] = useState(false);

  const refreshCount = useCallback(async () => {
    setPending(await outbox.count());
  }, [outbox]);

  const flush = useCallback(async () => {
    setFlushing(true);
    try {
      const result = await outbox.flush(async (entry) => {
        await api(entry.path, {
          method: entry.method,
          // clientRef travels with the body — it is what makes the retry a
          // no-op server-side rather than a duplicate observation.
          body: { ...entry.body, clientRef: entry.clientRef },
        });
      });
      if (result.parked.length) setParked((prev) => [...prev, ...result.parked]);
    } finally {
      setFlushing(false);
      await refreshCount();
    }
  }, [outbox, refreshCount]);

  useEffect(() => {
    void refreshCount();
    void flush();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void flush();
    });
    return () => sub.remove();
  }, [flush, refreshCount]);

  const enqueueVitals = useCallback(
    async (body: Record<string, unknown>, summary: string) => {
      await outbox.enqueue({ kind: 'VITALS', path: '/vitals', method: 'POST', body, summary });
      await refreshCount();
      void flush();
    },
    [outbox, refreshCount, flush],
  );

  const enqueueDose = useCallback(
    async (doseId: number, body: Record<string, unknown>, summary: string) => {
      await outbox.enqueue({
        kind: 'DOSE',
        path: `/medications/doses/${doseId}`,
        method: 'PATCH',
        body,
        summary,
      });
      await refreshCount();
      void flush();
    },
    [outbox, refreshCount, flush],
  );

  const clear = useCallback(async () => {
    await outbox.clear();
    setParked([]);
    await refreshCount();
  }, [outbox, refreshCount]);

  const value = useMemo(
    () => ({
      pending,
      parked,
      flushing,
      enqueueVitals,
      enqueueDose,
      flush,
      dismissParked: (ref: string) => setParked((p) => p.filter((e) => e.clientRef !== ref)),
      clear,
    }),
    [pending, parked, flushing, enqueueVitals, enqueueDose, flush, clear],
  );

  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): OutboxState {
  const ctx = useContext(OutboxContext);
  if (!ctx) throw new Error('useOutbox must be used inside OutboxProvider');
  return ctx;
}

export { ApiError };
