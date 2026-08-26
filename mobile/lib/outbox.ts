/**
 * A durable queue for writes made where there is no signal.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vitals are taken at the bedside, and bedsides are in the places hospital
 * wifi is worst — side rooms, older wings, behind lift shafts. Up to now every
 * write in this system has assumed connectivity. For a nurse doing an
 * observation round that assumption fails constantly, and an app that loses a
 * set of observations because the signal dropped is an app that gets replaced
 * by a paper chart within a week.
 *
 * So writes go into a queue first and are flushed when the network allows. The
 * nurse sees the observation saved immediately, because from their point of
 * view it is.
 *
 * THE HARD PART IS NOT THE QUEUE, IT IS THE RETRY
 * -----------------------------------------------
 * The dangerous failure is not "the request never arrived". It is "the request
 * arrived, was written, and the response was lost on the way back". The device
 * cannot tell those apart, so it retries — and without a dedupe key the patient
 * gets a second set of observations they never had, or a second dose recorded
 * against a medicine given once.
 *
 * Every entry therefore carries a `clientRef` UUID generated *before* the first
 * attempt and reused on every retry. The server treats a repeat as a no-op and
 * returns the original row. That is what makes blind retrying safe.
 *
 * Storage is SecureStore, not AsyncStorage: queued entries contain patient ids
 * and clinical values, which is PHI sitting on a device that goes home in a
 * pocket.
 */

export type OutboxKind = 'VITALS' | 'DOSE';

export interface OutboxEntry {
  /** Idempotency key. Generated once, reused for every attempt, forever. */
  clientRef: string;
  kind: OutboxKind;
  /** Path relative to /api/v1, e.g. "/vitals" or "/medications/doses/12". */
  path: string;
  method: 'POST' | 'PATCH';
  body: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  /** Human-readable, so the pending list can say what is waiting. */
  summary: string;
}

export interface OutboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const KEY = 'hms.outbox';

/**
 * Attempts after which an entry stops being retried automatically.
 *
 * A queue that retries a permanently-failing write forever hides a real
 * problem — a 400 from a validation change, say — behind an ever-growing
 * backlog. After this many tries the entry is parked and surfaced to the
 * nurse, who can decide whether to re-enter it.
 */
export const MAX_ATTEMPTS = 8;

export class Outbox {
  constructor(
    private storage: OutboxStorage,
    private newId: () => string,
  ) {}

  async all(): Promise<OutboxEntry[]> {
    const raw = await this.storage.getItem(KEY).catch(() => null);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
    } catch {
      // Corrupt queue. Losing it is bad; letting it wedge every future write
      // is worse — and the entries cannot be replayed if they cannot be read.
      return [];
    }
  }

  async enqueue(
    entry: Omit<OutboxEntry, 'clientRef' | 'queuedAt' | 'attempts'>,
  ): Promise<OutboxEntry> {
    const full: OutboxEntry = {
      ...entry,
      clientRef: this.newId(),
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    const queue = await this.all();
    await this.write([...queue, full]);
    return full;
  }

  /**
   * Attempts every queued entry in order.
   *
   * Order matters and is preserved: two observation sets for the same patient
   * must land in the sequence they were taken, or the chart tells a different
   * story than the shift did.
   *
   * `send` should resolve for success, and reject for anything else. A
   * rejection carrying `permanent: true` parks the entry rather than retrying —
   * a 400 will not become a 200 by trying again.
   */
  async flush(
    send: (entry: OutboxEntry) => Promise<void>,
  ): Promise<{ sent: number; failed: number; parked: OutboxEntry[] }> {
    const queue = await this.all();
    if (queue.length === 0) return { sent: 0, failed: 0, parked: [] };

    const remaining: OutboxEntry[] = [];
    const parked: OutboxEntry[] = [];
    let sent = 0;
    let failed = 0;
    let stop = false;

    for (const entry of queue) {
      if (stop) {
        remaining.push(entry);
        continue;
      }
      try {
        await send(entry);
        sent++;
      } catch (err) {
        const attempts = entry.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        const permanent = isPermanent(err);
        const next = { ...entry, attempts, lastError: message };

        if (permanent || attempts >= MAX_ATTEMPTS) {
          parked.push(next);
        } else {
          remaining.push(next);
          failed++;
          // Almost certainly still offline. Stop rather than burning through
          // the whole queue incrementing counters toward MAX_ATTEMPTS.
          if (!permanent) stop = true;
        }
      }
    }

    await this.write(remaining);
    return { sent, failed, parked };
  }

  async remove(clientRef: string): Promise<void> {
    await this.write((await this.all()).filter((e) => e.clientRef !== clientRef));
  }

  async clear(): Promise<void> {
    await this.storage.deleteItem(KEY);
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  private async write(entries: OutboxEntry[]): Promise<void> {
    await this.storage.setItem(KEY, JSON.stringify(entries));
  }
}

/**
 * A 4xx will not succeed on retry; a 5xx or a network failure might.
 * 408 and 429 are the exceptions — both explicitly mean "try again".
 */
export function isPermanent(err: unknown): boolean {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  if (status === undefined || Number.isNaN(status)) return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}
