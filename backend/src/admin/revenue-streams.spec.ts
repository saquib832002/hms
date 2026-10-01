import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InvoiceKind } from '@prisma/client';
import { AGEABLE_INVOICE_KINDS } from '../billing/invoice-response';
import {
  REVENUE_STREAMS,
  combinedRevenue,
  revenueByStream,
  streamNamed,
  type StreamInvoice,
  type StreamMovement,
  type StreamRevenue,
  type WindowRange,
} from './revenue-streams';

const at = (iso: string) => new Date(iso);

/** One day, the shape `resolvePeriod` returns for `?from=2026-09-30&to=2026-09-30`. */
const TODAY: WindowRange = {
  start: at('2026-09-30T00:00:00Z'),
  end: at('2026-10-01T00:00:00Z'),
};
/** A rolling week including today. */
const WEEK: WindowRange = {
  start: at('2026-09-24T00:00:00Z'),
  end: at('2026-10-01T00:00:00Z'),
};

function invoice(over: Partial<StreamInvoice> = {}): StreamInvoice {
  return {
    kind: InvoiceKind.HOSPITAL,
    issuedAt: at('2026-09-30T09:00:00Z'),
    totalMinor: 10_000,
    paidMinor: 0,
    creditedMinor: 0,
    taxMinor: 0,
    isSettled: false,
    ...over,
  };
}

function movement(over: Partial<StreamMovement> = {}): StreamMovement {
  return {
    kind: InvoiceKind.HOSPITAL,
    amountMinor: 10_000,
    at: at('2026-09-30T09:00:00Z'),
    ...over,
  };
}

const find = (rows: StreamRevenue[], stream: string) => rows.find((r) => r.stream === stream)!;

