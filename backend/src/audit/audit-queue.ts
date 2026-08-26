/**
 * The retry and overflow policy for audit writes.
 *
 * Pure, so the interesting decisions can be tested without a database or a
 * running Nest app. `AuditService` owns the wiring; this owns the rules.
 *
 * WHAT PROBLEM THIS ACTUALLY SOLVES, AND WHAT IT DOES NOT
 * -------------------------------------------------------
 * `record()` was a floating promise. Three real failure modes followed from
 * that, and they are worth separating because only two of them are fixable
 * here:
 *
 *  1. A transient insert failure — a connection blip, a momentarily exhausted
 *     pool — lost the row silently. FIXED: bounded retry with backoff.
 *
 *  2. A deploy or restart discarded whatever was in flight. FIXED: the queue is
 *     drained on shutdown, and Nest's shutdown hooks are already enabled.
 *
 *  3. The process is SIGKILLed, or the machine loses power. NOT FIXED, and no
 *     in-process queue can fix it. The honest bound is "up to one drain
 *     interval of entries", which is milliseconds. Fixing it properly means
 *     writing to disk *before* acknowledging the request — a write-ahead log —
 *     which doubles the I/O on every request to close a window that, on a
 *     single machine, closes anyway because the database died with the process.
 *
 * So this is meaningfully more durable, not durable. The difference is stated
 * rather than blurred, because "we added a queue" is exactly the kind of change
 * that gets remembered as "audit writes are safe now".
 */

import { AuditOutcome, UserRole } from '@prisma/client';

/**
 * How many entries may wait in memory.
 *
 * Bounded on purpose. An unbounded queue turns a database outage into a memory
 * leak, and the process dies holding every row it was trying to save — the
 * worst possible outcome for the thing being protected.
 *
 * Overflow does not drop. It spills to disk. See `overflowAction`.
 */
export const MAX_QUEUE = 1_000;

/**
 * Attempts per entry, including the first.
 *
 * Four attempts spread over roughly a second. Long enough to ride out a blip,
 * short enough that a genuinely broken database does not build a queue of
 * retrying writes behind it.
 */
export const MAX_ATTEMPTS = 4;

/**
 * Exponential, capped.
 *
 * Capped because the point is to survive a blip, not to wait out an outage —
 * an outage should reach the spill file quickly, where the entries are safe and
 * visible, rather than sitting in RAM looking healthy.
 */
export function backoffMs(attempt: number): number {
  if (attempt < 1) return 0;
  return Math.min(50 * 2 ** (attempt - 1), 800);
}

/**
 * What to do with an entry that will not go into the database.
 *
 * Never `drop`. That option is deliberately absent from the return type: a
 * denied request is a security event, and an attacker who can make audit writes
 * fail must not thereby be able to make them disappear. Losing the row is worse
 * than any cost of keeping it.
 */
export type OverflowAction = 'spill';

export function overflowAction(queueLength: number): OverflowAction | 'enqueue' {
  return queueLength >= MAX_QUEUE ? 'spill' : 'enqueue';
}

/**
 * Whether another attempt is worth making.
 *
 * Everything is retried, which is deliberate. Classifying Prisma error codes
 * into "transient" and "permanent" reads as rigour and is a liability here: get
 * the classification wrong in the permanent direction and the row is discarded
 * for a fault that would have cleared on the next attempt. The cost of being
 * wrong the other way is four attempts and under a second, on a path that only
 * runs when something is already broken.
 *
 * Retrying an insert that may have partly succeeded can duplicate a row. For an
 * audit trail that is the right trade — a duplicate is visible and dismissable
 * (entries carry `requestId`), a missing row is neither.
 */
export function shouldRetry(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}

/** The shape written to the spill file and read back by the replay tool. */
export interface SpilledEntry {
  tenantId: number | null;
  userId: number | null;
  actorEmail: string | null;
  actorRole: UserRole | null;
  action: string;
  method?: string;
  path?: string;
  targetType: string | null;
  targetId: number | null;
  outcome: AuditOutcome;
  statusCode?: number;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  /** When the event happened, not when it was finally written. */
  occurredAt: string;
  /** Why it ended up here, for whoever reads the file at 3am. */
  spillReason: string;
}

/**
 * One JSON object per line, so the file survives a partial write.
 *
 * A single JSON array would be corrupt the moment the process died mid-append —
 * which is exactly the moment this file matters. JSONL loses only the last
 * line, and the replay tool reports it rather than refusing the whole file.
 */
export function toSpillLine(entry: SpilledEntry): string {
  return JSON.stringify(entry) + '\n';
}

export interface ParsedSpill {
  entries: SpilledEntry[];
  /** Lines that would not parse. Surfaced, never silently skipped. */
  corrupt: number;
}

export function parseSpill(contents: string): ParsedSpill {
  const entries: SpilledEntry[] = [];
  let corrupt = 0;

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as SpilledEntry;
      // A line that parses as JSON but is not an audit entry would insert a
      // row with a null action and quietly corrupt the trail.
      if (typeof parsed?.action === 'string' && typeof parsed?.outcome === 'string') {
        entries.push(parsed);
      } else {
        corrupt += 1;
      }
    } catch {
      corrupt += 1;
    }
  }

  return { entries, corrupt };
}
