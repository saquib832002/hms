'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input, Textarea } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Recording a set of observations.
 *
 * WHY THIS EXISTS ON THE WEB AT ALL
 * ---------------------------------
 * It did not, and that is why the vitals screen was always empty. `POST
 * /vitals` had exactly one caller in the entire codebase — the mobile offline
 * outbox — so the only way to record an observation was from a phone, and the
 * phone has never run on hardware. The screen said "observations are recorded
 * on the mobile app at the bedside; this is the review view", which is a
 * reasonable sentence describing a screen that could never show anything.
 *
 * `endpoint-coverage` even carried the reason "the web vitals form posts under
 * the patient" against `POST /vitals`. There was no such form. That is the
 * third false reason found in an exemption list, and each one reads as a
 * decision somebody made rather than a gap nobody filled.
 *
 * EVERY FIELD IS OPTIONAL, AND THE SERVER SAYS SO TOO
 * --------------------------------------------------
 * Observation sets genuinely are partial: a nurse doing a quick pulse check
 * should not have to invent a temperature. The server rejects a set where
 * everything is empty, and rejects implausible numbers outright rather than
 * flagging them — a temperature of 370 stored as "critical" pollutes a chart
 * somebody reads at a glance.
 */
export function RecordVitalsSheet({
  patientId,
  patientName,
  open,
  onClose,
  onRecorded,
}: {
  patientId: number | null;
  patientName: string;
  open: boolean;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [pulse, setPulse] = useState('');
  const [temperatureC, setTemperature] = useState('');
  const [respiratoryRate, setResp] = useState('');
  const [spo2, setSpo2] = useState('');
  const [painScore, setPain] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  /*
   * The per-field messages, not just the summary.
   *
   * `AllExceptionsFilter` returns validation failures as `errors: string[]`
   * and `ApiError` carries them — and this sheet was showing only `.message`,
   * which for a validation failure is the constant "One or more fields are
   * invalid." A nurse got a red box telling them something was wrong and not
   * which thing, on a form with seven boxes. The server had already said.
   */
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSystolic('');
    setDiastolic('');
    setPulse('');
    setTemperature('');
    setResp('');
    setSpo2('');
    setPain('');
    setNotes('');
    setError(null);
    setFieldErrors([]);
  }, [open, patientId]);

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  /**
   * Temperature to one decimal place.
   *
   * The API accepts one — `@IsNumber({ maxDecimalPlaces: 1 })` — and "36.65"
   * is an entirely reasonable thing to type, so it was rejected with a generic
   * error. Rounding to the resolution the input itself declares (`step="0.1"`)
   * is not silent mangling: 0.05°C is below what any ward thermometer reads,
   * and a paper chart records one decimal for the same reason.
   */
  const temp = (v: string) => {
    const n = num(v);
    return n === undefined ? undefined : Math.round(n * 10) / 10;
  };
  const anything =
    [systolic, diastolic, pulse, temperatureC, respiratoryRate, spo2, painScore].some(
      (v) => v.trim() !== '',
    ) || notes.trim() !== '';

  async function save() {
    if (!patientId) return;
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    try {
      await api('/vitals', {
        method: 'POST',
        body: {
          patientId,
          systolic: num(systolic),
          diastolic: num(diastolic),
          pulse: num(pulse),
          temperatureC: temp(temperatureC),
          respiratoryRate: num(respiratoryRate),
          spo2: num(spo2),
          painScore: num(painScore),
          notes: notes.trim() || undefined,
        },
      });
      onRecorded();
    } catch (e) {
      // The server names the field and the constraint. Showing only the
      // summary line left a nurse guessing which of seven boxes was wrong.
      setError(e instanceof ApiError ? e.message : 'Could not record those observations');
      setFieldErrors(e instanceof ApiError ? (e.errors ?? []) : []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record observations"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !anything} onClick={() => void save()}>
            {busy ? 'Recording…' : 'Record'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded border border-border bg-bg p-2.5">
          <div className="font-semibold">{patientName}</div>
          {/*
            Said plainly, because it is the thing people get wrong about this
            form. Outpatients are the point: the model has always allowed an
            observation with no admission, and nothing in either client offered
            one — so a nurse taking a BP at check-in had nowhere to put it.
          */}
          <div className="text-xs text-text-muted">
            Recorded as now. If this patient is admitted, it lands on their ward chart
            automatically; otherwise it is a clinic observation.
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
          >
            {error}
            {fieldErrors.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {fieldErrors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/*
          Every hint states the range the API will accept.
          The server rejects implausible readings outright rather than storing
          them flagged — a temperature of 370 saved as "critical" pollutes a
          chart somebody reads at a glance — so the bounds are real, and they
          belong in front of the nurse before they type rather than in a red
          box afterwards.
        */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Systolic" hint="mmHg · 40–300">
            <Input
              type="number"
              min={40}
              max={300}
              value={systolic}
              onChange={(e) => setSystolic(e.target.value)}
            />
          </Field>
          <Field label="Diastolic" hint="mmHg · 20–200">
            <Input
              type="number"
              min={20}
              max={200}
              value={diastolic}
              onChange={(e) => setDiastolic(e.target.value)}
            />
          </Field>
          <Field label="Pulse" hint="bpm · 20–250">
            <Input
              type="number"
              min={20}
              max={250}
              value={pulse}
              onChange={(e) => setPulse(e.target.value)}
            />
          </Field>
          <Field label="Temperature" hint="°C · 25–45, one decimal">
            <Input
              type="number"
              step="0.1"
              min={25}
              max={45}
              value={temperatureC}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </Field>
          <Field label="Respiratory rate" hint="per minute · 4–60">
            <Input
              type="number"
              min={4}
              max={60}
              value={respiratoryRate}
              onChange={(e) => setResp(e.target.value)}
            />
          </Field>
          <Field label="SpO₂" hint="% · 50–100">
            <Input
              type="number"
              min={50}
              max={100}
              value={spo2}
              onChange={(e) => setSpo2(e.target.value)}
            />
          </Field>
          <Field label="Pain score" hint="0–10">
            <Input
              type="number"
              min={0}
              max={10}
              value={painScore}
              onChange={(e) => setPain(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Notes" hint="Anything the numbers do not say.">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <p className="text-xxs text-text-subtle">
          Leave anything you did not measure blank. A partial set is normal and is recorded as
          partial rather than as zero.
        </p>
      </div>
    </Sheet>
  );
}
