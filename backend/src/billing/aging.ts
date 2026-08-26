/**
 * Invoice aging.
 *
 * The report a finance office actually runs: how much is owed, and how long it
 * has been owed for. Buckets rather than a raw list, because "£9,140 is more
 * than 90 days overdue" prompts an action and a list of 400 invoices does not.
 *
 * Pure functions so the boundaries can be pinned down without a database —
 * off-by-one on a bucket edge is the classic bug here, and it is invisible in
 * a UI.
 */

import { fromMinor, sumMinor } from './money';

export type AgingBucket = 'current' | 'd1to30' | 'd31to60' | 'd61to90' | 'over90';

export const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Not yet due',
  d1to30: '1–30 days',
  d31to60: '31–60 days',
  d61to90: '61–90 days',
  over90: 'Over 90 days',
};

export interface AgeableInvoice {
  id: number;
  dueDate: Date | null;
  /** Still owed on this invoice, in minor units. */
  outstandingMinor: number;
}

/**
 * Whole days an invoice is past its due date. Zero when not yet due.
 *
 * Deliberately day-granular and floor-based: an invoice due at 09:00 today is
 * not "0.4 days overdue", it is due today. Aging that flickers with the clock
 * is aging nobody trusts.
 */
export function daysOverdue(dueDate: Date | null, now: Date = new Date()): number {
  // No due date means no aging. Treating it as immediately overdue would put
  // every invoice awaiting terms into the 90-day bucket.
  if (!dueDate) return 0;

  const dueDay = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diff = Math.floor((today - dueDay) / 86_400_000);
  return diff > 0 ? diff : 0;
}

export function bucketFor(dueDate: Date | null, now: Date = new Date()): AgingBucket {
  const days = daysOverdue(dueDate, now);
  if (days === 0) return 'current';
  if (days <= 30) return 'd1to30';
  if (days <= 60) return 'd31to60';
  if (days <= 90) return 'd61to90';
  return 'over90';
}

export interface AgingReport {
  buckets: Record<AgingBucket, { label: string; count: number; amount: string }>;
  totalOutstanding: string;
  /** Anything past due, i.e. everything except `current`. */
  totalOverdue: string;
}

export function buildAgingReport(
  invoices: AgeableInvoice[],
  now: Date = new Date(),
): AgingReport {
  const order: AgingBucket[] = ['current', 'd1to30', 'd31to60', 'd61to90', 'over90'];
  const grouped = new Map<AgingBucket, AgeableInvoice[]>(order.map((b) => [b, []]));

  // Only unsettled invoices age. A paid invoice has nothing outstanding, and
  // including it would inflate every bucket with zeroes.
  for (const invoice of invoices.filter((i) => i.outstandingMinor > 0)) {
    grouped.get(bucketFor(invoice.dueDate, now))!.push(invoice);
  }

  const buckets = {} as AgingReport['buckets'];
  for (const bucket of order) {
    const rows = grouped.get(bucket)!;
    buckets[bucket] = {
      label: BUCKET_LABELS[bucket],
      count: rows.length,
      amount: fromMinor(sumMinor(rows.map((r) => r.outstandingMinor))),
    };
  }

  const all = invoices.filter((i) => i.outstandingMinor > 0);
  const overdue = all.filter((i) => bucketFor(i.dueDate, now) !== 'current');

  return {
    buckets,
    totalOutstanding: fromMinor(sumMinor(all.map((i) => i.outstandingMinor))),
    totalOverdue: fromMinor(sumMinor(overdue.map((i) => i.outstandingMinor))),
  };
}
