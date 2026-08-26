'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Paginated, PatientListItem, Vital, VitalFlag } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { Card, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui/primitives';

export default function VitalsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-text-subtle">Loading…</div>}>
      <VitalsView />
    </Suspense>
  );
}

/**
 * Observation history.
 *
 * Read-only on web. Entry lives on the phone, because observations are taken
 * at the bedside and typing them into a desktop afterwards is how transcription
 * errors happen — this screen exists to review a chart, not to write one.
 */
function VitalsView() {
  const router = useRouter();
  const params = useSearchParams();
  const patientId = params.get('patientId') ? Number(params.get('patientId')) : null;

  const [query, setQuery] = useState('');
  const [list, setList] = useState<PatientListItem[] | null>(null);

  const loadList = useCallback(async (q: string) => {
    try {
      const res = await api<Paginated<PatientListItem>>(
        `/patients?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      );
      setList(res.data);
    } catch {
      setList([]);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadList(query.trim()), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, loadList]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter patients…"
            className="text-sm"
          />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {!list && (
            <div className="space-y-2 p-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-4" />
              ))}
            </div>
          )}
          {list?.map((p) => (
            <button
              key={p.id}
              onClick={() => router.replace(`/vitals?patientId=${p.id}`, { scroll: false })}
              className={`flex w-full items-center gap-2 border-b border-[#f0f2f4] px-3 py-2 text-left text-sm ${
                p.id === patientId
                  ? 'bg-primary-soft shadow-[inset_2px_0_0_#1e6fd9]'
                  : 'hover:bg-[#fafbfc]'
              }`}
            >
              <span className="flex-1 truncate font-medium">{p.fullName}</span>
              {p.hasAllergies && <span className="h-1.5 w-1.5 rounded-full bg-danger" />}
              <span className="font-mono text-xs text-text-subtle">#{p.id}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {patientId ? (
          <VitalsHistory patientId={patientId} />
        ) : (
          <EmptyState
            title="Select a patient"
            description="Observations are recorded on the mobile app at the bedside; this is the review view."
          />
        )}
      </div>
    </div>
  );
}

function VitalsHistory({ patientId }: { patientId: number }) {
  const [rows, setRows] = useState<Vital[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    setError(null);
    api<{ data: Vital[] }>(`/patients/${patientId}/vitals?limit=100`)
      .then((r) => setRows(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load observations'));
  }, [patientId]);

  if (error) return <ErrorState message={error} />;
  if (!rows) return <Skeleton className="h-48 w-full" />;
  if (rows.length === 0)
    return <EmptyState title="No observations recorded" description="Nothing has been charted for this patient yet." />;

  return (
    <Card className="p-0">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {['Recorded', 'BP', 'Pulse', 'Temp', 'Resp', 'SpO₂', 'Pain', 'By'].map((h) => (
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
          {rows.map((v) => (
            <tr key={v.id} className="hover:bg-[#fafbfc]">
              <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                {dateTime(v.recordedAt)}
              </td>
              <Cell value={v.systolic != null ? `${v.systolic}/${v.diastolic ?? '—'}` : null} flags={v.flags} fields={['systolic', 'diastolic']} />
              <Cell value={v.pulse} flags={v.flags} fields={['pulse']} />
              <Cell value={v.temperatureC} flags={v.flags} fields={['temperatureC']} />
              <Cell value={v.respiratoryRate} flags={v.flags} fields={['respiratoryRate']} />
              <Cell value={v.spo2} flags={v.flags} fields={['spo2']} />
              <Cell value={v.painScore} flags={v.flags} fields={['painScore']} />
              <td className="border-b border-[#f0f2f4] px-3 py-2 text-xs text-text-muted">
                {v.recordedBy?.fullName ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Flags come from the server, computed on read against current reference
 * ranges — never stored. A stored flag would freeze whatever the thresholds
 * were on the day it was written, and the chart would show two different
 * judgements of the same number.
 */
function Cell({
  value,
  flags,
  fields,
}: {
  value: string | number | null;
  flags: VitalFlag[];
  fields: string[];
}) {
  const flag = flags.find((f) => fields.includes(f.field));
  const tone =
    flag?.level === 'critical'
      ? 'bg-danger-soft font-bold text-danger'
      : flag
        ? 'font-semibold text-warning'
        : '';
  return (
    <td
      title={flag?.note}
      className={`border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs ${tone}`}
    >
      {value ?? '—'}
    </td>
  );
}
