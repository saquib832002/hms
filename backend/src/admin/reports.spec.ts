import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTIVITY_ACTIONS,
  collectedSince,
  collectionsByStaff,
  countActions,
  countWorkload,
  methodSplit,
  monthlyTotals,
  monthLabel,
  revenueByDoctor,
  toLedgerRow,
  type ReportablePayment,
} from './reports';
import { hospitalMonthKey, hospitalMonthRange, recentMonths } from '../common/utils/hospital-time';

/**
 * A number on a management dashboard is believed precisely because nobody can
 * check it by eye. That makes a quietly wrong aggregate worse than a crash —
 * it gets acted on.
 */

const p = (
  amountMinor: number,
  receivedAt: string,
  method = 'CASH',
  monthKey?: string,
): ReportablePayment => ({
  amountMinor,
  receivedAt: new Date(receivedAt),
  method,
  monthKey: monthKey ?? receivedAt.slice(0, 7),
});

describe('monthly totals', () => {
  const months = ['2026-06', '2026-07', '2026-08'];

  it('sums each month exactly, in minor units', () => {
    const rows = monthlyTotals(
      [p(1050, '2026-06-04T10:00:00Z'), p(2075, '2026-06-20T10:00:00Z'), p(10, '2026-08-01T10:00:00Z')],
      months,
    );
    expect(rows.map((r) => r.collected)).toEqual(['31.25', '0.00', '0.10']);
    expect(rows.map((r) => r.payments)).toEqual([2, 0, 1]);
  });

  it('keeps a month with no payments as a zero rather than dropping it', () => {
    /*
     * The failure this exists for. Deriving the axis from the rows is the
     * standard way a revenue chart ends up flattering: the quiet months are
     * simply not drawn, and the line only ever connects the good ones.
     */
    const rows = monthlyTotals([p(500, '2026-08-02T10:00:00Z')], months);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ month: '2026-07', collected: '0.00', payments: 0 });
  });

  it('ignores payments outside the window instead of folding them into the edge', () => {
    // Otherwise the oldest bar silently becomes "this month plus all history",
    // which looks like a great first month every single time.
    const rows = monthlyTotals([p(99_999, '2019-01-01T10:00:00Z')], months);
    expect(rows.map((r) => r.collected)).toEqual(['0.00', '0.00', '0.00']);
  });

  it('does not accumulate float error across many payments', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004. A thousand of those is a
    // reconciliation dispute a finance clerk cannot explain.
    const many = Array.from({ length: 1000 }, () => p(10, '2026-06-15T10:00:00Z'));
    expect(monthlyTotals(many, months)[0].collected).toBe('100.00');
  });

  it('labels months for the client, so two clients cannot disagree', () => {
    expect(monthLabel('2026-01')).toBe('Jan 2026');
    expect(monthLabel('2026-12')).toBe('Dec 2026');
  });
});

describe('collected since', () => {
  const payments = [
    p(1000, '2026-08-29T09:00:00Z'),
    p(2000, '2026-08-28T09:00:00Z'),
    p(3000, '2026-07-01T09:00:00Z'),
  ];

  it('counts from when the money arrived, not when it was charged', () => {
    expect(collectedSince(payments, new Date('2026-08-29T00:00:00Z'))).toBe('10.00');
    expect(collectedSince(payments, new Date('2026-08-01T00:00:00Z'))).toBe('30.00');
  });

  it('includes a payment landing exactly on the boundary', () => {
    // `gte`, not `gt`. A payment at exactly midnight belongs to the day that
    // is starting, and dropping it makes the first sale of the day vanish.
    expect(collectedSince([p(500, '2026-08-29T00:00:00Z')], new Date('2026-08-29T00:00:00Z'))).toBe(
      '5.00',
    );
  });
});

describe('payment method split', () => {
  const todayStart = new Date('2026-08-29T00:00:00Z');
  const monthStart = new Date('2026-08-01T00:00:00Z');
  const payments = [
    p(5000, '2026-08-29T09:00:00Z', 'CASH'),
    p(2500, '2026-08-15T09:00:00Z', 'CASH'),
    p(9000, '2026-08-20T09:00:00Z', 'CARD'),
  ];

  it('separates today from the month', () => {
    const rows = methodSplit(payments, todayStart, monthStart, ['CASH', 'CARD']);
    const cash = rows.find((r) => r.method === 'CASH')!;
    expect(cash.today).toEqual({ amount: '50.00', count: 1 });
    expect(cash.month).toEqual({ amount: '75.00', count: 2 });
  });

  it('shows a zero for a method nobody used, rather than omitting it', () => {
    /*
     * "No bank transfers today" and "the bank transfer row is missing" look
     * identical on screen, and only one of them means the till balances.
     */
    const rows = methodSplit(payments, todayStart, monthStart, ['CASH', 'CARD', 'BANK_TRANSFER']);
    expect(rows.map((r) => r.method).sort()).toEqual(['BANK_TRANSFER', 'CARD', 'CASH']);
    expect(rows.find((r) => r.method === 'BANK_TRANSFER')!.month.amount).toBe('0.00');
  });

  it('orders by the month total, largest first', () => {
    const rows = methodSplit(payments, todayStart, monthStart, ['CASH', 'CARD']);
    expect(rows[0].method).toBe('CARD');
  });
});

