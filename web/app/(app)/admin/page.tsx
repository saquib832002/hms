'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { ActivityReport, AdminDashboard, StaffReport } from '@/lib/types';
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, a, s] = await Promise.all([
        api<AdminDashboard>('/admin/dashboard'),
        api<ActivityReport>('/admin/reports/activity?days=7'),
        api<StaffReport>('/admin/reports/staff'),
      ]);
      setDashboard(d);
      setActivity(a);
      setStaff(s);
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
          Operational figures only — no patient data is reachable from this screen.
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
            <Metric
              label="Appointments today"
              value={dashboard.appointments.today}
              sub={`${dashboard.appointments.completedToday} completed`}
            />
            <Metric
              label="Bed occupancy"
              value={`${dashboard.occupancy.percent}%`}
              sub={`${dashboard.occupancy.occupied} of ${dashboard.occupancy.beds} beds`}
              tone={dashboard.occupancy.percent > 90 ? 'danger' : undefined}
            />
            <Metric
              label="Outstanding"
              value={fmt(dashboard.finance.outstanding)}
              sub={`${dashboard.finance.openInvoices} open invoices`}
              mono
            />
            <Metric
              label="Collected, 7 days"
              value={fmt(dashboard.finance.collectedLastSevenDays)}
              tone="success"
              mono
            />
          </div>

          <div className="mt-3 grid grid-cols-4 gap-3">
            <Metric
              label="No-show rate, 7 days"
              value={`${dashboard.appointments.noShowRate}%`}
              sub={`${dashboard.appointments.noShowsLastSevenDays} of ${dashboard.appointments.lastSevenDays}`}
              tone={dashboard.appointments.noShowRate > 15 ? 'warning' : undefined}
            />
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