describe('revenueByStream', () => {
  it('reports every stream even when it took nothing', () => {
    const rows = revenueByStream([], [], [], TODAY);
    expect(rows.map((r) => r.stream)).toEqual([...REVENUE_STREAMS, 'ALL']);
    /*
     * "The pharmacy took nothing today" and "the pharmacy row is missing" look
     * identical on screen and only one of them means the till balances. Same
     * decision as the payment-method split listing a method at zero.
     */
    for (const row of rows) expect(row.period.collected).toBe('0.00');
  });

  it('keeps each stream to its own invoices', () => {
    const rows = revenueByStream(
      [
        invoice({ kind: InvoiceKind.HOSPITAL, totalMinor: 10_000 }),
        invoice({ kind: InvoiceKind.PHARMACY, totalMinor: 2_500 }),
        invoice({ kind: InvoiceKind.LAB, totalMinor: 700 }),
      ],
      [],
      [],
      TODAY,
    );

    expect(find(rows, 'HOSPITAL').period.billed).toBe('100.00');
    expect(find(rows, 'PHARMACY').period.billed).toBe('25.00');
    expect(find(rows, 'LAB').period.billed).toBe('7.00');
  });

  it('derives net from the gross pair and keeps both', () => {
    const rows = revenueByStream(
      [],
      [movement({ amountMinor: 50_000 })],
      [movement({ amountMinor: 5_000 })],
      TODAY,
    );
    const hospital = find(rows, 'HOSPITAL').period;

    /*
     * Reported from use: reception raised 500, billing took 500, billing
     * refunded 500, and the dashboard still read 500 collected while the
     * payments ledger netted to nothing. The fix is not to subtract refunds
     * from `collected` — that is the opposite error. Gross in, gross out, net
     * derived, all three present.
     */
    expect(hospital.collected).toBe('500.00');
    expect(hospital.refunded).toBe('50.00');
    expect(hospital.net).toBe('450.00');
  });

  it('nets to a negative when more came back than went in', () => {
    // A refund against an invoice paid last month. Real, and a figure clamped
    // at zero here would hide a day the till actually went backwards.
    const rows = revenueByStream([], [], [movement({ amountMinor: 2_000 })], TODAY);
    expect(find(rows, 'HOSPITAL').period.net).toBe('-20.00');
  });

  it('totals ALL as the sum of its streams', () => {
    const rows = revenueByStream(
      [
        invoice({ kind: InvoiceKind.HOSPITAL, totalMinor: 10_000, taxMinor: 500 }),
        invoice({ kind: InvoiceKind.PHARMACY, totalMinor: 2_500, taxMinor: 250 }),
        invoice({ kind: InvoiceKind.LAB, totalMinor: 700, taxMinor: 35 }),
      ],
      [
        movement({ kind: InvoiceKind.HOSPITAL, amountMinor: 9_000 }),
        movement({ kind: InvoiceKind.PHARMACY, amountMinor: 2_500 }),
        movement({ kind: InvoiceKind.LAB, amountMinor: 100 }),
      ],
      [movement({ kind: InvoiceKind.PHARMACY, amountMinor: 300 })],
      TODAY,
    );
    const all = combinedRevenue(rows);

    for (const field of ['billed', 'tax', 'collected', 'refunded', 'net'] as const) {
      const parts = REVENUE_STREAMS.map((s) => Number(find(rows, s).period[field]));
      expect(Number(all.period[field])).toBeCloseTo(
        parts.reduce((a, b) => a + b, 0),
        2,
      );
    }

    expect(all.period.billed).toBe('132.00');
    expect(all.period.collected).toBe('116.00');
    expect(all.period.net).toBe('113.00');
  });

  it('treats a period as half-open, so one payment lands in one period', () => {
    const midnight = movement({ at: at('2026-10-01T00:00:00Z') });
    // `[start, end)` everywhere in this project. The instant that ends today is
    // the instant that starts tomorrow, and counting it twice is how a month
    // boundary produces a figure nobody can reconcile.
    expect(find(revenueByStream([], [midnight], [], TODAY), 'HOSPITAL').period.collected).toBe(
      '0.00',
    );
  });

  it('counts a payment from six days ago in the week but not in today', () => {
    const payment = movement({ at: at('2026-09-25T09:00:00Z'), amountMinor: 4_000 });
    expect(find(revenueByStream([], [payment], [], TODAY), 'HOSPITAL').period.collected).toBe(
      '0.00',
    );
    expect(find(revenueByStream([], [payment], [], WEEK), 'HOSPITAL').period.collected).toBe(
      '40.00',
    );
  });

  describe('unpaid', () => {
    /*
     * THE BUG THIS SPLIT EXISTS FOR.
     *
     * Reported by the product owner: with *Today* selected, the unpaid figure
     * showed a balance from months earlier — *"the customer may get confused,
     * where is it coming from"*. Every other number on that row moved with the
     * period and this one did not, so the row read as one period's figures and
     * was not.
     */
    const old = invoice({ issuedAt: at('2026-03-04T09:00:00Z'), totalMinor: 6_000 });
    const todays = invoice({ issuedAt: at('2026-09-30T10:00:00Z'), totalMinor: 2_000 });

    it('counts only what the period itself billed', () => {
      const rows = revenueByStream([old, todays], [], [], TODAY);
      expect(find(rows, 'HOSPITAL').outstandingInPeriod).toBe('20.00');
      expect(find(rows, 'HOSPITAL').openInvoicesInPeriod).toBe(1);
    });

    it('still reports everything owed, separately', () => {
      /*
       * Kept, because it is the figure that decides whether to chase anybody:
       * an unpaid sale from last week is still money owed today, and a clinic
       * looking at *Today* must not conclude it is square. The mistake was
       * never computing it — it was putting it in a row of period figures with
       * nothing saying it was the exception.
       */
      const rows = revenueByStream([old, todays], [], [], TODAY);
      expect(find(rows, 'HOSPITAL').outstandingAllTime).toBe('80.00');
      expect(find(rows, 'HOSPITAL').openInvoicesAllTime).toBe(2);
    });

    it('reports nothing owed for a period that billed nothing', () => {
      // Correct rather than empty: we charged nothing then, so nothing from
      // then is outstanding. The all-time figure is where the debt shows.
      const quiet: WindowRange = {
        start: at('2026-08-01T00:00:00Z'),
        end: at('2026-08-02T00:00:00Z'),
      };
      const rows = revenueByStream([old, todays], [], [], quiet);
      expect(find(rows, 'HOSPITAL').outstandingInPeriod).toBe('0.00');
      expect(find(rows, 'HOSPITAL').outstandingAllTime).toBe('80.00');
    });

    it('is charge minus credits minus payments, never total minus paid', () => {
      const rows = revenueByStream(
        [invoice({ totalMinor: 10_000, paidMinor: 3_000, creditedMinor: 2_000 })],
        [],
        [],
        TODAY,
      );
      /*
       * 100.00 charged, 20.00 credited, 30.00 paid → 50.00 owed. Ignoring the
       * credit leaves 70.00: a balance nobody is chasing, sitting on an owner's
       * dashboard forever. The admin dashboard was doing exactly that.
       */
      expect(find(rows, 'HOSPITAL').outstandingInPeriod).toBe('50.00');
      expect(find(rows, 'HOSPITAL').outstandingAllTime).toBe('50.00');
    });

    it('floors per invoice, so an overpayment cannot mask another debt', () => {
      const rows = revenueByStream(
        [
          invoice({ totalMinor: 1_000, paidMinor: 5_000 }), // overpaid by 40.00
          invoice({ totalMinor: 8_000, paidMinor: 0 }), // genuinely owes 80.00
        ],
        [],
        [],
        TODAY,
      );
      expect(find(rows, 'HOSPITAL').outstandingInPeriod).toBe('80.00');
      expect(find(rows, 'HOSPITAL').openInvoicesInPeriod).toBe(1);
    });

    it('excludes a settled invoice', () => {
      const rows = revenueByStream(
        [invoice({ totalMinor: 10_000, paidMinor: 10_000, isSettled: true })],
        [],
        [],
        TODAY,
      );
      expect(find(rows, 'HOSPITAL').outstandingInPeriod).toBe('0.00');
      expect(find(rows, 'HOSPITAL').outstandingAllTime).toBe('0.00');
    });
  });

  describe('chaseable', () => {
    it('marks the pharmacy as not a debtor to chase', () => {
      const rows = revenueByStream([], [], [], TODAY);
      expect(find(rows, 'HOSPITAL').chaseable).toBe(true);
      expect(find(rows, 'LAB').chaseable).toBe(true);
      /*
       * A counter sale is paid at the counter or it does not happen, it often
       * has no patient to chase, and an unsettled one is an unreconciled till.
       * A screen that totals all three under "owed" invites somebody to chase a
       * walk-in who left with their paracetamol a fortnight ago.
       */
      expect(find(rows, 'PHARMACY').chaseable).toBe(false);
      // ALL contains the pharmacy, so the combined figure is not chaseable either.
      expect(combinedRevenue(rows).chaseable).toBe(false);
    });

    it('agrees with AGEABLE_INVOICE_KINDS rather than keeping its own list', () => {
      // Two lists deciding "is this a debtor" is how the admin aging and the
      // billing aging came to disagree about LAB invoices.
      const rows = revenueByStream([], [], [], TODAY);
      const chaseable = REVENUE_STREAMS.filter((s) => find(rows, s).chaseable);
      expect([...chaseable].sort()).toEqual([...(AGEABLE_INVOICE_KINDS as string[])].sort());
    });
  });
});