describe('workload counts', () => {
  it('counts booked, completed and no-show without double counting', () => {
    const at = new Date('2026-08-29T09:00:00Z');
    const counts = countWorkload([
      { doctorId: 1, status: 'COMPLETED', scheduledAt: at },
      { doctorId: 1, status: 'NO_SHOW', scheduledAt: at },
      { doctorId: 1, status: 'SCHEDULED', scheduledAt: at },
    ]);
    // `booked` is every row, including the ones that did not happen — the
    // denominator a no-show rate is meaningful against.
    expect(counts).toEqual({ booked: 3, completed: 1, noShow: 1 });
  });
});

describe('revenue by doctor', () => {
  it('reports billed and collected separately', () => {
    /*
     * Payment is deliberately not required before a consultation, so these two
     * genuinely differ. Reporting only what was charged is how a clinic
     * mistakes invoices raised for money in the bank.
     */
    const map = revenueByDoctor([
      { doctorId: 7, totalMinor: 12_000, paidMinor: 12_000 },
      { doctorId: 7, totalMinor: 6_000, paidMinor: 0 },
    ]);
    expect(map.get(7)).toEqual({ billed: '180.00', collected: '120.00' });
  });

  it('drops an invoice with no doctor rather than attributing it to one', () => {
    // Ad-hoc invoices — a dressing, a certificate — have no appointment behind
    // them. Bucketing those under any doctor would be an invented figure.
    const map = revenueByDoctor([{ doctorId: null, totalMinor: 500, paidMinor: 500 }]);
    expect(map.size).toBe(0);
  });
});

