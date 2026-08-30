/**
 * Shaping for the admin finance and workload reports.
 *
 * Pure, and separated from the service for the same reason `aging.ts` is: the
 * bugs in a report are arithmetic and boundary bugs — a month that quietly
 * disappears because nobody paid in it, a total that drifts by a penny over a
 * thousand rows — and none of them are visible in a rendered chart. A number on
 * a dashboard is believed precisely because nobody can check it by eye.
 */

import { fromMinor, sumMinor, toMinor, toMoneyString } from '../billing/money';

/** A payment reduced to what a report needs. No payer, no invoice, no patient. */
export interface ReportablePayment {
  amountMinor: number;
  /** `YYYY-MM` in the hospital's own timezone, not the server's. */
  monthKey: string;
  method: string;
  receivedAt: Date;
}

export interface MonthTotal {
  month: string;
  label: string;
  collected: string;
  payments: number;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `2026-08` → `Aug 2026`. Formatted server-side so every client agrees. */
export function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/**
 * Collected revenue per month, over a fixed window of month keys.
 *
 * The window is supplied rather than inferred, so a month in which nothing was
 * collected still appears — as a zero. Deriving the axis from the data is the
 * standard way a trend chart ends up flattering: the bad months are simply not
 * drawn, and the line only ever connects the good ones.
 */
export function monthlyTotals(payments: ReportablePayment[], months: string[]): MonthTotal[] {
  const totals = new Map<string, { minor: number[]; count: number }>(
    months.map((m) => [m, { minor: [], count: 0 }]),
  );

  for (const payment of payments) {
    const entry = totals.get(payment.monthKey);
    // Payments outside the window are ignored rather than folded into the
    // nearest month, which would make the oldest bar silently cumulative.
    if (!entry) continue;
    entry.minor.push(payment.amountMinor);
    entry.count++;
  }

  return months.map((month) => {
    const entry = totals.get(month)!;
    return {
      month,
      label: monthLabel(month),
      collected: fromMinor(sumMinor(entry.minor)),
      payments: entry.count,
    };
  });
}

export interface MethodSplit {
  method: string;
  today: { amount: string; count: number };
  month: { amount: string; count: number };
}

/**
 * How the money arrived, for today and for the current month.
 *
 * The end-of-day reconciliation question: the cash drawer should hold the cash
 * figure and nothing else. Every method that has ever been used appears, so a
 * method that took nothing today shows a zero rather than being absent — "no
 * card payments today" and "the card row is missing" look identical otherwise.
 */
export function methodSplit(
  payments: ReportablePayment[],
  todayStart: Date,
  monthStart: Date,
  methods: string[],
): MethodSplit[] {
  const rows = methods.map((method) => {
    const forMethod = payments.filter((p) => p.method === method);
    const today = forMethod.filter((p) => p.receivedAt >= todayStart);
    const month = forMethod.filter((p) => p.receivedAt >= monthStart);
    return {
      method,
      today: {
        amount: fromMinor(sumMinor(today.map((p) => p.amountMinor))),
        count: today.length,
      },
      month: {
        amount: fromMinor(sumMinor(month.map((p) => p.amountMinor))),
        count: month.length,
      },
    };
  });

  // Largest month first — the useful ordering when scanning for what changed.
  return rows.sort((a, b) => toMinor(b.month.amount) - toMinor(a.month.amount));
}

/** Total collected from payments received at or after `since`. */
export function collectedSince(payments: ReportablePayment[], since: Date): string {
  return fromMinor(sumMinor(payments.filter((p) => p.receivedAt >= since).map((p) => p.amountMinor)));
}

export interface DoctorActivity {
  doctorId: number;
  status: string;
  scheduledAt: Date;
}

export interface WorkloadCounts {
  booked: number;
  completed: number;
  noShow: number;
}

export function countWorkload(rows: DoctorActivity[]): WorkloadCounts {
  return {
    booked: rows.length,
    completed: rows.filter((r) => r.status === 'COMPLETED').length,
    noShow: rows.filter((r) => r.status === 'NO_SHOW').length,
  };
}

export interface BilledInvoice {
  doctorId: number | null;
  totalMinor: number;
  paidMinor: number;
}

/**
 * Billed and collected per doctor.
 *
 * `billed` counts what was charged; `collected` counts what has actually been
 * paid against those charges. Reporting only one of them is how a clinic
 * mistakes invoices raised for money in the bank — which is precisely the
 * confusion that made "payment happens at check-in" worth building.
 */
export function revenueByDoctor(invoices: BilledInvoice[]): Map<number, { billed: string; collected: string }> {
  const grouped = new Map<number, { billed: number[]; collected: number[] }>();

  for (const invoice of invoices) {
    if (invoice.doctorId === null) continue;
    const entry = grouped.get(invoice.doctorId) ?? { billed: [], collected: [] };
    entry.billed.push(invoice.totalMinor);
    entry.collected.push(invoice.paidMinor);
    grouped.set(invoice.doctorId, entry);
  }

  return new Map(
    [...grouped.entries()].map(([doctorId, v]) => [
      doctorId,
      {
        billed: fromMinor(sumMinor(v.billed)),
        collected: fromMinor(sumMinor(v.collected)),
      },
    ]),
  );
}

/** Prisma `Decimal | null` to minor units, with null meaning zero. */
export function minorOf(value: unknown): number {
  return toMinor(toMoneyString(value));
}

/* ─────────────────────── the consultation ledger ─────────────────────── */

/**
 * The row an owner sees when they click "3 seen".
 *
 * THE LINE THIS DRAWS
 * -------------------
 * Attendance and money, never clinical content. Who came, when, whether they
 * turned up, what they were charged and whether they paid — all of which
 * reception and billing already see at the desk. Not what was wrong with them.
 *
 * An appointment carries `reason`, typed by reception at booking: "chest pain",
 * "follow-up for diabetes". It is one field away from everything else here and
 * it is a clinical fact, so it is excluded by name and `reports.spec.ts`
 * asserts it never appears.
 *
 * `prescriptionIssued` is a boolean and must stay one. Whether a doctor
 * prescribed anything is an operational fact about the consultation; *what*
 * they prescribed names a condition — an antiretroviral or an antipsychotic on
 * an owner's screen tells them something the patient told their doctor, not
 * their employer.
 *
 * Built as an explicit allowlist rather than by spreading a Prisma row. Spread
 * shapes leak the next field somebody adds to the model, silently, and the
 * whole point of this type is what it refuses to carry.
 */
export interface LedgerRow {
  id: number;
  scheduledAt: Date;
  status: string;
  patient: { id: number; fullName: string };
  doctor: { id: number; fullName: string };
  invoice: {
    id: number;
    total: string;
    paid: string;
    outstanding: string;
    settled: boolean;
  } | null;
  prescriptionIssued: boolean;
}

export interface LedgerSource {
  id: number;
  scheduledAt: Date;
  status: string;
  patient: { id: number; fullName: string };
  doctor: { id: number; fullName: string };
  invoice: { id: number; totalAmount: unknown; amountPaid: unknown } | null;
  prescription: { id: number } | null;
}

export function toLedgerRow(row: LedgerSource): LedgerRow {
  const invoice = row.invoice
    ? (() => {
        const total = minorOf(row.invoice.totalAmount);
        const paid = minorOf(row.invoice.amountPaid);
        return {
          id: row.invoice.id,
          total: fromMinor(total),
          paid: fromMinor(paid),
          outstanding: fromMinor(total - paid),
          // Settled is computed here rather than read from the invoice status,
          // so "paid" on this screen always means the arithmetic agrees.
          settled: total - paid <= 0,
        };
      })()
    : null;

  return {
    id: row.id,
    scheduledAt: row.scheduledAt,
    status: row.status,
    patient: { id: row.patient.id, fullName: row.patient.fullName },
    doctor: { id: row.doctor.id, fullName: row.doctor.fullName },
    invoice,
    prescriptionIssued: row.prescription !== null,
  };
}

/* ─────────────────────── per-day staff activity ─────────────────────── */

/**
 * The audit actions that describe a day's work, grouped by the role that does
 * them.
 *
 * Counted from the audit log because that is the only table recording *who*
 * performed an action. A booking row knows which doctor it is for; only the
 * audit trail knows which receptionist made it.
 *
 * Reads are excluded on purpose. `PATIENT_SEARCH` and `QUEUE_VIEW` measure how
 * much someone looked at a screen, not what they did, and a productivity
 * number built from them rewards leaving a list open. Only actions that changed
 * something are counted.
 */
export const ACTIVITY_ACTIONS = {
  RECEPTIONIST: {
    registrations: ['PATIENT_CREATE'],
    bookings: ['APPOINTMENT_CREATE'],
    updates: ['APPOINTMENT_UPDATE', 'APPOINTMENT_STATUS_CHANGE'],
    invoicesRaised: ['APPOINTMENT_INVOICE_RAISED'],
  },
  PHARMACIST: {
    dispensed: ['PRESCRIPTION_DISPENSE'],
    prepared: ['DISPENSE_PREPARE'],
    stockReceived: ['STOCK_RECEIVE'],
  },
  NURSE: {
    vitals: ['VITALS_RECORD'],
    doses: ['MEDICATION_ADMINISTER'],
    admissions: ['PATIENT_ADMIT', 'PATIENT_TRANSFER', 'PATIENT_DISCHARGE'],
  },
} as const;

export interface ActorAction {
  userId: number | null;
  action: string;
  outcome: string;
}

/**
 * Counts of named actions per actor.
 *
 * WHY REFUSALS ARE NOT COUNTED HERE
 * ---------------------------------
 * An earlier version carried a `denied` figure on every row. It was removed:
 * beside a person's registrations and bookings, a refusal count reads as a
 * performance metric, and it is not one. Most denials are a stale tab, a
 * bookmarked URL, or a role that changed this morning — the app's own plumbing,
 * not a judgement about the person.
 *
 * The signal itself is not lost, only moved to where it means something. The
 * dashboard carries denied requests across the whole hospital in the last 24
 * hours, which is where a spike is worth investigating, and the audit log has
 * every one of them with its reason.
 *
 * Only successful actions are counted, so a row says what somebody *did*.
 */
export function countActions(
  rows: ActorAction[],
  buckets: Readonly<Record<string, readonly string[]>>,
): Map<number, Record<string, number>> {
  const out = new Map<number, Record<string, number>>();

  for (const row of rows) {
    if (row.userId === null) continue;
    // A refused attempt changed nothing, so it belongs in no count of work.
    if (row.outcome === 'FAILURE') continue;

    let entry = out.get(row.userId);
    if (!entry) {
      entry = {};
      for (const key of Object.keys(buckets)) entry[key] = 0;
      out.set(row.userId, entry);
    }

    for (const [key, actions] of Object.entries(buckets)) {
      if (actions.includes(row.action)) entry[key]++;
    }
  }

  return out;
}

export interface CollectedPayment {
  receivedById: number;
  amountMinor: number;
  method: string;
}

/**
 * What each person took, and how.
 *
 * From `Payment` rows rather than the audit log: this is money, and it should
 * be counted from the thing that records money. The audit trail says a payment
 * was recorded; the payment row says how much.
 */
export function collectionsByStaff(
  payments: CollectedPayment[],
): Map<number, { total: string; count: number; methods: { method: string; amount: string }[] }> {
  const grouped = new Map<number, CollectedPayment[]>();
  for (const p of payments) {
    grouped.set(p.receivedById, [...(grouped.get(p.receivedById) ?? []), p]);
  }

  return new Map(
    [...grouped.entries()].map(([userId, rows]) => {
      const byMethod = new Map<string, number[]>();
      for (const r of rows) byMethod.set(r.method, [...(byMethod.get(r.method) ?? []), r.amountMinor]);

      return [
        userId,
        {
          total: fromMinor(sumMinor(rows.map((r) => r.amountMinor))),
          count: rows.length,
          methods: [...byMethod.entries()]
            .map(([method, amounts]) => ({ method, amount: fromMinor(sumMinor(amounts)) }))
            .sort((a, b) => toMinor(b.amount) - toMinor(a.amount)),
        },
      ];
    }),
  );
}
