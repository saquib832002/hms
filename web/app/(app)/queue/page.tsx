'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { DoctorQueue, MedicalRecord, Patient, QueueItem } from '@/lib/types';
import { date as fmtDate, isoDate, longDate, time } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives';
import { StatusChip } from '@/components/ui/status-chip';
import { AllergyBanner } from '@/components/allergy-banner';
import { RecordSheet } from '@/components/record-sheet';
import { PrescriptionSheet } from '@/components/prescription-sheet';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * The doctor's landing screen and the highest-value view in the product.
 *
 * Two panes: queue left, patient detail right. Everything on this screen
 * arrives in a single /me/queue call — four round trips to compose a queue is
 * fine on a desk but not on a phone in a corridor, and the same endpoint
 * serves both.
 */
export default function QueuePage() {
  const [day] = useState(isoDate());
  const [queue, setQueue] = useState<DoctorQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [cursor, setCursor] = useState(0);
  const [writingRecord, setWritingRecord] = useState(false);
  const [writingRx, setWritingRx] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = await api<DoctorQueue>(`/me/queue?date=${day}`);
      setQueue(q);
      setSelected((prev) =>
        prev ? (q.appointments.find((a) => a.id === prev.id) ?? null) : (q.appointments[0] ?? null),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your queue');
    }
  }, [day]);

  /**
   * Reception checks a patient in on their machine; this screen has to notice.
   * Paused while a sheet is open — having the queue shift under a half-written
   * prescription is worse than showing data fifteen seconds old.
   */
  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: !writingRecord && !writingRx,
  });

  useEffect(() => {
    void refreshNow();
    // Initial load only; the hook owns everything after this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = queue?.appointments ?? [];
      if (!list.length) return;
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.key === 'j') {
        const next = Math.min(cursor + 1, list.length - 1);
        setCursor(next);
        setSelected(list[next]);
      }
      if (e.key === 'k') {
        const next = Math.max(cursor - 1, 0);
        setCursor(next);
        setSelected(list[next]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queue, cursor]);

  async function setStatus(id: number, status: 'IN_PROGRESS' | 'COMPLETED') {
    try {
      await api(`/appointments/${id}/status`, { method: 'PATCH', body: { status } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that appointment');
    }
  }

  if (error && !queue) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <Stat label="Scheduled" value={queue?.stats.total ?? '—'} />
        <Stat label="Waiting" value={queue?.stats.waiting ?? '—'} tone="warning" />
        <Stat label="In progress" value={queue?.stats.inProgress ?? '—'} tone="danger" />
        <Stat label="Completed" value={queue?.stats.completed ?? '—'} tone="success" />
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-text-muted">{longDate()}</span>
          <Freshness lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={() => void refreshNow()} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="scroll-thin w-[290px] shrink-0 overflow-y-auto border-r border-border bg-surface">
          {!queue && (
            <div className="space-y-2 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          )}
          {queue?.appointments.length === 0 && (
            <EmptyState title="Nothing booked today" description="Your queue is empty." />
          )}
          {queue?.appointments.map((a, i) => (
            <button
              key={a.id}
              onClick={() => {
                setSelected(a);
                setCursor(i);
              }}
              className={`flex w-full items-center gap-2 border-b border-[#f0f2f4] px-3 py-2 text-left text-sm ${
                selected?.id === a.id
                  ? 'bg-primary-soft shadow-[inset_2px_0_0_#1e6fd9]'
                  : 'hover:bg-[#fafbfc]'
              }`}
            >
              <span className="w-9 shrink-0 font-mono text-xs text-text-muted">
                {time(a.scheduledAt)}
              </span>
              <span className="flex-1 truncate font-medium">{a.patient.fullName}</span>
              {a.patient.hasAllergies && (
                <span title="Has recorded allergies" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
              )}
              <StatusChip status={a.status} />
            </button>
          ))}
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          {selected ? (
            <PatientPanel
              item={selected}
              onStart={() => void setStatus(selected.id, 'IN_PROGRESS')}
              onComplete={() => void setStatus(selected.id, 'COMPLETED')}
              onWriteRecord={() => setWritingRecord(true)}
              onWriteRx={() => setWritingRx(true)}
              error={error}
            />
          ) : (
            <EmptyState title="Select a patient" description="Choose someone from your queue." />
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-surface px-4 py-1 text-xxs text-text-subtle">
        <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move ·{' '}
        <kbd className="font-mono">⌘K</kbd> search
      </div>

      {selected && (
        <>
          <RecordSheet
            open={writingRecord}
            onClose={() => setWritingRecord(false)}
            patientId={selected.patient.id}
            patientName={selected.patient.fullName}
            onSaved={() => {
              setWritingRecord(false);
              void load();
            }}
          />
          <PrescriptionSheet
            open={writingRx}
            onClose={() => setWritingRx(false)}
            patientId={selected.patient.id}
            patientName={selected.patient.fullName}
            onSaved={() => setWritingRx(false)}
          />
        </>
      )}
    </>
  );
}

function PatientPanel({
  item,
  onStart,
  onComplete,
  onWriteRecord,
  onWriteRx,
  error,
}: {
  item: QueueItem;
  onStart: () => void;
  onComplete: () => void;
  onWriteRecord: () => void;
  onWriteRx: () => void;
  error: string | null;
}) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<MedicalRecord[] | null>(null);

  useEffect(() => {
    setPatient(null);
    setRecords(null);
    api<Patient>(`/patients/${item.patient.id}`)
      .then(setPatient)
      .catch(() => setPatient(null));
    api<{ data: MedicalRecord[] }>(`/patients/${item.patient.id}/records`)
      .then((r) => setRecords(r.data))
      .catch(() => setRecords([]));
  }, [item.patient.id]);

  const canStart = item.status === 'CHECKED_IN';
  const canComplete = item.status === 'IN_PROGRESS';
  const canWrite = item.status === 'IN_PROGRESS' || item.status === 'COMPLETED';

  return (
    <>
      {error && (
        <div role="alert" className="mb-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-3 py-2 text-sm text-[#8a2a1f]">
          {error}
        </div>
      )}

      <Card>
        <div className="text-lg font-bold tracking-tight">{item.patient.fullName}</div>
        <div className="font-mono text-xs text-text-muted">
          {item.patient.age}y · {item.patient.gender.toLowerCase()}
          {patient?.bloodGroup ? ` · ${patient.bloodGroup}` : ''} · #{item.patient.id}
        </div>

        {/* Never collapsed, never behind a tab. */}
        <div className="mt-2.5">
          {patient ? <AllergyBanner allergies={patient.allergies} /> : <Skeleton className="h-8" />}
        </div>

        <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-xs text-text-subtle">Appointment</dt>
          <dd className="font-mono text-xs">{time(item.scheduledAt)}</dd>
          <dt className="text-xs text-text-subtle">Reason</dt>
          <dd>{item.reason ?? '—'}</dd>
          <dt className="text-xs text-text-subtle">Status</dt>
          <dd>
            <StatusChip status={item.status} />
          </dd>
          <dt className="text-xs text-text-subtle">Last seen</dt>
          <dd>
            {records === null ? '…' : records[0] ? fmtDate(records[0].visitDate) : 'First visit'}
          </dd>
        </dl>

        <div className="mt-3.5 flex flex-wrap gap-2">
          {canStart && (
            <Button variant="primary" onClick={onStart}>
              Start consult
            </Button>
          )}
          {canComplete && (
            <Button variant="primary" onClick={onComplete}>
              Complete consult
            </Button>
          )}
          <Button disabled={!canWrite} onClick={onWriteRecord}>
            Add record
          </Button>
          <Button disabled={!canWrite} onClick={onWriteRx}>
            Write prescription
          </Button>
        </div>

        {!canWrite && (
          <p className="mt-2 text-xs text-text-subtle">
            Start the consultation before writing a record or prescription.
          </p>
        )}
      </Card>

      <Card className="mt-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Recent visits
        </div>
        {records === null && <Skeleton className="h-16" />}
        {records?.length === 0 && <p className="text-sm text-text-subtle">No previous visits.</p>}
        <div className="space-y-2.5 border-l-2 border-border pl-3">
          {records?.slice(0, 5).map((r) => (
            <div key={r.id}>
              <div className="text-sm font-semibold">
                {fmtDate(r.visitDate)} — {r.diagnosis}
              </div>
              <div className="text-sm text-text-muted">{r.notes ?? 'No notes'}</div>
            </div>
          ))}
        </div>
      </Card>
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
