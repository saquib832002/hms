import { isPermanent, MAX_ATTEMPTS, Outbox, OutboxEntry, OutboxStorage } from './outbox';

function fakeStorage(): OutboxStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => void store.set(k, v),
    deleteItem: async (k) => void store.delete(k),
  };
}

function ids() {
  let n = 0;
  return () => `ref-${++n}`;
}

const vitals = (patientId: number) => ({
  kind: 'VITALS' as const,
  path: '/vitals',
  method: 'POST' as const,
  body: { patientId, pulse: 72 },
  summary: `Observations for patient ${patientId}`,
});

describe('Outbox', () => {
  it('starts empty', async () => {
    expect(await new Outbox(fakeStorage(), ids()).all()).toEqual([]);
  });

  it('assigns a clientRef when an entry is queued', async () => {
    const outbox = new Outbox(fakeStorage(), ids());
    const entry = await outbox.enqueue(vitals(1));
    expect(entry.clientRef).toBe('ref-1');
    expect(entry.attempts).toBe(0);
  });

  it('survives a restart', async () => {
    // The queue is the whole point — it has to outlive the process.
    const storage = fakeStorage();
    await new Outbox(storage, ids()).enqueue(vitals(1));
    expect(await new Outbox(storage, ids()).count()).toBe(1);
  });

  it('recovers from a corrupt queue rather than wedging every future write', async () => {
    const storage = fakeStorage();
    storage.store.set('hms.outbox', 'not json{{');
    expect(await new Outbox(storage, ids()).all()).toEqual([]);
  });

  describe('flush', () => {
    it('sends everything and empties the queue', async () => {
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));
      await outbox.enqueue(vitals(2));

      const send = jest.fn().mockResolvedValue(undefined);
      const result = await outbox.flush(send);

      expect(result.sent).toBe(2);
      expect(await outbox.count()).toBe(0);
    });

    it('preserves order', async () => {
      // Two observation sets for the same patient must land in the sequence
      // they were taken, or the chart tells a different story than the shift.
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));
      await outbox.enqueue(vitals(2));
      await outbox.enqueue(vitals(3));

      const seen: number[] = [];
      await outbox.flush(async (e) => {
        seen.push(e.body.patientId as number);
      });

      expect(seen).toEqual([1, 2, 3]);
    });

    it('reuses the same clientRef on every retry', async () => {
      // This is what makes blind retrying safe: the server dedupes on it.
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));

      const refs: string[] = [];
      const send = jest.fn(async (e: OutboxEntry) => {
        refs.push(e.clientRef);
        throw new Error('offline');
      });

      await outbox.flush(send);
      await outbox.flush(send);
      await outbox.flush(send);

      expect(refs).toEqual(['ref-1', 'ref-1', 'ref-1']);
    });

    it('keeps a failed entry queued and counts the attempt', async () => {
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));

      await outbox.flush(async () => {
        throw new Error('network down');
      });

      const [entry] = await outbox.all();
      expect(entry.attempts).toBe(1);
      expect(entry.lastError).toBe('network down');
    });

    it('stops after the first network failure instead of burning the queue', async () => {
      // Every entry would fail for the same reason. Marching through all of
      // them just spends attempts on the way to MAX_ATTEMPTS.
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));
      await outbox.enqueue(vitals(2));
      await outbox.enqueue(vitals(3));

      const send = jest.fn().mockRejectedValue(new Error('offline'));
      await outbox.flush(send);

      expect(send).toHaveBeenCalledTimes(1);
      expect(await outbox.count()).toBe(3);
    });

    it('parks an entry the server permanently rejects', async () => {
      // A 400 will not become a 200 by trying again, and an entry retrying
      // forever hides the real problem behind a growing backlog.
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));

      const result = await outbox.flush(async () => {
        throw Object.assign(new Error('systolic is implausible'), { status: 400 });
      });

      expect(result.parked).toHaveLength(1);
      expect(await outbox.count()).toBe(0);
    });

    it('keeps going past a permanently-rejected entry', async () => {
      // One bad observation set must not block the rest of the round.
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));
      await outbox.enqueue(vitals(2));

      const result = await outbox.flush(async (e) => {
        if (e.body.patientId === 1) {
          throw Object.assign(new Error('bad'), { status: 400 });
        }
      });

      expect(result.parked).toHaveLength(1);
      expect(result.sent).toBe(1);
      expect(await outbox.count()).toBe(0);
    });

    it(`parks after ${MAX_ATTEMPTS} attempts`, async () => {
      const outbox = new Outbox(fakeStorage(), ids());
      await outbox.enqueue(vitals(1));

      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
        await outbox.flush(async () => {
          throw new Error('offline');
        });
      }
      expect(await outbox.count()).toBe(1);

      const result = await outbox.flush(async () => {
        throw new Error('offline');
      });
      expect(result.parked).toHaveLength(1);
      expect(await outbox.count()).toBe(0);
    });

    it('does nothing when the queue is empty', async () => {
      const send = jest.fn();
      const result = await new Outbox(fakeStorage(), ids()).flush(send);
      expect(send).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, parked: [] });
    });
  });

  it('clears everything on sign-out', async () => {
    // Queued entries hold patient ids and clinical values.
    const storage = fakeStorage();
    const outbox = new Outbox(storage, ids());
    await outbox.enqueue(vitals(1));

    await outbox.clear();

    expect(await outbox.count()).toBe(0);
    expect(storage.store.size).toBe(0);
  });
});

describe('isPermanent', () => {
  it.each([400, 401, 403, 404, 409, 422])('treats %i as permanent', (status) => {
    expect(isPermanent(Object.assign(new Error('x'), { status }))).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])('treats %i as worth retrying', (status) => {
    expect(isPermanent(Object.assign(new Error('x'), { status }))).toBe(false);
  });

  it('treats a bare network error as worth retrying', () => {
    // No status at all is what a dropped connection looks like.
    expect(isPermanent(new Error('Network request failed'))).toBe(false);
  });
});
