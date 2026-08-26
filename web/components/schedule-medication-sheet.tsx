'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { BedRow, Prescription } from '@/lib/types';
import { date } from '@/lib/format';
import { Button, Field, Select, SectionLabel } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

interface ScheduleResult {
  scheduled: number;
  unscheduled: { itemId: number; medicineName: string; reason: string }[];
}

/**
 * Build the drug chart for an admitted patient from one of their
 * prescriptions — the electronic equivalent of transcribing onto a paper chart
 * at the nurses' station.
 *
 * Without this, medication rounds only work for patients whose doses happened
 * to exist already. Admitting someone new produced an empty chart forever,
 * which is exactly the gap this closes.
 *
 * The important part of the result is `unscheduled`. The frequency parser
 * refuses to guess at anything it does not confidently recognise (and never
 * schedules PRN medicine), so those items come back with a reason and have to
 * be handled by a human. Hiding that would turn a deliberate refusal into a
 * silent omission — a medicine quietly absent from the chart.
 */
export function ScheduleMedicationSheet({
  row,
  onClose,
  onScheduled,
}: {
  row: BedRow | null;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [prescriptionId, setPrescriptionId] = useState('');
  const [days, setDays] = useState('3');
  const [result, setResult] = useState<ScheduleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patientId = row?.admission?.patient.id;

  useEffect(() => {
    setPrescriptions(null);
    setPrescriptionId('');
    setResult(null);
    setError(null);
    if (!patientId) return;

    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => {
        // A cancelled prescription must not become a drug chart.
        const usable = r.data.filter((p) => p.status !== 'CANCELLED');
        setPrescriptions(usable);
        if (usable.length === 1) setPrescriptionId(String(usable[0].id));
      })
      .catch(() => setPrescriptions([]));
  }, [patientId]);

  if (!row?.admission) return null;

  async function submit() {
    if (!row?.admission || !prescriptionId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<ScheduleResult>(
        `/admissions/${row.admission.id}/medication-schedule`,
        { method: 'POST', body: { prescriptionId: Number(prescriptionId), days: Number(days) } },
      );
      setResult(res);
      onScheduled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the drug chart');
    } finally {
      setSubmitting(false);
    }
  }

  const selected = prescriptions?.find((p) => String(p.id) === prescriptionId);

  return (
    <Sheet
      open
      onClose={onClose}
      title="Schedule medication"
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={!prescriptionId || submitting}
              onClick={() => void submit()}
            >
              {submitting ? 'Building chart…' : 'Build drug chart'}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        )
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{row.admission.patient.fullName}</div>
        <div className="font-mono text-xs text-text-muted">
          {row.bed.label} · admitted {date(row.admission.admittedAt)}
        </div>
      </div>

      {result ? (
        <>
          <div className="mt-3 rounded-sm border border-[#b7dcc5] bg-success-soft px-3 py-2 text-sm text-[#14562f]">
            <strong>{result.scheduled}</strong> dose{result.scheduled === 1 ? '' : 's'} added to the
            chart.
          </div>

          {result.unscheduled.length > 0 && (
            <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2.5 text-sm text-[#6b5314]">
              <div className="font-semibold">
                {result.unscheduled.length} medicine
                {result.unscheduled.length === 1 ? '' : 's'} not scheduled
              </div>
              <p className="mt-0.5 text-xs">
                These need a nurse to set the times. They are deliberately not guessed at.
              </p>
              <ul className="mt-2 space-y-1.5">
                {result.unscheduled.map((u) => (
                  <li key={u.itemId} className="rounded-sm border border-[#e5d9b4] bg-surface p-2">
                    <div className="font-semibold">{u.medicineName}</div>
                    <div className="text-xs">{u.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <>
          <SectionLabel>Prescription</SectionLabel>
          {prescriptions === null && <p className="text-sm text-text-subtle">Loading…</p>}
          {prescriptions?.length === 0 && (
            <p className="text-sm text-text-subtle">
              This patient has no active prescriptions. A doctor needs to write one first.
            </p>
          )}

          {prescriptions && prescriptions.length > 0 && (
            <>
              <Field label="Which prescription" required>
                <Select value={prescriptionId} onChange={(e) => setPrescriptionId(e.target.value)}>
                  <option value="">Select…</option>
                  {prescriptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      #{p.id} · {date(p.issuedAt)} · {p.items.length} item
                      {p.items.length === 1 ? '' : 's'}
                    </option>
                  ))}
                </Select>
              </Field>

              {selected && (
                <div className="mb-3 rounded-sm border border-border bg-[#fcfcfd] p-2.5">
                  <ul className="space-y-1">
                    {selected.items.map((i) => (
                      <li key={i.id} className="font-mono text-xs">
                        {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Field
                label="Days to schedule"
                hint="Doses already past today are skipped, so nothing appears instantly overdue."
              >
                <Select value={days} onChange={(e) => setDays(e.target.value)}>
                  {[1, 2, 3, 5, 7, 14].map((d) => (
                    <option key={d} value={d}>
                      {d} day{d === 1 ? '' : 's'}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}
