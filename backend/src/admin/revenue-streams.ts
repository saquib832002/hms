/**
 * What each line of business billed and collected, and what they add up to.
 *
 * A hospital here may run up to three businesses that take money: the clinic,
 * the pharmacy and the laboratory. `Invoice.kind` says which, and whether they
 * are one set of books or three is `Tenant.pharmacyBilling` and
 * `Tenant.labBilling` — a commercial fact, not an accounting one.
 *
 * WHY THIS IS A MODULE AND NOT TWO BLOCKS OF SERVICE CODE
 * ------------------------------------------------------
 * `dashboard()` and `financeReport()` both answer "what did we take". They are
 * read by the same person, often in the same minute, and they already disagreed
 * once in exactly this way: the finance report split takings by kind and the
 * dashboard did not, so the dashboard's "collected" silently included the shop's
 * counter trade. The figure looked plausible, moved when takings moved, and was
 * not what it was labelled as.
 *
 * Two screens disagreeing about one day is worse than either being wrong alone,
 * because it makes both unusable and the person who has to explain it is a
 * finance clerk who did nothing wrong. So the arithmetic lives here once, both
 * callers use it, and `revenue-streams.spec.ts` fails if either grows its own.
 * Same reasoning as `resolveAuditTarget`, `resolveTreatingScope` and
 * `course-quantity.ts`.
 *
 * It imports only `money.ts`. Pure functions over rows the caller fetched, so a
 * test can hand it figures and assert on behaviour rather than on text — which
 * is what four guards in this repo turned out not to be doing.
 */
import { fromMinor, sumMinor, toMinor, toMoneyString } from '../billing/money';

/** The three businesses, named after `InvoiceKind` rather than after a plan. */
export const REVENUE_STREAMS = ['HOSPITAL', 'PHARMACY', 'LAB'] as const;
export type RevenueStream = (typeof REVENUE_STREAMS)[number];

/**
 * A half-open instant range, `[start, end)`, resolved in the hospital's
 * timezone by `resolvePeriod`.
 *
 * ONE PERIOD, CHOSEN BY THE READER — IT WAS THREE FIXED WINDOWS
 * ------------------------------------------------------------
 * This first reported `today`, `sevenDays` and `thisMonth` side by side, which
 * answered three questions nobody had asked in favour of the one they had.
 * Reported by the product owner: *"instead of this month, could the customer
 * select a date range, or a month and year"* — a clinic reconciling August does
 * not want August to be unreachable because the card only knows about now.
 *
 * So the three became presets of a single choice. Nothing was lost: today, a
 * rolling seven days and this month are still one tap each, and they resolve
 * through the same `?from=&to=` the arbitrary case uses, so there is one code
 * path rather than a fast one for the common periods and a separate one for the
 * rest.
 */
export interface WindowRange {
  start: Date;
  end: Date;
}

/**
 * An invoice, reduced to what money reporting needs.
 *
 * `taxMinor` is summed from the invoice's *items* by the caller, because that is
 * where `taxAmount` lives — there is no tax column on the invoice, and inventing
 * one here by taking a percentage of the total would be a different number from
 * the one printed on the bill.
 */
export interface StreamInvoice {
  kind: string;
  issuedAt: Date;
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  taxMinor: number;
  isSettled: boolean;
}

/** A payment or a refund. Both are an amount, an instant and a stream. */
export interface StreamMovement {
  kind: string;
  amountMinor: number;
  at: Date;
}

/** Everything about one stream in one window. Strings, because money is never a float. */
export interface WindowFigures {
  billed: string;
  tax: string;
  collected: string;
  refunded: string;
  /** `collected − refunded`. Derived, never stored, never replacing the gross pair. */
  net: string;
}

