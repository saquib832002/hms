import { parseFrequency } from '../medications/dose-frequency';

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
 * Same discipline as the frequency parser: a suggestion the pharmacist can
 * accept, never a number the system commits to on its own. Both the frequency
 * and the duration have to be confidently readable, otherwise this returns
 * null and the pharmacist types the quantity.
 *
 * Getting this wrong means sending a patient home with the wrong number of
 * days of medicine, which is exactly the kind of quiet error that is worth
 * refusing to guess at.
 */
export function suggestQuantity(frequency: string, duration: string): number | null {
  const schedule = parseFrequency(frequency);
  if (!schedule) return null;

  const days = parseDurationDays(duration);
  if (days === null) return null;

  return schedule.timesPerDay * days;
}

/** Days in a duration string, or null when it is not unambiguous. */
export function parseDurationDays(duration: string): number | null {
  const text = duration.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;

  // "as directed", "ongoing", "until review" — a course with no end has no
  // computable quantity.
  if (/ongoing|as directed|until review|indefinite|continuous|prn|as needed/.test(text)) {
    return null;
  }

  const match = /^(\d+)\s*(day|days|week|weeks|month|months)\b/.exec(text);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0 || value > 365) return null;

  switch (match[2]) {
    case 'day':
    case 'days':
      return value;
    case 'week':
    case 'weeks':
      return value * 7;
    case 'month':
    case 'months':
      // 30 days, stated rather than assumed. Calendar months vary, and for
      // counting tablets a fixed 30 is the convention.
      return value * 30;
    default:
      return null;
  }
}

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
