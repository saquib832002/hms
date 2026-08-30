'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { AgingBucket, DoctorReport, FinanceReport } from '@/lib/types';
import { Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { useMoney } from '@/lib/use-money';

/**
 * The detail behind the dashboard headlines.
 *
 * WHY THIS IS A SEPARATE SCREEN
 * -----------------------------
 * The dashboard answers "is anything wrong this morning" in one glance. These
 * are the tables you open when the answer was yes, or when it is the end of the
 * month — a different question and a different amount of reading.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No patient appears here and none can be reached from here, including through
 * the money. Revenue is grouped by doctor and by payment method, never by what
 * was treated: a report broken down by department or diagnosis reads as
 * operations and is a list of what people attended for. That is the same leak
 * `consultation-billing.spec.ts` refuses in an invoice description, and a
 * management report is where it would be least questioned.
 */
export default function AdminReportsPage() {
  const fmt = useMoney();
  const [finance, setFinance] = useState<FinanceReport | null>(null);
  const [doctors, setDoctors] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [f, d] = await Promise.all([
        api<FinanceReport>('/admin/reports/finance?months=12'),
        api<DoctorReport>('/admin/reports/doctors'),
      ]);
      setFinance(f);
      setDoctors(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the reports');
    }
  }, []);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, { intervalMs: 120_000 });

  useEffect(() => {
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !finance) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-text-muted">
          Aggregates only — no patient, diagnosis or medicine appears in any figure below.{' '}
          <Link href="/admin" className="text-primary hover:underline">
            ← Dashboard
          </Link>
        </p>
        <Freshness
          lastUpdated={lastUpdated}
          refreshing={refreshing}
          onRefresh={() => void refreshNow()}
        />
      </div>

      {!finance ? <Skeleton className="h-64 w-full" /> : <Finance report={finance} fmt={fmt} />}

      <Card className="mt-3">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-md font-semibold">
            Doctors{doctors ? ` · ${doctors.total}` : ''}
          </h2>
          <Link href="/doctors" className="text-xs text-primary hover:underline">
            Set consultation fees →
          </Link>
        </div>
        {!doctors ? <Skeleton className="h-40" /> : <Doctors report={doctors} fmt={fmt} />}
      </Card>
    </div>
  );
}

/* ─────────────────────────────── finance ─────────────────────────────── */

