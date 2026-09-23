'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Paginated, PatientListItem, Vital, VitalFlag } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { Button, Card, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui/primitives';
import { RecordVitalsSheet } from '@/components/record-vitals-sheet';
import { ObservationPanel } from '@/components/observation-panel';

export default function VitalsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-text-subtle">Loading…</div>}>
      <VitalsView />
    </Suspense>
  );
}

/**
 * Observations: the plan, the chart, and recording a set.
 *
 * WHY THIS STOPPED BEING READ-ONLY
 * --------------------------------
 * It said "observations are recorded on the mobile app at the bedside; this is
 * the review view" — a reasonable sentence describing a screen that could never
 * show anything. `POST /vitals` had exactly one caller in the codebase, the
 * mobile offline outbox, and mobile has never run on hardware. So the screen
 * was always empty, for everybody, since Phase 3.
 *
 * The transcription argument behind the rule is real: numbers copied from paper
 * to a desktop an hour later are numbers that get copied wrong. It is not an
 * argument for having no way to record them at all, and it does not cover the
 * two commonest cases — a ward terminal or computer-on-wheels beside the bed,
 * and an outpatient whose BP is taken at the clinic desk before the doctor.
 *
 * The second of those was impossible in a stronger sense: `Vital.admissionId`
 * has always been nullable, so the data model expected clinic observations, and
 * nothing in either client could produce one.
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
          <VitalsHistory
            patientId={patientId}
            patientName={list?.find((p) => p.id === patientId)?.fullName ?? 'this patient'}
          />
        ) : (
          <EmptyState
            title="Select a patient"
            description="Their observation plan, chart, and a form to record a new set."
          />
        )}
      </div>
    </div>
  );
}

function VitalsHistory({ patientId, patientName }: { patientId: number; patientName: string }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Vital[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  /*
   * The current stay, if there is one.
   *
   * Observations do not need an admission — the model has always allowed a
   * clinic reading — but the *plan* does, because a frequency belongs to a stay
   * rather than to a person. So an outpatient gets the chart and the record
   * form, and no plan panel, which is the honest shape rather than an empty one.
   */
  const [admissionId, setAdmissionId] = useState<number | null>(null);
  /** Bumped after recording, so the plan re-reads "last observed" and "due". */
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    setError(null);
    api<{ data: Vital[] }>(`/patients/${patientId}/vitals?limit=100`)
      .then((r) => setRows(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load observations'));
  }, [patientId]);

  useEffect(() => {
    setRows(null);
    setAdmissionId(null);
    load();
    api<{ data: { id: number; status: string }[] }>(`/patients/${patientId}/admissions`)
      .then((r) => setAdmissionId(r.data.find((a) => a.status === 'ADMITTED')?.id ?? null))
      // An outpatient legitimately has none, and a failure here must not stop
      // the chart rendering — the observations are the point of the screen.
      .catch(() => setAdmissionId(null));
  }, [patientId, load]);

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-md font-semibold text-text">{patientName}</h2>
        <Button variant="primary" className="ml-auto" onClick={() => setRecording(true)}>
          Record observations
        </Button>
      </div>

      {admissionId !== null && (
        <div className="mb-3">
          <ObservationPanel
            admissionId={admissionId}
            /*
             * Only a doctor may relax the frequency. The panel shows the looser
             * options disabled rather than hiding them, so a nurse can see that
             * 12-hourly exists and that changing to it is somebody else's call.
             */
            canRelax={user?.role === 'DOCTOR'}
            refreshKey={tick}
          />
        </div>
      )}

      <VitalsTable rows={rows} error={error} />

      <RecordVitalsSheet
        open={recording}
        patientId={patientId}
        patientName={patientName}
        onClose={() => setRecording(false)}
        onRecorded={() => {
          setRecording(false);
          load();
          setTick((t) => t + 1);
        }}
      />
    </>
  );
}

function VitalsTable({ rows, error }: { rows: Vital[] | null; error: string | null }) {
  if (error) return <ErrorState message={error} />;
  if (!rows) return <Skeleton className="h-48 w-full" />;
  if (rows.length === 0)
    return (
      <EmptyState
        title="No observations recorded"
        description="Nothing has been charted for this patient yet. Record the first set above."
      />
    );

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