export interface StreamRevenue {
  stream: RevenueStream | 'ALL';
  /** Billed, collected, refunded, net and tax **inside the chosen period**. */
  period: WindowFigures;
  /**
   * Of what this stream billed **in the period**, how much is still unpaid.
   *
   * WHY THIS IS WINDOWED AND THE FIGURE BELOW IS NOT
   * ------------------------------------------------
   * Reported by the product owner: with *Today* selected, the unpaid figure was
   * showing a balance from months earlier, and *"the customer may get confused,
   * where is it coming from"*. Exactly right — every other number on that row
   * moved with the period and this one did not, so the row read as one period's
   * figures and was not.
   *
   * It is the honest reading of the column it sits in: of what we charged in
   * this period, this much has not arrived. A period with nothing billed in it
   * shows nothing owed, which is correct rather than empty.
   */
  outstandingInPeriod: string;
  /** How many invoices *from the period* that figure is spread across. */
  openInvoicesInPeriod: number;
  /**
   * Everything this stream is owed, whenever it was billed.
   *
   * Kept, and kept **separate and labelled**, because it is the figure that
   * decides whether to chase anybody: an unpaid sale from last week is still
   * money owed today, and a clinic looking at *Today* must not conclude it is
   * square. `/pharmacy/dashboard` reports its outstanding the same
   * un-windowed way, so the two screens still agree.
   *
   * The mistake was never computing it — it was putting it in a row of
   * period figures with no label saying it was the exception.
   */
  outstandingAllTime: string;
  openInvoicesAllTime: number;
  /**
   * True where this stream's unpaid balances are a debtor to chase, false where
   * they are an unreconciled till.
   *
   * The pharmacy is the false one and it is not a quibble. A counter sale is
   * paid at the counter or it does not happen, it frequently has no patient to
   * chase, and it is deliberately absent from `AGEABLE_INVOICE_KINDS`. A screen
   * that totals all three under one "owed" heading invites somebody to chase a
   * walk-in who left the shop with their paracetamol a fortnight ago.
   */
  chaseable: boolean;
}

const ZERO: WindowFigures = {
  billed: '0.00',
  tax: '0.00',
  collected: '0.00',
  refunded: '0.00',
  net: '0.00',
};

/** `[start, end)` — the half-open convention every range in this project uses. */
function within(at: Date, range: WindowRange): boolean {
  return at >= range.start && at < range.end;
}

/**
 * Streams whose unpaid balances are somebody to chase.
 *
 * Deliberately the same pair as `AGEABLE_INVOICE_KINDS` in
 * `billing/invoice-response.ts`, and `revenue-streams.spec.ts` compares the two
 * so they cannot drift. A laboratory charge is raised against a named patient
 * when a doctor requests a test and goes unpaid exactly as a consultation does;
 * a counter sale is not.
 */
const CHASEABLE_STREAMS: readonly string[] = ['HOSPITAL', 'LAB'];

function figuresFor(
  stream: readonly string[],
  invoices: StreamInvoice[],
  payments: StreamMovement[],
  refunds: StreamMovement[],
  range: WindowRange,
): WindowFigures {
  const mine = (k: string) => stream.includes(k);

  const billedMinor = sumMinor(
    invoices.filter((i) => mine(i.kind) && within(i.issuedAt, range)).map((i) => i.totalMinor),
  );
  const taxMinor = sumMinor(
    invoices.filter((i) => mine(i.kind) && within(i.issuedAt, range)).map((i) => i.taxMinor),
  );
  const collectedMinor = sumMinor(
    payments.filter((p) => mine(p.kind) && within(p.at, range)).map((p) => p.amountMinor),
  );
  const refundedMinor = sumMinor(
    refunds.filter((r) => mine(r.kind) && within(r.at, range)).map((r) => r.amountMinor),
  );

  return {
    billed: fromMinor(billedMinor),
    tax: fromMinor(taxMinor),
    /*
     * Gross in, gross out, net derived — all three, never one that hides the
     * others. Reconciling against a bank statement needs the pair: a day that
     * took 5,000 and refunded 500 is not the same day as one that took 4,500,
     * and only the gross figures tell them apart. Subtracting refunds from
     * `collected` and reporting that as collected is the opposite error, and it
     * is the one this report was rewritten to stop.
     */
    collected: fromMinor(collectedMinor),
    refunded: fromMinor(refundedMinor),
    net: fromMinor(collectedMinor - refundedMinor),
  };
}

/**
 * Outstanding for a set of streams: **charge minus credits minus payments**.
 *
 * Never `total - amountPaid`. A credit note raised against an invoice reduces
 * what is owed, and ignoring it leaves a balance nobody is chasing sitting on
 * the screen forever — which is the arithmetic the send-out worklist and the
 * pharmacy till were both written to avoid, and which the admin dashboard was
 * quietly getting wrong.
 *
 * Floored per invoice rather than in total, so one overpaid invoice cannot
 * cancel out a genuine debt on another and make the hospital look square.
 */
