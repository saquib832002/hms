'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, ErrorState, Select, TableSkeleton } from '@/components/ui/primitives';

// Moved to lib/types.ts when mobile gained the same drill-down — a shape both
// clients read has to be one declaration under the drift test, not two.
import type { AuditRow } from '@/lib/types';

/**
 * The compliance payoff for building the audit interceptor in Phase 0.
 *
 * Failures are shown alongside successes — a receptionist walking sequential
 * patient IDs against a clinical endpoint produces nothing but 403s, and is
 * invisible if you only log what worked.
 */
export default function AuditPage() {
  return (
    <Suspense fallback={<TableSkeleton cols={7} />}>
      <AuditBrowser />
    </Suspense>
  );
}

/** The day after `YYYY-MM-DD`, computed on the string so no zone can shift it. */
function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * `?userId=` and `?date=` are how the daily activity screen hands over.
 *
 * The scoped view is the point: "what did this person do on this day" is the
 * question an owner actually asks, and answering it by scrolling a hundred
 * mixed rows is not answering it. The filter is applied server-side, so a
 * narrowed log is a narrower query rather than a wider one hidden by the UI.
 */
function AuditBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const userId = params.get('userId');
  const date = params.get('date');

  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '100' });
      if (outcome) qs.set('outcome', outcome);
      if (userId) qs.set('userId', userId);
      if (date) {
        /*
         * A whole local day, sent as an instant range.
         *
         * `to` is the start of the following day and the API compares with
         * `lt`, so an action logged at exactly midnight belongs to one day
         * rather than both — the same boundary rule as every other day range
         * in this system.
         */
        qs.set('from', `${date}T00:00:00`);
        qs.set('to', `${nextDay(date)}T00:00:00`);
      }
      const res = await api<{ data: AuditRow[] }>(`/audit?${qs}`);
      setRows(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log');
    }
  }, [outcome, userId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2">
        <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="w-auto text-sm">
          <option value="">All outcomes</option>
          <option value="SUCCESS">Success only</option>
          <option value="FAILURE">Failures only</option>
        </Select>
        <Button size="sm" onClick={() => void load()}>
          Refresh
        </Button>

        {/* The active scope is stated and clearable. A filtered log that looks
            like the whole log is how someone concludes a quiet afternoon was a
            quiet day. */}
        {(userId || date) && (
          <div className="flex items-center gap-2 rounded-full border border-primary bg-primary-soft px-3 py-0.5 text-xs">
            <span>
              {rows?.[0]?.user?.fullName ?? (userId ? `User #${userId}` : 'All staff')}
              {date ? ` · ${date}` : ''}
            </span>
            <button
              onClick={() => router.replace('/audit')}
              className="font-semibold text-primary hover:underline"
            >
              clear
            </button>
          </div>
        )}

        <span className="text-xs text-text-muted">{rows?.length ?? 0} entries</span>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!rows && <TableSkeleton cols={7} />}
        {rows && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Timestamp', 'User', 'Role', 'Action', 'Target', 'IP', 'Outcome'].map((h) => (
                  <th
                    key={h}
                    className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.outcome === 'FAILURE' ? 'bg-danger-soft' : 'hover:bg-[#fafbfc]'}>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5 font-mono text-xs">
                    {dateTime(r.createdAt)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5">
                    {r.user?.fullName ?? r.actorEmail ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5 text-xs text-text-muted">
                    {r.user?.role ?? r.actorRole ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5 font-mono text-xs">{r.action}</td>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5 font-mono text-xs text-text-muted">
                    {r.targetType ? `${r.targetType} #${r.targetId}` : '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5 font-mono text-xs text-text-muted">
                    {r.ipAddress ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xxs font-semibold ${
                        r.outcome === 'SUCCESS'
                          ? 'bg-success-soft text-success'
                          : 'bg-danger-soft text-danger'
                      }`}
                    >
                      {r.outcome === 'SUCCESS' ? 'Success' : `${r.statusCode ?? ''} Denied`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
