'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { BedRow, Ward, WardBoard } from '@/lib/types';
import { dateTime, time } from '@/lib/format';
import { api, ApiError } from '@/lib/api';
import { Button, EmptyState, ErrorState, Select, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { AdmitSheet, TransferSheet } from '@/components/admit-sheet';
import { ScheduleMedicationSheet } from '@/components/schedule-medication-sheet';

/**
 * The ward board.
 *
 * Unlike the nurse's phone, this is sorted by bed. At a desk the question is
 * "show me the ward"; at the bedside it is "what needs doing next", which is
 * why the mobile version sorts by urgency instead. Same data, different job.
 */
export default function WardPage() {
  const [wards, setWards] = useState<Ward[]>([]);
  const [wardId, setWardId] = useState<number | null>(null);
  const [board, setBoard] = useState<WardBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [admitting, setAdmitting] = useState(false);
  const [transferring, setTransferring] = useState<BedRow | null>(null);
  const [scheduling, setScheduling] = useState<BedRow | null>(null);
  const [discharging, setDischarging] = useState<BedRow | null>(null);
  const [dischargeBusy, setDischargeBusy] = useState(false);

  useEffect(() => {
    api<Ward[]>('/wards')
      .then((w) => {
        setWards(w);
        setWardId((prev) => prev ?? w[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load wards'));
  }, []);

  const load = useCallback(async () => {
    if (!wardId) return;
    setError(null);
    try {
      setBoard(await api<WardBoard>(`/wards/${wardId}/board`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the ward board');
    }
  }, [wardId]);

  // Paused while any sheet is open — the bed list must not shift under a
  // half-completed admission.
  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: !admitting && !transferring && !scheduling && !discharging,
  });

  async function confirmDischarge() {
    if (!discharging?.admission) return;
    setDischargeBusy(true);
    try {
      await api(`/admissions/${discharging.admission.id}/discharge`, {
        method: 'PATCH',
        body: {},
      });
      setDischarging(null);
      void refreshNow();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not discharge that patient');
      setDischarging(null);
    } finally {
      setDischargeBusy(false);
    }
  }

  useEffect(() => {
    setBoard(null);
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wardId]);

  if (error && !board) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <Select
          value={wardId ?? ''}
          onChange={(e) => setWardId(Number(e.target.value))}
          className="w-auto text-sm"
        >
          {wards.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>

        <Stat label="Beds" value={board?.stats.beds ?? '—'} />
        <Stat label="Occupied" value={board?.stats.occupied ?? '—'} tone="warning" />
        <Stat label="Available" value={board?.stats.available ?? '—'} tone="success" />
        <Stat label="Obs overdue" value={board?.stats.observationsOverdue ?? '—'} tone="danger" />

        <div className="ml-auto flex items-center gap-3">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
          <Button variant="primary" onClick={() => setAdmitting(true)}>
            Admit patient
          </Button>
        </div>
      </div>

      {error && board && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!board && <TableSkeleton cols={7} />}
        {board?.beds.length === 0 && <EmptyState title="This ward has no beds configured" />}

        {board && board.beds.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Bed', 'Patient', 'Age', 'Admitted', 'Last obs', 'Next dose', 'Status', ''].map((h) => (
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
              {board.beds.map((row) => (
                <BedTableRow
                  key={row.bed.id}
                  row={row}
                  onTransfer={() => setTransferring(row)}
                  onSchedule={() => setScheduling(row)}
                  onDischarge={() => setDischarging(row)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AdmitSheet
        open={admitting}
        beds={board?.beds ?? []}
        onClose={() => setAdmitting(false)}
        onAdmitted={() => {
          setAdmitting(false);
          void refreshNow();
        }}
      />

      <TransferSheet
        row={transferring}
        beds={board?.beds ?? []}
        onClose={() => setTransferring(null)}
        onTransferred={() => {
          setTransferring(null);
          void refreshNow();
        }}
      />

      <ScheduleMedicationSheet
        row={scheduling}
        onClose={() => setScheduling(null)}
        onScheduled={() => void refreshNow()}
      />

      <ConfirmDialog
        open={discharging !== null}
        title="Discharge this patient?"
        consequence={
          discharging?.admission
            ? `${discharging.admission.patient.fullName} will be discharged and ${discharging.bed.label} freed. Any doses still outstanding are closed off as withheld.`
            : ''
        }
        confirmLabel="Discharge"
        busy={dischargeBusy}
        onConfirm={() => void confirmDischarge()}
        onCancel={() => setDischarging(null)}
      />
    </>
  );
}

function BedTableRow({
  row,
  onTransfer,
  onSchedule,
  onDischarge,
}: {
  row: BedRow;
  onTransfer: () => void;
  onSchedule: () => void;
  onDischarge: () => void;
}) {
  const { bed, admission } = row;

  if (!admission) {
    return (
      <tr className="text-text-subtle">
        <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs font-bold">{bed.label}</td>
        <td className="border-b border-[#f0f2f4] px-3 py-2" colSpan={6}>
          {bed.isActive ? 'Available' : 'Out of service'}
        </td>
        <td className="border-b border-[#f0f2f4] px-3 py-2">
          <span className="rounded-full bg-[#eef0f2] px-2 py-0.5 text-xxs font-semibold text-text-muted">
            {bed.isActive ? 'Empty' : 'Closed'}
          </span>
        </td>
      </tr>
    );
  }

  const overdue = admission.observationOverdue;

  return (
    <tr className={overdue ? 'bg-danger-soft' : 'hover:bg-[#fafbfc]'}>
      <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs font-bold">{bed.label}</td>
      <td className="border-b border-[#f0f2f4] px-3 py-2">
        <Link
          href={`/patients?id=${admission.patient.id}`}
          className="font-medium underline-offset-2 hover:underline"
        >
          {admission.patient.fullName}
        </Link>
        {admission.patient.hasAllergies && (
          <span
            title="Has recorded allergies"
            className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle"
          />
        )}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">{admission.patient.age}</td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
        {dateTime(admission.admittedAt)}
      </td>
      <td
        className={`border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs ${
          overdue ? 'font-semibold text-danger' : 'text-text-muted'
        }`}
      >
        {admission.lastVital
          ? `${time(admission.lastVital.recordedAt)}${
              admission.lastVital.systolic
                ? ` · ${admission.lastVital.systolic}/${admission.lastVital.diastolic}`
                : ''
            }`
          : 'none recorded'}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
        {admission.nextDose
          ? `${time(admission.nextDose.dueAt)} · ${admission.nextDose.medicineName}`
          : '—'}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2">
        {overdue ? (
          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xxs font-semibold text-danger">
            Obs overdue
          </span>
        ) : (
          <span className="rounded-full bg-success-soft px-2 py-0.5 text-xxs font-semibold text-success">
            Up to date
          </span>
        )}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 text-right">
        <div className="flex justify-end gap-1.5">
          {/* No drug chart yet means the medication round will never show this
              patient — worth making obvious rather than leaving to discovery. */}
          <Button size="sm" onClick={onSchedule}>
            {admission.nextDose ? 'Chart' : 'Add chart'}
          </Button>
          <Button size="sm" onClick={onTransfer}>
            Move
          </Button>
          <Button size="sm" variant="danger" onClick={onDischarge}>
            Discharge
          </Button>
        </div>
      </td>
    </tr>
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