function Finance({ report, fmt }: { report: FinanceReport; fmt: (v: string) => string }) {
  /*
   * The bar scale is the largest month in the window, so the chart is about
   * shape rather than absolute size. Computed from the string amounts by
   * comparing lengths first and characters second — a max over `Number(...)` is
   * harmless in isolation and is how float arithmetic gets a foothold in a file
   * that handles money.
   */
  const peak = report.monthly.reduce((max, m) => (biggerMoney(m.collected, max) ? m.collected : max), '0.00');

  return (
    <>
      <Card>
        <h2 className="mb-3 text-md font-semibold">Collected, last {report.monthly.length} months</h2>
        {peak === '0.00' ? (
          <p className="py-6 text-center text-sm text-text-subtle">
            No payments have been recorded yet.
          </p>
        ) : (
          <div className="flex items-end gap-1" style={{ height: 140 }}>
            {report.monthly.map((m) => (
              <div key={m.month} className="group flex flex-1 flex-col items-center justify-end">
                <div className="mb-1 whitespace-nowrap font-mono text-xxs text-text-subtle opacity-0 transition-opacity group-hover:opacity-100">
                  {fmt(m.collected)}
                </div>
                <div
                  className="w-full rounded-t-sm bg-primary transition-colors group-hover:bg-primary-hover"
                  style={{ height: `${barHeight(m.collected, peak)}%`, minHeight: 2 }}
                  title={`${m.label}: ${fmt(m.collected)} across ${m.payments} payments`}
                />
                <div className="mt-1 text-xxs text-text-subtle">{m.label.slice(0, 3)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Card>
          <h2 className="mb-2 text-md font-semibold">How the money arrived</h2>
          {/* End-of-day reconciliation: the cash drawer should hold the cash
              row and nothing else. Every method is listed even at zero — "no
              card payments today" and "the card row is missing" look the same
              otherwise. */}
          <Table head={['Method', 'Today', 'This month']}>
            {report.methods.map((m) => (
              <tr key={m.method}>
                <Td>{titleiseMethod(m.method)}</Td>
                <Td mono muted={m.today.count === 0}>
                  {fmt(m.today.amount)}
                  {m.today.count > 0 && (
                    <span className="ml-1 text-text-subtle">×{m.today.count}</span>
                  )}
                </Td>
                <Td mono muted={m.month.count === 0}>
                  {fmt(m.month.amount)}
                  {m.month.count > 0 && (
                    <span className="ml-1 text-text-subtle">×{m.month.count}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-md font-semibold">Outstanding by age</h2>
            <Link href="/billing/invoices" className="text-xs text-primary hover:underline">
              Invoices →
            </Link>
          </div>
          <Table head={['Age', 'Invoices', 'Amount']}>
            {(Object.keys(report.aging.buckets) as AgingBucket[]).map((key) => {
              const bucket = report.aging.buckets[key];
              return (
                <tr key={key}>
                  <Td>{bucket.label}</Td>
                  <Td mono muted={bucket.count === 0}>
                    {bucket.count}
                  </Td>
                  <Td
                    mono
                    muted={bucket.count === 0}
                    // Anything past 90 days is the row a clinic acts on, so it
                    // is the one that should not read like the others.
                    className={key === 'over90' && bucket.count > 0 ? 'font-semibold text-danger' : ''}
                  >
                    {fmt(bucket.amount)}
                  </Td>
                </tr>
              );
            })}
            <tr>
              <Td className="pt-2 font-semibold">Total owed</Td>
              <Td />
              <Td mono className="pt-2 font-semibold">
                {fmt(report.aging.totalOutstanding)}
              </Td>
            </tr>
          </Table>
        </Card>
      </div>
    </>
  );
}

/* ─────────────────────────────── doctors ─────────────────────────────── */

function Doctors({ report, fmt }: { report: DoctorReport; fmt: (v: string) => string }) {
  if (report.doctors.length === 0) {
    return <p className="py-6 text-center text-sm text-text-subtle">No doctors registered.</p>;
  }

  return (
    <>
      {report.withoutFee > 0 && (
        /* Named rather than merely counted: reception's checkout refuses for
           these, and the receptionist discovers it standing in front of the
           patient. */
        <div className="mb-2 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-xs text-[#6b5314]">
          {report.withoutFee} {report.withoutFee === 1 ? 'doctor has' : 'doctors have'} no
          consultation fee set. Reception cannot raise an invoice for them.
        </div>
      )}
      <Table
        head={[
          'Doctor',
          'Fee',
          'Today',
          '7 days',
          'No-shows 7d',
          'Billed this month',
          'Collected',
        ]}
      >
        {report.doctors.map((d) => (
          <tr key={d.id} className="hover:bg-[#fafbfc]">
            <Td>
              <div className="font-medium">{d.fullName}</div>
              <div className="text-xxs text-text-subtle">
                {d.specialization}
                {d.department ? ` · ${d.department}` : ''}
              </div>
            </Td>
            <Td mono>
              {d.consultationFee === null ? (
                <span className="text-warning">Not set</span>
              ) : (
                fmt(d.consultationFee)
              )}
            </Td>
            <Td mono>
              {d.today.completed}/{d.today.booked}
            </Td>
            <Td mono>
              {d.lastSevenDays.completed}/{d.lastSevenDays.booked}
            </Td>
            <Td mono muted={d.lastSevenDays.noShow === 0}>
              {d.lastSevenDays.noShow}
            </Td>
            <Td mono>{fmt(d.revenueThisMonth.billed)}</Td>
            {/* Billed and collected sit side by side on purpose. Payment is not
                required before a consultation, so the gap between them is real
                and is the number worth watching. */}
            <Td
              mono
              className={
                d.revenueThisMonth.collected !== d.revenueThisMonth.billed ? 'text-warning' : ''
              }
            >
              {fmt(d.revenueThisMonth.collected)}
            </Td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 text-xxs text-text-subtle">
        Today and 7 days show completed / booked. Revenue covers consultations invoiced this
        calendar month in {report.timezone}.
      </p>
    </>
  );
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/**
 * Compares two canonical money strings without turning either into a number.
 *
 * Both are `fromMinor` output, so they always have exactly two decimals and no
 * separators. That makes "longer string wins, otherwise lexicographic" exactly
 * right for non-negative amounts, and it keeps `Number()` out of a file that
 * handles money — the comparison is harmless, the habit is not.
 */
function biggerMoney(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

/** Bar height as a percentage of the tallest month, in integer minor units. */
function barHeight(value: string, peak: string): number {
  const toMinor = (v: string) => Number(v.replace('.', ''));
  const max = toMinor(peak);
  if (max === 0) return 0;
  // Integer minor units, so this is a ratio of two integers rather than of two
  // floats — and it is a pixel height, not an amount anybody reads.
  return Math.round((toMinor(value) / max) * 100);
}

function titleiseMethod(method: string): string {
  return method
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              className="border-b border-border pb-1 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Td({
  children,
  mono,
  muted,
  className = '',
}: {
  children?: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`border-b border-[#f0f2f4] py-1.5 ${mono ? 'font-mono text-xs' : ''} ${
        muted ? 'text-text-subtle' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}
