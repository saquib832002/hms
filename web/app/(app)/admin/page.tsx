'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type {
  ActivityReport,
  AdminDashboard,
  FinanceReport,
  StaffReport,
  TenantModule,
} from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { titleCase } from '@/lib/format';
import { Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { useMoney } from '@/lib/use-money';

/**
 * Administrator dashboard.
 *
 * Aggregates only — no patient appears anywhere on this screen, and none can be
 * reached from it. A management dashboard is the obvious back door into clinical
 * data ("occupancy by diagnosis" sounds operational and is a list of who has
 * what), so the figures here are deliberately restricted to ones that carry no
 * clinical meaning.
 */
export default function AdminDashboardPage() {
  const fmt = useMoney();
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [activity, setActivity] = useState<ActivityReport | null>(null);
  const [staff, setStaff] = useState<StaffReport | null>(null);
  const [finance, setFinance] = useState<FinanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();
  /*
   * The dashboard is the floor — every tenant has one — but almost every tile
   * on it belonged to a module. A pharmacy-only tenant's owner opened this and
   * read appointments, bed occupancy and a doctor count, all zero, with nothing
   * about the shop they run. Zeroes for something you were never sold read as a
   * broken system rather than as a quiet default.
   */
  const has = (m: TenantModule) => user?.hospital.modules.includes(m) ?? true;
  const clinic = has('CLINIC');
  const wards = has('WARDS');
  const billing = has('BILLING');
  const pharmacy = has('PHARMACY');
  const laboratory = has('LABORATORY');

  const load = useCallback(async () => {
    setError(null);
    try {
      // Only three months of trend are needed for the headline figures; the
      // full twelve are fetched by the Reports screen, which actually draws it.
      const [d, a, s, f] = await Promise.all([
        api<AdminDashboard>('/admin/dashboard'),
        api<ActivityReport>('/admin/reports/activity?days=7'),
        api<StaffReport>('/admin/reports/staff'),
        api<FinanceReport>('/admin/reports/finance?months=3'),
      ]);
      setDashboard(d);
      setActivity(a);
      setStaff(s);
      setFinance(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the dashboard');
    }
  }, []);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, { intervalMs: 60_000 });

  useEffect(() => {
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !dashboard) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-text-muted">
          Operational figures only — no patient data is reachable from this screen.{' '}
          <Link href="/admin/reports" className="text-primary hover:underline">
            Full reports →
          </Link>
        </p>
        <Freshness
          lastUpdated={lastUpdated}
          refreshing={refreshing}
          onRefresh={() => void refreshNow()}
        />
      </div>

      {!dashboard ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3">
            {clinic && (
              <Metric
                label="Appointments today"
                value={dashboard.appointments.today}
                sub={`${dashboard.appointments.completedToday} completed`}
              />
            )}
            {wards && (
              <Metric
                label="Bed occupancy"
                value={`${dashboard.occupancy.percent}%`}
                sub={`${dashboard.occupancy.occupied} of ${dashboard.occupancy.beds} beds`}
                tone={dashboard.occupancy.percent > 90 ? 'danger' : undefined}
              />
            )}
            {/*
              Today's trade, first on the screen for a shop.

              A standalone pharmacy's owner opens this to ask one question —
              what went out today, and did any of it go out unpriced. That was
              previously not on the screen at all.
            */}
            {pharmacy && (
              <Metric
                label="Dispensed today"
                value={dashboard.pharmacy.dispensesToday}
                tone={dashboard.pharmacy.unpricedSalesToday > 0 ? 'warning' : undefined}
                sub={
                  dashboard.pharmacy.unpricedSalesToday > 0
                    ? `${dashboard.pharmacy.unpricedSalesToday} went out unpriced`
                    : `${dashboard.pharmacy.reversalsToday} reversed`
                }
              />
            )}
            {/*
              Resulted-but-not-authorised is the backlog worth leading with: the
              work looks finished from the bench and is invisible to the doctor
              who asked, because unverified values are deliberately withheld.
            */}
            {laboratory && (
              <Metric
                label="Tests ordered today"
                value={dashboard.laboratory.ordersToday}
                tone={dashboard.laboratory.awaitingAuthorisation > 0 ? 'warning' : undefined}
                sub={`${dashboard.laboratory.awaitingAuthorisation} awaiting authorisation`}
              />
            )}
            {/* Takings, counted from payments received today — not from
                invoices raised today, which is a different number and the one
                this dashboard used to show. */}
            {/*
              NET is the headline, not gross.
              -----------------------------
              This showed `collected.today`, so a £500 payment refunded in full
              still read as £500 taken — while billing's payments ledger, which
              is signed, showed nothing for the same day. Two screens
              disagreeing about one day is worse than either being wrong alone,
              because it makes both unusable.

              The gross pair stays in the subtitle rather than disappearing:
              reconciling against a bank statement needs it, since a day that
              took 5,000 and refunded 500 is not the same day as one that took
              4,500.
            */}
            {billing && (
            <Metric
              label="Kept today"
              value={finance ? fmt(finance.net.today) : '—'}
              sub={
                finance
                  ? `${fmt(finance.collected.today)} in · ${fmt(finance.refunded.today)} back · ${finance.collected.paymentsToday} payments`
                  : undefined
              }
              tone="success"
              mono
            />
            )}
            {billing && (
            <Metric
              label="Kept this month"
              value={finance ? fmt(finance.net.thisMonth) : '—'}
              sub={
                finance
                  ? `${fmt(finance.collected.thisMonth)} in · ${fmt(finance.refunded.thisMonth)} back`
                  : undefined
              }
              mono
            />
            )}
          </div>

          <div className="mt-3 grid grid-cols-4 gap-3">
            {billing && (
            <Metric
              label="Outstanding"
              value={fmt(dashboard.finance.outstanding)}
              sub={`${dashboard.finance.openInvoices} open · ${
                finance ? fmt(finance.aging.totalOverdue) : '—'
              } overdue`}
              // Compared as a string. `Number("1234.50") > 0` works and is the
              // habit that later becomes `Number(a) + Number(b)` — money never
              // becomes a float in this codebase, not even for a comparison.
              tone={finance && finance.aging.totalOverdue !== '0.00' ? 'warning' : undefined}
              mono
            />
            )}
            {clinic && (
            <Metric
              label="No-show rate, 7 days"
              value={`${dashboard.appointments.noShowRate}%`}
              sub={`${dashboard.appointments.noShowsLastSevenDays} of ${dashboard.appointments.lastSevenDays}`}
              tone={dashboard.appointments.noShowRate > 15 ? 'warning' : undefined}
            />
            )}
            {/* Unpriced doctors are a dashboard item because they break
                reception's checkout — the receptionist finds out standing in
                front of a patient, which is the worst place to find out. */}
            {clinic && (
            <Metric
              label="Doctors"
              value={dashboard.staff.doctors}
              tone={dashboard.staff.doctorsWithoutFee > 0 ? 'warning' : undefined}
              sub={
                dashboard.staff.doctorsWithoutFee > 0
                  ? `${dashboard.staff.doctorsWithoutFee} with no fee set`
                  : 'all priced'
              }
            />
            )}
            {/*
              The lab's own queue, beside the hospital's figures rather than
              inside them. Ordered-but-not-collected is what blocks everything
              downstream, and it is the queue a patient is physically waiting in.
            */}
            {laboratory && (
              <Metric
                label="Awaiting collection"
                value={dashboard.laboratory.awaitingCollection}
                tone={dashboard.laboratory.awaitingCollection > 0 ? 'warning' : undefined}
                sub={`${dashboard.laboratory.onTheBench} on the bench`}
              />
            )}
          </div>

          <div className="mt-3 grid grid-cols-4 gap-3">
            <Metric label="Active staff" value={dashboard.staff.active} />
            <Metric
              label="Locked out"
              value={dashboard.staff.lockedOut}
              tone={dashboard.staff.lockedOut > 0 ? 'warning' : undefined}
              sub={
                dashboard.staff.awaitingPasswordChange > 0
                  ? `${dashboard.staff.awaitingPasswordChange} awaiting password change`
                  : undefined
              }
            />
            {/* The security signal worth looking at daily. A spike is either a
                misconfigured client or someone probing. */}
            <Metric
              label="Denied requests, 24h"
              value={dashboard.security.deniedRequestsLastDay}
              tone={dashboard.security.deniedRequestsLastDay > 20 ? 'danger' : undefined}
              sub="See the audit log"
            />
            {/* Returned by the API since the dashboard was written and rendered
                nowhere until now. Beds free is the other one an admin actually
                acts on — an occupancy percentage does not tell you whether the
                next admission has somewhere to go. */}
            {wards && (
              <Metric
                label="Beds available"
                value={dashboard.occupancy.available}
                tone={dashboard.occupancy.available === 0 ? 'danger' : undefined}
              />
            )}
            {/*
              The catalogue moved off the beds tile, where it was a subtitle on
              an unrelated number. Unpriced medicines belong beside the count for
              the same reason unpriced doctors do: blank is not zero, and the
              first symptom is a month of stock that was never charged for.
            */}
            {pharmacy && (
              <Metric
                label="Medicines"
                value={dashboard.catalogue.medicines}
                tone={dashboard.catalogue.withoutPrice > 0 ? 'warning' : undefined}
                sub={
                  dashboard.catalogue.withoutPrice > 0
                    ? `${dashboard.catalogue.withoutPrice} with no price`
                    : 'all priced'
                }
              />
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Card>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-md font-semibold">Activity by role, 7 days</h2>
                <Link href="/audit" className="text-xs text-primary hover:underline">
                  Audit log →
                </Link>
              </div>
              {!activity ? (
                <Skeleton className="h-32" />
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {['Role', 'Actions', 'Denied'].map((h) => (
                        <th
                          key={h}
                          className="border-b border-border pb-1 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activity.byRole.map((r) => (
                      <tr key={r.role}>
                        <td className="border-b border-[#f0f2f4] py-1.5">{titleCase(r.role)}</td>
                        <td className="border-b border-[#f0f2f4] py-1.5 font-mono text-xs">
                          {r.total}
                        </td>
                        <td
                          className={`border-b border-[#f0f2f4] py-1.5 font-mono text-xs ${
                            r.denied > 0 ? 'font-semibold text-danger' : 'text-text-subtle'
                          }`}
                        >
                          {r.denied}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-md font-semibold">Staff</h2>
                <Link href="/admin/users" className="text-xs text-primary hover:underline">
                  Manage →
                </Link>
              </div>
              {!staff ? (
                <Skeleton className="h-32" />
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {['Role', 'Active', 'Dormant 30d'].map((h) => (
                        <th
                          key={h}
                          className="border-b border-border pb-1 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {staff.roles
                      .filter((r) => r.total > 0)
                      .map((r) => (
                        <tr key={r.role}>
                          <td className="border-b border-[#f0f2f4] py-1.5">{titleCase(r.role)}</td>
                          <td className="border-b border-[#f0f2f4] py-1.5 font-mono text-xs">
                            {r.active}
                          </td>
                          {/* A dormant account is an access-control problem,
                              not an HR one — nobody notices it being used. */}
                          <td
                            className={`border-b border-[#f0f2f4] py-1.5 font-mono text-xs ${
                              r.dormant > 0 ? 'text-warning' : 'text-text-subtle'
                            }`}
                          >
                            {r.dormant}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          {activity && (
            <Card className="mt-3">
              <h2 className="mb-2 text-md font-semibold">Most frequent actions, 7 days</h2>
              <div className="flex flex-wrap gap-1.5">
                {activity.topActions.map((a) => (
                  <span
                    key={a.action}
                    className="rounded-sm border border-border bg-bg px-2 py-0.5 font-mono text-xxs"
                  >
                    {a.action} · {a.count}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
  mono,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'success' | 'warning' | 'danger';
  mono?: boolean;
}) {
  const colour =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text';
  return (
    <Card>
      <div className={`text-2xl font-bold tracking-tight ${colour} ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
      <div className="text-xxs uppercase tracking-wider text-text-muted">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-text-subtle">{sub}</div>}
    </Card>
  );
}