function outstandingFor(
  stream: readonly string[],
  invoices: StreamInvoice[],
  /**
   * When given, only invoices **issued inside this range** count — which is
   * what makes the figure belong on a row of period figures. When omitted, all
   * of them do, which is the separate all-time total.
   */
  range?: WindowRange,
) {
  const open = invoices.filter(
    (i) =>
      stream.includes(i.kind) &&
      !i.isSettled &&
      owedOn(i) > 0 &&
      (!range || within(i.issuedAt, range)),
  );
  return {
    outstanding: fromMinor(sumMinor(open.map(owedOn))),
    openInvoices: open.length,
  };
}

function owedOn(invoice: StreamInvoice): number {
  return Math.max(0, invoice.totalMinor - invoice.creditedMinor - invoice.paidMinor);
}

/**
 * Per-stream figures plus the combined total, in the order a screen reads them.
 *
 * Every stream is returned even at zero, and that is the same decision as the
 * payment-method split listing a method that took nothing: "the pharmacy took
 * nothing today" and "the pharmacy row is missing" look identical on screen and
 * only one of them means the till balances. Which streams a hospital actually
 * bought is the client's question, answered from `hospital.modules` — the
 * response shape stays fixed so no caller has to guard it.
 *
 * `ALL` is computed over the union rather than by adding the three results, so a
 * stream added to `InvoiceKind` later cannot silently fall out of the total
 * while every individual figure still looks right.
 */
export function revenueByStream(
  invoices: StreamInvoice[],
  payments: StreamMovement[],
  refunds: StreamMovement[],
  period: WindowRange,
): StreamRevenue[] {
  const build = (label: RevenueStream | 'ALL', members: readonly string[]): StreamRevenue => {
    const inPeriod = outstandingFor(members, invoices, period);
    const allTime = outstandingFor(members, invoices);
    return {
      stream: label,
      period: figuresFor(members, invoices, payments, refunds, period),
      outstandingInPeriod: inPeriod.outstanding,
      openInvoicesInPeriod: inPeriod.openInvoices,
      outstandingAllTime: allTime.outstanding,
      openInvoicesAllTime: allTime.openInvoices,
      chaseable: members.every((m) => CHASEABLE_STREAMS.includes(m)),
    };
  };

  return [...REVENUE_STREAMS.map((s) => build(s, [s])), build('ALL', REVENUE_STREAMS)];
}

/*
 * `financeBlock` lived here and is gone.
 *
 * It built four keys named `collectedLastSevenDays`, `refundedLastSevenDays`,
 * `netLastSevenDays` and `outstanding`, because the dashboard reported a fixed
 * rolling week. The period is now the reader's choice, so three of those names
 * described a window they no longer covered — and a key named for the wrong
 * window is the false name this project has recorded four times as the cause of
 * a real incident. `revenue-streams.spec.ts` failed the moment the dashboard
 * started passing an arbitrary period, which is the behaviour those guards exist
 * for.
 *
 * What replaced it is no function at all: `streamNamed(revenue, 'HOSPITAL').period`
 * for the period figures and `.outstandingAllTime` for the one that ignores it.
 * The two are read in different sections of the response, so there is nothing
 * left for a helper to get wrong.
 */

/** The single stream a caller wants, or a thrown error rather than a silent zero. */
export function streamNamed(streams: StreamRevenue[], name: RevenueStream): StreamRevenue {
  const found = streams.find((s) => s.stream === name);
  if (!found) throw new Error(`revenueByStream did not produce a ${name} row`);
  return found;
}

/** The combined row, for a caller that wants the headline without searching. */
export function combinedRevenue(streams: StreamRevenue[]): StreamRevenue {
  const all = streams.find((s) => s.stream === 'ALL');
  if (!all) {
    // Cannot happen via revenueByStream; a thrown error beats a silent zero,
    // because a dashboard reading 0.00 collected is a support call.
    throw new Error('revenueByStream did not produce a combined row');
  }
  return all;
}

export const EMPTY_WINDOW_FIGURES = ZERO;

/** Minor units from a Prisma Decimal, via the string form money.ts insists on. */
export function decimalToMinor(value: unknown): number {
  return toMinor(toMoneyString(value ?? '0.00'));
}