describe('the period figures a screen reads', () => {
  const rows = (period: WindowRange = WEEK) =>
    revenueByStream(
      [
        invoice({ kind: InvoiceKind.HOSPITAL, totalMinor: 10_000 }),
        invoice({ kind: InvoiceKind.PHARMACY, totalMinor: 40_000 }),
      ],
      [
        movement({ kind: InvoiceKind.HOSPITAL, amountMinor: 1_000 }),
        movement({ kind: InvoiceKind.PHARMACY, amountMinor: 90_000 }),
      ],
      [],
      period,
    );

  it('report only the stream they belong to', () => {
    // Hand it the hospital and the shop's 900.00 must not appear. This is the
    // assertion the old text guard could not make.
    expect(streamNamed(rows(), 'HOSPITAL').period.collected).toBe('10.00');
    expect(streamNamed(rows(), 'PHARMACY').period.collected).toBe('900.00');
    expect(combinedRevenue(rows()).period.collected).toBe('910.00');
  });

  it('are named for no particular window, because the reader picks it', () => {
    /*
     * `financeBlock` built `collectedLastSevenDays` and two siblings, which was
     * honest while the dashboard reported a fixed rolling week and became a
     * false name the moment the period became a parameter. Those three guards
     * failed on the change rather than after it, which is what they were for.
     */
    expect(Object.keys(streamNamed(rows(), 'HOSPITAL').period).sort()).toEqual([
      'billed',
      'collected',
      'net',
      'refunded',
      'tax',
    ]);
    /*
     * Comments stripped, because the note explaining why those names went
     * mentions them by name — and a guard satisfied by its own documentation
     * asserts nothing. Third time in this repo.
     */
    const source = stripComments(readFileSync(resolve(__dirname, 'revenue-streams.ts'), 'utf8'));
    expect(source).not.toMatch(/LastSevenDays|Today:/);
  });

  it('keep the all-time owed figure reachable and separate', () => {
    /*
     * That figure is what a clinic decides whether to chase on, and narrowing
     * it to a week would quietly turn a debt figure into a recent-billing one
     * while reading identically. It sits in the response's `rightNow` section.
     */
    const quiet: WindowRange = {
      start: at('2026-08-01T00:00:00Z'),
      end: at('2026-08-02T00:00:00Z'),
    };
    const hospital = streamNamed(rows(quiet), 'HOSPITAL');
    expect(hospital.outstandingAllTime).toBe('100.00');
    expect(hospital.openInvoicesAllTime).toBe(1);
    expect(hospital.period.collected).toBe('0.00');
  });
});

