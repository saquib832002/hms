'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Appointment, AppointmentStatus } from '@/lib/types';
import { isoDate, longDate, time } from '@/lib/format';
import { Button, ErrorState, EmptyState, TableSkeleton } from '@/components/ui/primitives';
import { StatusChip } from '@/components/ui/status-chip';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Reception's landing screen.
 *
 * Full-width table, no detail pane — this is a scan-and-act screen, not a
 * reading screen. One click per row and no confirmation dialogs for routine
 * status changes; a receptionist does this forty times a morning.
 */
export default function CheckInPage() {
  const [date, setDate] = useState(isoDate());
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [noShow, setNoShow] = useState<Appointment | null>(null);

  // Does NOT clear `rows` — this runs every 15 seconds, and blanking the table
  // to a skeleton on each tick would make the screen flicker constantly.
  // Stale-but-visible beats a flashing empty table.
  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: Appointment[] }>(`/appointments?date=${date}`);
      setRows(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the queue');
    }
  }, [date]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, { enabled: !noShow });

  useEffect(() => {
    // Changing the day is the one case where the old rows are wrong rather
    // than merely stale, so clear them and show the skeleton.
    setRows(null);
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function setStatus(id: number, status: AppointmentStatus) {
    setBusyId(id);
    setError(null);
    try {
      const updated = await api<Appointment>(`/appointments/${id}/status`, {
        method: 'PATCH',
        body: { status },
      });
      setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, ...updated } : r)) ?? null);
    } catch (err) {
      // The server owns the status machine. If it rejects a transition, show
      // its reason rather than guessing — the UI does not re-implement the rules.
      setError(err instanceof ApiError ? err.message : 'Could not update that appointment');
    } finally {
      setBusyId(null);
    }
  }

  // j/k to move, Enter to check in — reception works by keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rows?.length) return;
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.key === 'j') setCursor((c) => Math.min(c + 1, rows.length - 1));
      if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      if (e.key === 'Enter') {
        const row = rows[cursor];
        if (row?.status === 'SCHEDULED') void setStatus(row.id, 'CHECKED_IN');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cursor]);

  const count = (s: AppointmentStatus) => rows?.filter((r) => r.status === s).length ?? 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <Stat label="Today" value={rows?.length ?? '—'} />
        <Stat label="Awaiting arrival" value={count('SCHEDULED')} tone="warning" />
        <Stat label="Checked in" value={count('CHECKED_IN')} tone="success" />
        <Stat label="No-show" value={count('NO_SHOW')} tone="danger" />

        <div className="ml-auto flex items-center gap-2">
          <Freshness lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={() => void refreshNow()} />
          <span className="text-xs text-text-muted">{longDate(new Date(`${date}T12:00:00`))}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-sm border border-border-strong bg-surface px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {error && (
          <div role="alert" className="border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]">
            {error}
          </div>
        )}

        {!rows && !error && <TableSkeleton cols={6} />}
        {rows && rows.length === 0 && (
          <EmptyState title="No appointments for this day" description="Nothing is booked yet." />
        )}
        {!rows && error && <ErrorState message={error} onRetry={() => void load()} />}

        {rows && rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Time', 'Patient', 'ID', 'Doctor', 'Reason', 'Status', 'Actions'].map((h) => (
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
              {rows.map((a, i) => (
                <tr
                  key={a.id}
                  onMouseEnter={() => setCursor(i)}
                  className={i === cursor ? 'bg-primary-soft' : 'hover:bg-[#fafbfc]'}
                >
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    {time(a.scheduledAt)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                    {a.patient?.fullName ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    #{a.patient?.id}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">{a.doctor?.fullName ?? '—'}</td>
                  {/* The booking reason reception typed — not a diagnosis. */}
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-text-muted">
                    {a.reason ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">
                    <StatusChip status={a.status} />
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">
                    {a.status === 'SCHEDULED' ? (
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busyId === a.id}
                          onClick={() => void setStatus(a.id, 'CHECKED_IN')}
                        >
                          Check in
                        </Button>
                        {/* Check-in stays one click — it is routine and
                            reversible in practice. No-show is neither: it is
                            terminal, and marking the wrong row means a patient
                            sitting in the waiting room is recorded as absent. */}
                        <Button size="sm" disabled={busyId === a.id} onClick={() => setNoShow(a)}>
                          No-show
                        </Button>
                      </div>
                    ) : (
                      <span className="text-text-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={noShow !== null}
        title="Mark as no-show?"
        consequence={
          noShow
            ? `${noShow.patient?.fullName ?? 'This patient'} will be recorded as not having attended. This is final — if they arrive later, they need a new appointment.`
            : ''
        }
        confirmLabel="Mark no-show"
        busy={busyId === noShow?.id}
        onConfirm={() => {
          if (noShow) void setStatus(noShow.id, 'NO_SHOW');
          setNoShow(null);
        }}
        onCancel={() => setNoShow(null)}
      />

      <div className="shrink-0 border-t border-border bg-surface px-4 py-1 text-xxs text-text-subtle">
        <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move ·{' '}
        <kbd className="font-mono">⏎</kbd> check in · <kbd className="font-mono">⌘K</kbd> search
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'warning' | 'success' | 'danger';
}) {
  const colour =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'success'
        ? 'text-success'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text';
  return (
    <div>
      <div className={`text-lg font-bold tracking-tight ${colour}`}>{value}</div>
      <div className="text-xxs uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}