describe('hospital-local months', () => {
  /*
   * A payment taken at 23:30 on the 31st in Asia/Kolkata is already the 1st in
   * UTC. This is the figure someone reconciles against a bank statement, so
   * being a day out at the boundary is not cosmetic.
   */
  it('buckets a late-night payment into the hospital’s month, not the server’s', () => {
    const instant = new Date('2026-07-31T18:45:00Z'); // 00:15 on 1 Aug in Kolkata
    expect(hospitalMonthKey(instant, 'UTC')).toBe('2026-07');
    expect(hospitalMonthKey(instant, 'Asia/Kolkata')).toBe('2026-08');
  });

  it('opens and closes the month on the hospital’s clock', () => {
    const { start, end } = hospitalMonthRange(new Date('2026-08-15T12:00:00Z'), 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });

  it('rolls the year backwards across January', () => {
    const { keys } = recentMonths(new Date('2026-02-10T12:00:00Z'), 'UTC', 4);
    expect(keys).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('ends the window on the current month and opens it at the first month’s start', () => {
    const { keys, start } = recentMonths(new Date('2026-08-15T12:00:00Z'), 'UTC', 12);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe('2026-08');
    expect(keys[0]).toBe('2025-09');
    // The query bound has to reach the first month or its bar renders short.
    expect(start.toISOString()).toBe('2025-09-01T00:00:00.000Z');
  });
});

describe('per-day staff activity', () => {
  const rows = [
    { userId: 1, action: 'PATIENT_CREATE', outcome: 'SUCCESS' },
    { userId: 1, action: 'APPOINTMENT_CREATE', outcome: 'SUCCESS' },
    { userId: 1, action: 'APPOINTMENT_CREATE', outcome: 'FAILURE' },
    { userId: 1, action: 'QUEUE_VIEW', outcome: 'SUCCESS' },
    { userId: 2, action: 'PATIENT_CREATE', outcome: 'SUCCESS' },
    { userId: null, action: 'AUTH_LOGIN', outcome: 'FAILURE' },
  ];

  it('counts each actor separately', () => {
    const counts = countActions(rows, ACTIVITY_ACTIONS.RECEPTIONIST);
    // One of user 1's two APPOINTMENT_CREATE rows was refused, so it is not a
    // booking they made.
    expect(counts.get(1)).toMatchObject({ registrations: 1, bookings: 1 });
    expect(counts.get(2)).toMatchObject({ registrations: 1, bookings: 0 });
  });

  it('counts only what succeeded, and reports no refusals per person', () => {
    /*
     * An earlier version carried a `denied` figure on every row. It was
     * removed on the same reasoning that keeps reads out of these counts:
     * beside someone's registrations and bookings, a refusal count reads as a
     * performance metric and is not one. Most denials are a stale tab, a
     * bookmarked URL, or a role that changed this morning — the app's own
     * plumbing, not a judgement about the person.
     *
     * The signal is not lost, only moved to where it means something: the
     * dashboard's hospital-wide denied count, and the audit log itself.
     */
    const counts = countActions(rows, ACTIVITY_ACTIONS.RECEPTIONIST);
    expect(counts.get(1)).not.toHaveProperty('denied');
    // The refused APPOINTMENT_CREATE is not counted as a booking — a refused
    // attempt changed nothing, so it belongs in no count of work.
    expect(counts.get(1)?.bookings).toBe(1);
  });

  it('drops actions with no actor rather than attributing them', () => {
    // An anonymous failed login belongs to no member of staff. Bucketing it
    // under anyone would put someone else's failure on their record.
    expect(countActions(rows, ACTIVITY_ACTIONS.RECEPTIONIST).has(null as never)).toBe(false);
    expect(countActions(rows, ACTIVITY_ACTIONS.RECEPTIONIST).size).toBe(2);
  });

  it('counts no read-only action anywhere', () => {
    /*
     * `QUEUE_VIEW` and `PATIENT_SEARCH` measure how long a screen was open, not
     * what was done. A productivity figure built on them rewards leaving a list
     * up, and it is the first number a member of staff would rightly argue
     * with.
     */
    const counted = Object.values(ACTIVITY_ACTIONS).flatMap((group) =>
      Object.values(group).flat(),
    );
    for (const read of [
      'QUEUE_VIEW',
      'PATIENT_SEARCH',
      'PATIENT_VIEW',
      'RECORD_LIST',
      'PRESCRIPTION_VIEW',
      'WARD_BOARD_VIEW',
      'INVOICE_LIST',
      'DISPENSE_QUEUE_VIEW',
    ]) {
      expect(counted).not.toContain(read);
    }
  });

  it('starts every bucket at zero, so a quiet day is a zero and not a gap', () => {
    const counts = countActions(
      [{ userId: 9, action: 'PATIENT_CREATE', outcome: 'SUCCESS' }],
      ACTIVITY_ACTIONS.RECEPTIONIST,
    );
    expect(counts.get(9)).toEqual({
      registrations: 1,
      bookings: 0,
      updates: 0,
      invoicesRaised: 0,
    });
  });
});

describe('money taken per person', () => {
  const payments = [
    { receivedById: 3, amountMinor: 5_000, method: 'CASH' },
    { receivedById: 3, amountMinor: 2_500, method: 'CASH' },
    { receivedById: 3, amountMinor: 9_000, method: 'CARD' },
    { receivedById: 4, amountMinor: 1_000, method: 'CASH' },
  ];

  it('totals exactly and splits by method', () => {
    const byStaff = collectionsByStaff(payments);
    expect(byStaff.get(3)).toEqual({
      total: '165.00',
      count: 3,
      methods: [
        { method: 'CARD', amount: '90.00' },
        { method: 'CASH', amount: '75.00' },
      ],
    });
  });

  it('does not mix two people’s takings', () => {
    // The whole point of a per-person figure: the cash drawer one person is
    // responsible for should reconcile against their row and nobody else's.
    expect(collectionsByStaff(payments).get(4)?.total).toBe('10.00');
  });
});

describe('the consultation ledger row', () => {
  const source = {
    id: 12,
    scheduledAt: new Date('2026-08-29T09:30:00Z'),
    status: 'COMPLETED',
    patient: { id: 7, fullName: 'A Patient' },
    doctor: { id: 3, fullName: 'Dr Demo' },
    invoice: { id: 90, totalAmount: '120.00', amountPaid: '50.00' },
    prescription: { id: 4 },
  };

  it('shows what was charged, paid and still owed', () => {
    expect(toLedgerRow(source).invoice).toEqual({
      id: 90,
      total: '120.00',
      paid: '50.00',
      outstanding: '70.00',
      settled: false,
    });
  });

  it('computes settled from the arithmetic, not from a status field', () => {
    /*
     * So "paid" on the owner's screen always agrees with the numbers beside
     * it. An invoice whose status says PAID while a balance remains is a bug
     * worth seeing, not one worth hiding behind a label.
     */
    const paid = toLedgerRow({ ...source, invoice: { id: 90, totalAmount: '120.00', amountPaid: '120.00' } });
    expect(paid.invoice).toMatchObject({ outstanding: '0.00', settled: true });
  });

  it('handles an appointment nobody billed', () => {
    // Payment is never required before a consultation, so this is ordinary
    // rather than exceptional — and it must not read as zero owed.
    expect(toLedgerRow({ ...source, invoice: null }).invoice).toBeNull();
  });

  it('reports that a prescription exists, never what is in it', () => {
    /*
     * The line worth holding. That a doctor prescribed something is an
     * operational fact about the consultation; *what* they prescribed names a
     * condition — an antiretroviral or an antipsychotic on an owner's screen
     * tells them something the patient told their doctor.
     */
    const row = toLedgerRow(source);
    expect(row.prescriptionIssued).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/medicine|dosage|item/i);
    expect(toLedgerRow({ ...source, prescription: null }).prescriptionIssued).toBe(false);
  });

  it('carries no field beyond the allowlist', () => {
    /*
     * Asserting on the exact key set, not on a few absences.
     *
     * A spread of a Prisma row would pass every "does it contain X" check
     * while silently carrying the next field somebody adds to the model. The
     * whole value of this shape is what it refuses.
     */
    expect(Object.keys(toLedgerRow(source)).sort()).toEqual([
      'doctor',
      'id',
      'invoice',
      'patient',
      'prescriptionIssued',
      'scheduledAt',
      'status',
    ]);
    expect(Object.keys(toLedgerRow(source).patient).sort()).toEqual(['fullName', 'id']);
  });
});

describe('what an admin report must never contain', () => {
  /*
   * `CLAUDE.md`: admin is operational, not clinical. A management report is the
   * least-questioned route into clinical data — "revenue by department" sounds
   * like operations and, in a hospital with an oncology department, is a
   * statement about what patients attended for.
   *
   * Asserting on absence, like `patient-response.spec.ts`: checking the report
   * returns the right totals would still pass if it also returned a patient id.
   */
  /*
   * Comments are stripped first, and that is not a detail. The rule is about
   * what the code *selects*; the comments explaining the rule necessarily use
   * the same words, so a naive match fails on the prose that documents it —
   * and the obvious fix is to soften the comment, which makes the file worse in
   * order to make the test pass.
   */
  const SERVICE = readFileSync(resolve(__dirname, './admin.service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  /** The body of one method, up to the next one. */
  function method(name: string): string {
    const start = SERVICE.indexOf(`async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = SERVICE.indexOf('\n  async ', start + 10);
    return SERVICE.slice(start, next === -1 ? SERVICE.length : next);
  }

  it('strips comments before asserting, and still sees the code', () => {
    // Guards the assertions below from passing vacuously if the stripping
    // regex ever eats the method bodies too.
    expect(method('financeReport')).toContain('prisma.payment.findMany');
    expect(method('doctorsReport')).toContain('prisma.doctor.findMany');
  });

  it.each(['financeReport', 'doctorsReport', 'staffActivityReport'])(
    '%s selects no patient or clinical field',
    (name) => {
    const body = method(name);
    for (const forbidden of [
      'patientId',
      'patient:',
      'diagnosis',
      'prescription',
      'medicine',
      'medicalRecord',
      'allergy',
      ]) {
        expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    },
  );

  it('gives the owner a per-staff day without naming a single patient', () => {
    /*
     * The request this was built for: "which doctor saw how many patients, and
     * how much did we take" — plus, originally, *which* patients. That last
     * part would have made ADMIN a clinical role and broken
     * `access-matrix.spec.ts`, so it is deliberately absent.
     *
     * The answer for an owner who needs names is to switch to a clinical role
     * they hold. The audit log then records that they viewed patient data while
     * acting as a doctor, which is both honest and the thing a regulator would
     * ask for — rather than an administrative screen quietly becoming a patient
     * browser.
     */
    const body = method('staffActivityReport');

    // Staff names are the point of the report; patient identity is not.
    expect(body).toContain('fullName: true');
    expect(body).not.toMatch(/patient/i);

    // Reads the audit log for *who did what*, never for what was looked at.
    expect(body).toContain('auditLog.findMany');
    expect(body).not.toContain('targetId');
  });

  it('reads only the doctor id off an appointment, never the whole row', () => {
    /*
     * `appointment: true` would pull `patientId` into a finance report — valid
     * data, quietly crossing the line `toPatientResponse` exists to hold. The
     * select is the boundary; if it does not fetch the field, no shape can
     * accidentally leak it.
     */
    const body = method('doctorsReport');
    expect(body).toContain('appointment: { select: { doctorId: true } }');
    expect(body).not.toMatch(/appointment:\s*true/);
  });

  it('does not break revenue down by department', () => {
    // Department is on the doctor row for display. It must never become a
    // grouping key for money or counts — that is a clinical breakdown wearing
    // an operational label.
    const body = method('doctorsReport');
    expect(body).not.toMatch(/groupBy[\s\S]{0,80}department/);
  });
});