describe('streamNamed', () => {
  it('throws rather than returning a silent zero', () => {
    // A dashboard reading 0.00 collected is a support call; an exception at
    // boot is a stack trace naming the cause.
    expect(() => streamNamed([], 'HOSPITAL')).toThrow(/HOSPITAL/);
  });
});

describe('the callers do not grow their own copy', () => {
  const service = readFileSync(resolve(__dirname, 'admin.service.ts'), 'utf8');

  it('fetches and shapes the rows in exactly one place', () => {
    /*
     * `dashboard()` and `revenueReport()` both need per-stream money. Two
     * copies of the fetch would be two chances to forget the `OR` that brings
     * in old open invoices, and the symptom would be an all-time owed figure
     * that silently only covered the period — the bug this change fixes,
     * reappearing on one screen of two.
     */
    expect(countOf(service, /private async revenueFor\(/g)).toBe(1);
    expect(countOf(service, /this\.revenueFor\(/g)).toBe(2);
    // And nothing else calls revenueByStream directly any more.
    expect(countOf(service, /revenueByStream\(/g)).toBe(1);
  });

  it('builds the dashboard’s money figures from one named stream', () => {
    /*
     * The bug this module exists for. `GET /admin/dashboard` summed every
     * payment and refund in the window with no `kind` filter, so a hospital
     * running a separately-billed pharmacy read a "collected" that included the
     * shop — while `financeReport` split them correctly and CLAUDE.md claimed
     * the rule held.
     *
     * Scoped to the dashboard method's own body, because `financeReport` four
     * hundred lines below legitimately names every kind and would satisfy a
     * file-wide search on its own. That exact mistake made
     * `referral-return.spec.ts` pass with its fault reintroduced.
     */
    const body = methodBody(service, 'async dashboard(');
    expect(body).toMatch(/streamNamed\(revenue, 'HOSPITAL'\)/);
    expect(body).toMatch(/finance: hospitalRevenue\.period/);
    // And the raw unfiltered sums are gone rather than merely unused.
    expect(body).not.toMatch(/collectedWeekMinor|refundedWeekMinor|outstandingMinor/);
  });

  it('gives the dashboard the period the reader chose, not a fixed window', () => {
    /*
     * This method held a hard-coded rolling week and three fixed windows before
     * it. Reported by the product owner: the period control drove the revenue
     * card only, so "zero tests ordered today" sat above a card showing August.
     */
    const body = methodBody(service, 'async dashboard(');
    expect(body).toMatch(/resolvePeriod\(timezone, period\)/);
    expect(body).toMatch(/this\.revenueFor\(window\)/);
    expect(body).not.toMatch(/weekWindow|6 \* 86_400_000/);
  });

  it('separates the figures that ignore the period', () => {
    /*
     * Occupancy is how many beds are full *now*; a queue depth is a backlog or
     * it is not. Making them silently ignore the dates is the reported bug;
     * substituting an average would be worse, because it is a plausible number
     * answering a question nobody asked.
     */
    const body = methodBody(service, 'async dashboard(');
    expect(body).toMatch(/overPeriod: \{/);
    expect(body).toMatch(/rightNow: \{/);
    const rightNow = body.slice(body.indexOf('rightNow: {'));
    for (const fixed of ['occupancy', 'staff', 'security', 'catalogue']) {
      expect(rightNow).toContain(fixed);
    }
  });

  it('resolves the period through the shared resolver, not its own parsing', () => {
    /*
     * `resolvePeriod` is shared with lab statements. A second implementation of
     * "which days does this period cover" does not produce a formatting
     * difference — it produces two screens quoting different totals for the
     * same named period.
     */
    const body = methodBody(service, 'async revenueReport(');
    expect(body).toMatch(/resolvePeriod\(timezone, period\)/);
    expect(stripComments(body)).not.toMatch(/parseDateKey|zonedTimeToUtc|hospitalMonthRange/);
  });

  it('sends the resolved boundaries back so the screen prints what was used', () => {
    // A preset computes "today" from the device's clock; the server resolves it
    // in the hospital's timezone. Those differ by a day for anybody not sitting
    // in their own clinic, and a screen that prints its own guess hides that.
    const body = methodBody(service, 'async revenueReport(');
    expect(body).toMatch(/from: resolved\.from/);
    expect(body).toMatch(/to: resolved\.to/);
    expect(body).toMatch(/label: resolved\.label/);
  });

  it('builds admin aging from the shared kind list, not a hand-rolled filter', () => {
    /*
     * Comments are stripped first, and that is not tidiness: the first version
     * of this matched the bare identifier against the whole file and **passed
     * with the fault reintroduced**, because the explanatory comment directly
     * above the fix mentions the identifier by name. A guard satisfied by its
     * own documentation asserts nothing.
     */
    const code = stripComments(service);
    expect(code).toMatch(/AGEABLE_INVOICE_KINDS as readonly string\[\]\)\.includes\(i\.kind\)/);
    expect(code).not.toMatch(/i\.kind === InvoiceKind\.HOSPITAL/);
  });
});

/** Source with block and line comments removed, so prose cannot satisfy a matcher. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function countOf(source: string, pattern: RegExp): number {
  return (stripComments(source).match(pattern) ?? []).length;
}

/**
 * The text of one method, so an assertion about `dashboard()` cannot be
 * satisfied by something true of `financeReport()` four hundred lines below.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found — this guard is asserting nothing`);
  const rest = source.slice(start);
  // The method ends at the next declaration at the same indentation.
  const end = rest.search(/\n {2}(?:private |public |async |\/\*\*)/);
  return end > 0 ? rest.slice(0, end) : rest;
}
