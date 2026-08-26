'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, ErrorState, Select, TableSkeleton } from '@/components/ui/primitives';

interface AuditRow {
  id: number;
  createdAt: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  method: string | null;
  targetType: string | null;
  targetId: number | null;
  outcome: 'SUCCESS' | 'FAILURE';
  statusCode: number | null;
  ipAddress: string | null;
  user: { id: number; fullName: string; email: string; role: string } | null;
}

/**
 * The compliance payoff for building the audit interceptor in Phase 0.
 *
 * Failures are shown alongside successes — a receptionist walking sequential
 * patient IDs against a clinical endpoint produces nothing but 403s, and is
 * invisible if you only log what worked.
 */
export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '100' });
      if (outcome) qs.set('outcome', outcome);
      const res = await api<{ data: AuditRow[] }>(`/audit?${qs}`);
      setRows(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log');
    }
  }, [outcome]);

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
