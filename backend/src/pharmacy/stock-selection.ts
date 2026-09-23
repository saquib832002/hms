import { courseDays, estimateQuantity } from './course-quantity';

/**
 * Choosing which stock to hand over, and how much.
 *
 * Pure functions, so the rules that matter can be tested without a database.
 */

export interface Batch {
  id: number;
  batchNumber: string;
  expiresAt: Date;
  quantity: number;
}

export interface Allocation {
  batchId: number;
  batchNumber: string;
  quantity: number;
  expiresAt: Date;
}

export class InsufficientStockError extends Error {
  constructor(
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`Only ${available} in date, ${requested} requested`);
    this.name = 'InsufficientStockError';
  }
}

/**
 * First-expired-first-out.
 *
 * Not FIFO. Stock does not necessarily arrive in expiry order — a delivery
 * received today can expire before one received last month — so dispensing by
 * arrival date quietly grows a pile of stock that expires on the shelf.
 * Handing out the shortest-dated in-date batch first is what pharmacies
 * actually do, and it is the difference between rotating stock and writing it
 * off.
 *
 * Expired batches are excluded outright rather than deprioritised. Expired
 * medicine is not "last resort" stock; it is not stock.
 */
export function allocateFefo(batches: Batch[], requested: number, now: Date = new Date()): Allocation[] {
  if (requested <= 0) throw new Error('Quantity must be greater than zero');

  const usable = batches
    .filter((b) => b.quantity > 0 && b.expiresAt > now)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());

  const available = usable.reduce((sum, b) => sum + b.quantity, 0);
  if (available < requested) throw new InsufficientStockError(available, requested);

  const allocations: Allocation[] = [];
  let remaining = requested;

  for (const batch of usable) {
    if (remaining === 0) break;
    const take = Math.min(batch.quantity, remaining);
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      quantity: take,
      expiresAt: batch.expiresAt,
    });
    remaining -= take;
  }

  return allocations;
}

/** Units still in date, ignoring anything already expired. */
export function inDateQuantity(batches: Batch[], now: Date = new Date()): number {
  return batches.filter((b) => b.expiresAt > now).reduce((sum, b) => sum + b.quantity, 0);
}

/**
 * How many units a course needs — when that can be worked out honestly.
 *
 * A suggestion the pharmacist can accept, never a number the system commits to
 * on its own. The dosage, frequency and duration all have to be confidently
 * readable, otherwise this returns null and the pharmacist types the quantity.
 *
 * **The dosage is part of the sum, and for six phases it was not.** This used
 * to be `timesPerDay × days`, which is wrong by a factor of the dose size:
 * "2 tablets, three times daily, 5 days" came out as 15 against a real 30. The
 * arithmetic now lives in `course-quantity.ts`, shared byte-for-byte with both
 * prescribing screens so the counter and the prescription sheet cannot show
 * different numbers for the same line.
 */
export function suggestQuantity(
  dosage: string,
  frequency: string,
  duration: string,
): number | null {
  return estimateQuantity(dosage, frequency, duration).units;
}

/**
 * Days in a duration string, or null when it is not unambiguous.
 *
 * Re-exported from the shared module rather than reimplemented — this was a
 * second copy of the same rules and the two had already started to drift.
 */
export const parseDurationDays = courseDays;

/** Batches expiring within `days`, soonest first — the stock to use or lose. */
export function expiringSoon<T extends { expiresAt: Date }>(
  batches: T[],
  days: number,
  now: Date = new Date(),
): T[] {
  const cutoff = new Date(now.getTime() + days * 24 * 3600_000);
  return batches
    .filter((b) => b.expiresAt > now && b.expiresAt <= cutoff)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}
