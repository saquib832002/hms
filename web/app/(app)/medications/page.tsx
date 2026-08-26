'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Dose, MedicationRound, Ward } from '@/lib/types';
import { time } from '@/lib/format';
import { EmptyState, ErrorState, Select, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * The ward's drug chart for today.
 *
 * Read-only on web, deliberately. Signing for a dose is an act performed at
 * the bedside with the patient and the medicine in front of you; a desktop
 * button labelled "given" invites signing for something you have not yet done,
 * which is precisely the habit drug charts exist to prevent.
 */
export default function MedicationsPage() {
  const [wards, setWards] = useState<Ward[]>([]);
  const [wardId, setWardId] = useState<number | null>(null);
  const [round, setRound] = useState<MedicationRound | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setRound(await api<MedicationRound>(`/medications/round/${wardId}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the medication round');
    }
  }, [wardId]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load);

  useEffect(() => {
    setRound(null);
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wardId]);

  if (error && !round) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  const total =
    (round?.overdue.length ?? 0) + (round?.dueNow.length ?? 0) + (round?.upcoming.length ?? 0);

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

        <Stat label="Overdue" value={round?.overdue.length ?? '—'} tone="danger" />
        <Stat label="Due now" value={round?.dueNow.length ?? '—'} tone="warning" />
        <Stat label="Upcoming" value={round?.upcoming.length ?? '—'} />
        <Stat label="Recorded" value={round?.completed.length ?? '—'} tone="success" />

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xxs text-text-subtle">Sign for doses on the mobile app</span>
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!round && <TableSkeleton cols={6} />}
        {round && total === 0 && round.completed.length === 0 && (
          <EmptyState title="No doses scheduled" description="Nothing is charted for this ward today." />
        )}

        {round && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Due', 'Bed', 'Patient', 'Medicine', 'Dose', 'Status'].map((h) => (
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
              <Group title="Overdue" doses={round.overdue} tone="danger" />
              <Group title="Due now" doses={round.dueNow} tone="warning" />
              <Group title="Upcoming" doses={round.upcoming} />
              <Group title="Recorded" doses={round.completed} tone="success" />
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Group({
  title,
  doses,
  tone,
}: {
  title: string;
  doses: Dose[];
  tone?: 'danger' | 'warning' | 'success';
}) {
  if (doses.length === 0) return null;
  const colour =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-text-subtle';

  return (
    <>
      <tr>
        <td
          colSpan={6}
          className={`border-b border-border bg-bg px-3 py-1 text-xxs font-bold uppercase tracking-wider ${colour}`}
        >
          {title} · {doses.length}
        </td>
      </tr>
      {doses.map((d) => (
        <tr key={d.id} className={tone === 'danger' ? 'bg-danger-soft' : 'hover:bg-[#fafbfc]'}>
          <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs font-semibold">
            {time(d.dueAt)}
          </td>
          <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">{d.bed}</td>
          <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
            {d.patient.fullName}
            {d.patient.hasAllergies && (
              <span
                title="Has recorded allergies"
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle"
              />
            )}
          </td>
          <td className="border-b border-[#f0f2f4] px-3 py-2">{d.medicineName}</td>
          <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">{d.dosage}</td>
          <td className="border-b border-[#f0f2f4] px-3 py-2 text-xs">
            {d.status === 'DUE' ? (
              <span className="text-text-subtle">Not yet given</span>
            ) : (
              <span>
                <span className="font-semibold">{d.status.toLowerCase()}</span>
                {d.givenBy ? ` · ${d.givenBy}` : ''}
                {d.notes ? ` — ${d.notes}` : ''}
              </span>
            )}
          </td>
        </tr>
      ))}
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
