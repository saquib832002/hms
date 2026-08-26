import { bucketFor, buildAgingReport, daysOverdue } from './aging';

const NOW = new Date('2026-08-17T14:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('daysOverdue', () => {
  it('is zero for an invoice with no due date', () => {
    // No agreed terms is not the same as 90 days late. Treating null as
    // overdue would drop every invoice awaiting terms into the worst bucket.
    expect(daysOverdue(null, NOW)).toBe(0);
  });

  it('is zero for an invoice due in the future', () => {
    expect(daysOverdue(new Date(NOW.getTime() + 5 * 86_400_000), NOW)).toBe(0);
  });

  it('is zero on the due date itself', () => {
    // Due at 09:00 today is due today, not 0.2 days late.
    expect(daysOverdue(new Date('2026-08-17T09:00:00Z'), NOW)).toBe(0);
  });

  it('is zero even when due later today', () => {
    expect(daysOverdue(new Date('2026-08-17T23:00:00Z'), NOW)).toBe(0);
  });

  it('counts whole days from the day after', () => {
    expect(daysOverdue(daysAgo(1), NOW)).toBe(1);
    expect(daysOverdue(daysAgo(45), NOW)).toBe(45);
  });

  it('ignores the time of day', () => {
    // Aging that changes as the clock moves through the afternoon is aging
    // nobody trusts.
    expect(daysOverdue(new Date('2026-08-10T23:59:00Z'), NOW)).toBe(7);
    expect(daysOverdue(new Date('2026-08-10T00:01:00Z'), NOW)).toBe(7);
  });
});

describe('bucketFor', () => {
  it.each([
    [null, 'current'],
    [0, 'current'],
    [1, 'd1to30'],
    [30, 'd1to30'],
    [31, 'd31to60'],
    [60, 'd31to60'],
    [61, 'd61to90'],
    [90, 'd61to90'],
    [91, 'over90'],
    [400, 'over90'],
  ])('%s days overdue falls in %s', (days, expected) => {
    const dueDate = days === null ? null : daysAgo(days as number);
    expect(bucketFor(dueDate, NOW)).toBe(expected);
  });

  it('puts a future due date in current', () => {
    expect(bucketFor(new Date(NOW.getTime() + 10 * 86_400_000), NOW)).toBe('current');
  });
});

describe('buildAgingReport', () => {
  const invoices = [
    { id: 1, dueDate: new Date(NOW.getTime() + 5 * 86_400_000), outstandingMinor: 100_00 },
    { id: 2, dueDate: daysAgo(10), outstandingMinor: 250_00 },
    { id: 3, dueDate: daysAgo(45), outstandingMinor: 380_00 },
    { id: 4, dueDate: daysAgo(75), outstandingMinor: 120_00 },
    { id: 5, dueDate: daysAgo(200), outstandingMinor: 670_00 },
  ];

  it('places each invoice in exactly one bucket', () => {
    const report = buildAgingReport(invoices, NOW);
    const counts = Object.values(report.buckets).reduce((n, b) => n + b.count, 0);
    expect(counts).toBe(invoices.length);
  });

  it('totals each bucket as an exact string', () => {
    const report = buildAgingReport(invoices, NOW);
    expect(report.buckets.current.amount).toBe('100.00');
    expect(report.buckets.d1to30.amount).toBe('250.00');
    expect(report.buckets.d31to60.amount).toBe('380.00');
    expect(report.buckets.d61to90.amount).toBe('120.00');
    expect(report.buckets.over90.amount).toBe('670.00');
  });

  it('totals everything outstanding', () => {
    expect(buildAgingReport(invoices, NOW).totalOutstanding).toBe('1520.00');
  });

  it('separates overdue from not-yet-due', () => {
    // The number a finance office chases is the overdue one.
    expect(buildAgingReport(invoices, NOW).totalOverdue).toBe('1420.00');
  });

  it('excludes settled invoices entirely', () => {
    // A paid invoice has nothing outstanding; counting it would pad every
    // bucket with zeroes and make the counts meaningless.
    const report = buildAgingReport(
      [...invoices, { id: 6, dueDate: daysAgo(300), outstandingMinor: 0 }],
      NOW,
    );
    expect(report.buckets.over90.count).toBe(1);
    expect(report.totalOutstanding).toBe('1520.00');
  });

  it('returns zeroed buckets for an empty ledger rather than omitting them', () => {
    const report = buildAgingReport([], NOW);
    expect(report.totalOutstanding).toBe('0.00');
    expect(report.buckets.over90).toEqual({
      label: 'Over 90 days',
      count: 0,
      amount: '0.00',
    });
  });

  it('labels every bucket', () => {
    const report = buildAgingReport(invoices, NOW);
    for (const bucket of Object.values(report.buckets)) {
      expect(bucket.label).toBeTruthy();
    }
  });

  it('does not drift when summing many small balances', () => {
    const many = Array.from({ length: 333 }, (_, i) => ({
      id: i,
      dueDate: daysAgo(5),
      outstandingMinor: 3,
    }));
    expect(buildAgingReport(many, NOW).totalOutstanding).toBe('9.99');
  });
});
