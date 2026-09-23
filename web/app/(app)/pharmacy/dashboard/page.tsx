'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { PharmacyDashboard } from '@/lib/types';
import { useMoney } from '@/lib/use-money';
import { ErrorState, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * What this pharmacy sold, took and gave back.
 *
 * WHY THE PHARMACY HAS ITS OWN RATHER THAN USING THE ADMIN DASHBOARD
 * -----------------------------------------------------------------
 * In SEPARATE billing mode these are two businesses, and the admin dashboard
 * deliberately reports the shop's takings *beside* the hospital's rather than
 * inside them. A pharmacist looking there sees either nothing of their own or
 * their figures mixed with consultations.
 *
 * The questions differ too. An owner asks what the clinic collected; a
 * pharmacist asks what left the shelf, what came back, and whether anything
 * went out unpriced — and that last one is the number nothing else surfaces
 * daily. It is how a month of unbilled stock happens.
 *
 * EVERY FIGURE CARRIES ITS REVERSAL
 * ---------------------------------
 * Billed and refunded are shown separately and the net is derived. "Sales
 * minus refunds" as one number is the figure nobody can reconcile against a
 * till, and two screens disagreeing about one day is worse than either being
 * wrong alone — which is exactly what happened to the admin finance report
 * before it was rewritten.
 */
const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
] as const;

export default function PharmacyDashboardPage() {
  const money = useMoney();
  const [data, setData] = useState<PharmacyDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api<PharmacyDashboard>('/pharmacy/dashboard'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the pharmacy figures');
    }
  }, []);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text">Pharmacy</h1>
          <p className="text-sm text-text-muted">
            Sales, takings and returns. Dates follow this hospital&rsquo;s clock.
          </p>
        </div>
        <div className="ml-auto">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      {!data ? (
        <TableSkeleton rows={4} />
      ) : (
        <>
          {/*
            Outstanding is not windowed. An unpaid sale from last week is still
            money owed today, and a figure that dropped it at midnight would
            quietly understate what the till is short.
          */}
          {Number(data.outstanding) > 0 && (
            <Link
              href="/pharmacy/invoices"
              className="mb-4 flex max-w-3xl items-baseline justify-between rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm hover:border-warning"
            >
              <span className="text-[#6b5314]">
                <strong>Unpaid at this counter</strong> — all time, not just today
              </span>
              <span className="font-mono font-semibold text-[#6b5314]">
                {money(data.outstanding)} →
              </span>
            </Link>
          )}

          <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
            {PERIODS.map(({ key, label }) => {
              const p = data.periods.find((x) => x.period === key);
              if (!p) return null;
              return (
                <div key={key} className="rounded-md border border-border bg-surface p-3">
                  <div className="text-xs uppercase tracking-wide text-text-subtle">{label}</div>

                  {/*
                    Net is the headline because it is the figure billing and
                    the owner both see. Gross sits under it so the two can be
                    reconciled rather than taken on trust.
                  */}
                  <div className="mt-1 font-mono text-xl font-semibold text-text">
                    {money(p.net)}
                  </div>
                  <div className="text-xxs text-text-subtle">collected, net of refunds</div>

                  <dl className="mt-2.5 space-y-0.5 border-t border-border pt-2 text-xs">
                    <Row label="Billed" value={money(p.billed)} />
                    {Number(p.tax) > 0 && <Row label="of which tax" value={money(p.tax)} muted />}
                    <Row label="Collected" value={money(p.collected)} />
                    {Number(p.refunded) > 0 && (
                      <Row label="Refunded" value={`− ${money(p.refunded)}`} tone="danger" />
                    )}
                  </dl>

                  <dl className="mt-2 space-y-0.5 border-t border-border pt-2 text-xs">
                    <Row label="Sales" value={String(p.sales)} />
                    {/*
                      Reversals are counted apart from sales, never subtracted
                      from them: a reversal means the medicine never left, so
                      counting it as a sale and again as a return would
                      double-count something that did not happen.
                    */}
                    {p.reversals > 0 && (
                      <Row label="Reversed" value={String(p.reversals)} tone="danger" />
                    )}
                    {/*
                      The number nothing else surfaces daily. A handover with
                      no price still leaves the shelf, and the loss is found a
                      month later in a report unless it is said here.
                    */}
                    {p.unpricedSales > 0 && (
                      <Row
                        label="Handed over unpriced"
                        value={String(p.unpricedSales)}
                        tone="warning"
                      />
                    )}
                  </dl>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex max-w-3xl flex-wrap gap-3 text-sm">
            <Link href="/pharmacy/invoices" className="text-primary hover:underline">
              Every invoice this pharmacy has raised →
            </Link>
            <Link href="/pharmacy/inventory" className="text-primary hover:underline">
              Stock and expiry →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'warning';
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={muted ? 'text-text-subtle' : 'text-text-muted'}>{label}</dt>
      <dd
        className={`font-mono ${
          tone === 'danger'
            ? 'text-danger'
            : tone === 'warning'
              ? 'text-warning'
              : muted
                ? 'text-text-subtle'
                : 'text-text'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
