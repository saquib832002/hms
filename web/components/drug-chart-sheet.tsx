'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type {
  BedRow,
  ChartMedicine,
  MedicationChart,
  MedicationRequest,
  SupplyRequest,
} from '@/lib/types';
import { date, dateTime, time } from '@/lib/format';
import {
  Button,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * The drug chart — the MAR — for one admission.
 *
 * WHY THIS EXISTS
 * ---------------
 * The medication round answers "what is due on this ward today", which is the
 * right question while giving out medicines and the wrong one everywhere else.
 * A nurse taking over a patient, or a doctor on a ward round, asks "what is
 * this person on, and what have they actually had" — and nothing in the system
 * answered that. There was no per-patient view of medication anywhere.
 *
 * THE DEAD END IT CLOSES
 * ----------------------
 * `parseFrequency` refuses to guess at a frequency it cannot read confidently,
 * which is right — a chart that is confidently wrong under-doses a patient. It
 * returned those items with the note *"these need a nurse to set the times.
 * They are deliberately not guessed at"*, and there was no screen in either
 * client where a nurse could set them. The medicine was prescribed, absent from
 * the chart, and explained by a sentence in a dialog that closed.
 *
 * A refusal that leads nowhere is not a safe default. It is a missing medicine
 * with a paragraph attached.
 *
 * TWO EMPTY ROWS THAT LOOK IDENTICAL AND ARE NOT
 * ----------------------------------------------
 * A medicine with no doses is either unreadable-frequency (wants times set) or
 * as-needed (must never get times, wants a dose recorded when given). The
 * server sends `asNeeded` so the screen can offer the right one, because
 * offering "set times" for a PRN medicine would turn "give if the patient needs
 * it" into "a dose is due", which is the specific misreading PRN exists to
 * prevent.
 */
export function DrugChartSheet({
  row,
  onClose,
  onChanged,
}: {
  row: BedRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [chart, setChart] = useState<MedicationChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<ChartMedicine | null>(null);
  const [givingPrn, setGivingPrn] = useState<ChartMedicine | null>(null);
  const [supplyFor, setSupplyFor] = useState<ChartMedicine | null>(null);
  const [asking, setAsking] = useState(false);
  const [supplies, setSupplies] = useState<SupplyRequest[]>([]);
  const [asks, setAsks] = useState<MedicationRequest[]>([]);

  const admissionId = row?.admission?.id;

  const load = useCallback(async () => {
    if (!admissionId) return;
    setError(null);
    try {
      /*
       * The chart and both request queues together.
       *
       * A request whose answer is invisible from the bed it was raised at is
       * one the nurse chases by phone — which is what the queue was supposed
       * to replace. Parallel because they are independent reads and the ward
       * round is the least patient screen in the app.
       */
      const [c, s, m] = await Promise.all([
        api<MedicationChart>(`/admissions/${admissionId}/chart`),
        api<SupplyRequest[]>(`/admissions/${admissionId}/supply-requests`),
        api<MedicationRequest[]>(`/admissions/${admissionId}/medication-requests`),
      ]);
      setChart(c);
      setSupplies(s);
      setAsks(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the drug chart');
    }
  }, [admissionId]);

  useEffect(() => {
    setChart(null);
    void load();
  }, [load]);

  if (!row?.admission) return null;

  const charted = chart?.medicines.filter((m) => m.doses.length > 0) ?? [];
  const uncharted = chart?.medicines.filter((m) => m.doses.length === 0) ?? [];

  return (
    <Sheet open onClose={onClose} title="Drug chart" width="w-[760px]">
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{chart?.patient.fullName ?? row.admission.patient.fullName}</div>
        <div className="font-mono text-xs text-text-muted">
          {row.bed.label} · admitted {date(row.admission.admittedAt)}
          {chart ? ` · age ${chart.patient.age}` : ''}
        </div>

        {/*
          The substances, spelled out. This is the screen where somebody is
          about to give a drug; a dot meaning "has allergies" is the least
          useful form of that warning at exactly the moment it matters most.
        */}
        {chart && chart.patient.allergies.length > 0 && (
          <p
            role="alert"
            className="mt-2 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-1.5 text-xs text-[#8a2a1f]"
          >
            <strong>Allergic to:</strong> {chart.patient.allergies.join(', ')}
          </p>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      {!chart && !error && <Skeleton className="mt-3 h-40 w-full" />}

      {chart && chart.medicines.length === 0 && (
        <p className="mt-4 text-sm text-text-subtle">
          Nothing has been prescribed for this patient. A doctor needs to write a prescription
          before there is a chart to build.
        </p>
      )}

      {/*
        Prescribed-but-not-charted comes FIRST, above the working chart.
        These are the ones needing a decision, and burying them under the
        medicines that are already fine is how a medicine goes unnoticed —
        which is the failure this whole screen exists to fix.
      */}
      {uncharted.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-xxs font-bold uppercase tracking-wider text-warning">
            Prescribed · not on the chart · {uncharted.length}
          </h3>
          <div className="space-y-2">
            {uncharted.map((m) => (
              <div
                key={m.prescriptionItemId}
                className="rounded-sm border border-[#ecdca6] bg-warning-soft p-2.5"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-text">{m.medicineName}</span>
                  <span className="font-mono text-xs text-text-muted">{m.dosage}</span>
                  <span className="ml-auto font-mono text-xxs text-text-subtle">
                    written {date(m.issuedAt)}
                    {m.prescriber ? ` · ${m.prescriber}` : ''}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-xs text-text-muted">
                  as written: “{m.frequency}” · {m.duration}
                </div>
                <p className="mt-1 text-xs text-[#6b5314]">{m.notScheduledReason}</p>

                <div className="mt-2 flex gap-2">
                  {m.asNeeded ? (
                    /*
                      No "set times" here, deliberately. Giving an as-needed
                      medicine fixed due times would make the round show a dose
                      as due — the exact opposite of what PRN means, and an
                      overdue-looking row invites giving a medicine the patient
                      did not need.
                    */
                    <Button size="sm" onClick={() => setGivingPrn(m)}>
                      Record a dose as given
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => setScheduling(m)}>
                      Set the times
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {charted.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-xxs font-bold uppercase tracking-wider text-text-subtle">
            On the chart · {charted.length}
          </h3>
          <div className="space-y-3">
            {charted.map((m) => (
              <MedicineRow
                key={m.prescriptionItemId}
                medicine={m}
                onAskPharmacy={() => setSupplyFor(m)}
              />
            ))}
          </div>
        </section>
      )}

      {/*
        Asking a doctor sits at the bottom and is the only action here that is
        not about a medicine already on the screen — because it is the one for
        a medicine that is not. Deliberately worded as a request: a nurse asks,
        a nurse never prescribes, and there is no path from this button to a
        medicine appearing on the chart.
      */}
      {chart && (
        <section className="mt-5 border-t border-border pt-4">
          <div className="flex items-baseline">
            <h3 className="text-xxs font-bold uppercase tracking-wider text-text-subtle">
              Requests
            </h3>
            <Button size="sm" className="ml-auto" onClick={() => setAsking(true)}>
              Ask a doctor to prescribe
            </Button>
          </div>

          {supplies.length === 0 && asks.length === 0 && (
            <p className="mt-2 text-xs text-text-subtle">
              Nothing asked for on this patient. Use <strong>Ask pharmacy</strong> beside a
              medicine when the ward has run out, or the button above when something is needed
              that has not been prescribed.
            </p>
          )}

          <div className="mt-2 space-y-1.5">
            {asks.map((r) => (
              <RequestRow
                key={`m${r.id}`}
                kind="Doctor"
                what={r.medicineText}
                detail={r.reason}
                status={r.status}
                requestedAt={r.requestedAt}
                by={r.requestedBy?.fullName ?? null}
                answeredBy={r.respondedBy?.fullName ?? null}
                answer={r.responseNote}
              />
            ))}
            {supplies.map((r) => (
              <RequestRow
                key={`s${r.id}`}
                kind="Pharmacy"
                what={r.prescriptionItem.medicineName}
                detail={r.quantity ? `${r.quantity} requested` : (r.note ?? '')}
                status={r.status}
                requestedAt={r.requestedAt}
                by={r.requestedBy?.fullName ?? null}
                answeredBy={r.respondedBy?.fullName ?? null}
                answer={r.responseNote}
              />
            ))}
          </div>
        </section>
      )}

      <SetTimesSheet
        medicine={scheduling}
        admissionId={row.admission.id}
        onClose={() => setScheduling(null)}
        onSaved={() => {
          setScheduling(null);
          void load();
          onChanged();
        }}
        onError={setError}
      />

      <GivePrnSheet
        medicine={givingPrn}
        admissionId={row.admission.id}
        onClose={() => setGivingPrn(null)}
        onSaved={() => {
          setGivingPrn(null);
          void load();
          onChanged();
        }}
        onError={setError}
      />

      <AskPharmacySheet
        medicine={supplyFor}
        admissionId={row.admission.id}
        onClose={() => setSupplyFor(null)}
        onSaved={() => {
          setSupplyFor(null);
          void load();
        }}
        onError={setError}
      />

      <AskDoctorSheet
        open={asking}
        admissionId={row.admission.id}
        onClose={() => setAsking(false)}
        onSaved={() => {
          setAsking(false);
          void load();
        }}
        onError={setError}
      />
    </Sheet>
  );
}

/** One request and what came back, if anything has. */
function RequestRow({
  kind,
  what,
  detail,
  status,
  requestedAt,
  by,
  answeredBy,
  answer,
}: {
  kind: 'Pharmacy' | 'Doctor';
  what: string;
  detail: string;
  status: string;
  requestedAt: string;
  by: string | null;
  answeredBy: string | null;
  answer: string | null;
}) {
  const open = status === 'REQUESTED';
  return (
    <div
      className={`rounded-sm border px-2.5 py-1.5 text-xs ${
        open
          ? 'border-border bg-bg'
          : status === 'DECLINED'
            ? 'border-[#f2c4be] bg-danger-soft'
            : 'border-[#b7dcc5] bg-success-soft'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="rounded-full bg-[#eef0f2] px-1.5 py-0.5 text-xxs font-semibold text-text-muted">
          {kind}
        </span>
        <span className="font-semibold text-text">{what}</span>
        <span className="ml-auto font-mono text-xxs text-text-subtle">
          {open ? 'waiting' : status.toLowerCase()} · {dateTime(requestedAt)}
        </span>
      </div>
      {detail && <div className="mt-0.5 text-text-muted">{detail}</div>}
      {by && <div className="text-xxs text-text-subtle">asked by {by}</div>}
      {/*
        The answer is shown in full, including a decline. "I asked and was
        told no, and here is why" is exactly what a nurse needs on record —
        and a refusal a ward cannot read is worse than a delay.
      */}
      {answer && (
        <div className="mt-1 border-t border-black/5 pt-1">
          {answeredBy ? <strong>{answeredBy}: </strong> : null}
          {answer}
        </div>
      )}
    </div>
  );
}

/**
 * Asking the pharmacy to send stock.
 *
 * Raised against a `prescriptionItemId` and nothing else — there is no way here
 * to name a medicine of your own. A supply request that could is a prescription
 * written by a nurse wearing a logistics label, which is the whole reason this
 * and `AskDoctorSheet` are separate things.
 */
function AskPharmacySheet({
  medicine,
  admissionId,
  onClose,
  onSaved,
  onError,
}: {
  medicine: ChartMedicine | null;
  admissionId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuantity('');
    setNote('');
  }, [medicine]);

  async function save() {
    if (!medicine) return;
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/supply-requests`, {
        method: 'POST',
        body: {
          prescriptionItemId: medicine.prescriptionItemId,
          ...(Number(quantity) > 0 ? { quantity: Number(quantity) } : {}),
          note: note.trim() || undefined,
        },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not send that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={medicine !== null}
      onClose={onClose}
      title="Ask pharmacy to send stock"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Sending…' : 'Send request'}
          </Button>
        </div>
      }
    >
      {medicine && (
        <div className="space-y-3">
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="font-semibold">{medicine.medicineName}</div>
            <div className="font-mono text-xs text-text-muted">
              {medicine.dosage} · {medicine.frequency}
            </div>
          </div>

          <p className="text-xs text-text-subtle">
            This is already prescribed. You are asking the pharmacy to send stock to the ward —
            it changes nothing on the chart.
          </p>

          <Field label="How many" hint="Optional. The pharmacist decides what actually goes.">
            <Input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 20"
            />
          </Field>

          <Field label="Note" hint="Anything the pharmacist needs to know — urgency, ward, timing.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Needed for the 20:00 round"
            />
          </Field>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Asking a doctor to prescribe something.
 *
 * The medicine is free text because the nurse is describing a need, not
 * choosing a product — "something for the nausea" is a legitimate request, and
 * a catalogue picker here would quietly make this a draft prescription with the
 * nurse's name on it.
 *
 * The outcome is a prescription written by a doctor through the ordinary route,
 * or a decline with a reason. Nothing about this puts a medicine on the chart.
 */
function AskDoctorSheet({
  open,
  admissionId,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  admissionId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [medicineText, setMedicineText] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMedicineText('');
    setReason('');
  }, [open]);

  async function save() {
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/medication-requests`, {
        method: 'POST',
        body: { medicineText: medicineText.trim(), reason: reason.trim() },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not send that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask a doctor to prescribe"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || medicineText.trim().length < 2 || reason.trim().length < 12}
            onClick={() => void save()}
          >
            {busy ? 'Sending…' : 'Send request'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="rounded-sm border border-border bg-bg px-2.5 py-2 text-xs text-text-muted">
          This asks a prescriber to write it. It does <strong>not</strong> add anything to the
          chart — the doctor writes the prescription, or declines and says why.
        </p>

        <Field
          label="What is needed"
          required
          hint="In your words. You are describing a need, not choosing a product."
        >
          <Input
            value={medicineText}
            onChange={(e) => setMedicineText(e.target.value)}
            placeholder="Something for nausea"
          />
        </Field>

        <Field
          label="Why"
          required
          hint="Required. A prescriber cannot answer “she needs something”, and a request with no clinical reason gets guessed at."
        >
          <Textarea
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Vomiting since 04:00, has not kept the morning dose down"
          />
        </Field>
      </div>
    </Sheet>
  );
}

/** One charted medicine and every dose of it this stay, past and future. */
function MedicineRow({
  medicine,
  onAskPharmacy,
}: {
  medicine: ChartMedicine;
  onAskPharmacy: () => void;
}) {
  const given = medicine.doses.filter((d) => d.status !== 'DUE').length;

  return (
    <div className="rounded-sm border border-border bg-surface p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-text">{medicine.medicineName}</span>
        <span className="font-mono text-xs text-text-muted">{medicine.dosage}</span>
        {/*
          Beside the medicine it is about, because "we have run out of THIS"
          is the thought a nurse is having when they reach for it. A generic
          "request supplies" button elsewhere would mean retyping a name that
          is already on screen, which is where transcription errors come from.
        */}
        <button onClick={onAskPharmacy} className="ml-auto text-xxs text-primary hover:underline">
          Ask pharmacy
        </button>
        <span className="font-mono text-xxs text-text-subtle">
          {given}/{medicine.doses.length} recorded
        </span>
      </div>
      <div className="mt-0.5 font-mono text-xs text-text-subtle">
        {medicine.scheduleLabel ?? medicine.frequency} · {medicine.duration}
        {medicine.prescriber ? ` · ${medicine.prescriber}` : ''}
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {medicine.doses.map((d) => (
          <span
            key={d.id}
            title={`${dateTime(d.dueAt)}${d.givenBy ? ` · ${d.givenBy}` : ''}${d.notes ? ` — ${d.notes}` : ''}`}
            className={`rounded-sm border px-1.5 py-0.5 font-mono text-xxs ${toneFor(d.status)}`}
          >
            {time(d.dueAt)}
            {d.status !== 'DUE' && ` ${GLYPH[d.status] ?? ''}`}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * A tick alone would make every non-DUE dose read as given. Refused, withheld
 * and missed are clinically different from each other and from given, and a
 * chart that blurs them is one a handover cannot be run from.
 */
const GLYPH: Record<string, string> = {
  GIVEN: '✓',
  REFUSED: '✗',
  WITHHELD: '⊘',
  MISSED: '!',
};

function toneFor(status: string): string {
  if (status === 'GIVEN') return 'border-[#b7dcc5] bg-success-soft text-success';
  if (status === 'MISSED') return 'border-[#f2c4be] bg-danger-soft text-danger';
  if (status === 'DUE') return 'border-border bg-bg text-text-muted';
  return 'border-[#ecdca6] bg-warning-soft text-[#6b5314]';
}

/**
 * Setting the times by hand.
 *
 * Clock times rather than "how many a day", because the nurse knows when the
 * ward's rounds are and the system does not. Offering "three times daily" here
 * would put us straight back to guessing which three times — which is the thing
 * `parseFrequency` correctly refuses to do.
 */
function SetTimesSheet({
  medicine,
  admissionId,
  onClose,
  onSaved,
  onError,
}: {
  medicine: ChartMedicine | null;
  admissionId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [times, setTimes] = useState<string[]>(['08:00']);
  const [days, setDays] = useState('3');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTimes(['08:00']);
    setDays('3');
  }, [medicine]);

  async function save() {
    if (!medicine) return;
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/medication-schedule/manual`, {
        method: 'POST',
        body: {
          prescriptionItemId: medicine.prescriptionItemId,
          times: times.filter(Boolean),
          days: Number(days),
        },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not set those times');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={medicine !== null}
      onClose={onClose}
      title="Set the dose times"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || times.filter(Boolean).length === 0}
            onClick={() => void save()}
          >
            {busy ? 'Adding…' : 'Add to chart'}
          </Button>
        </div>
      }
    >
      {medicine && (
        <div className="space-y-3">
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="font-semibold">{medicine.medicineName}</div>
            <div className="font-mono text-xs text-text-muted">
              {medicine.dosage} · written as “{medicine.frequency}”
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-text">
              Times each day <span className="text-danger">*</span>
            </label>
            <div className="space-y-1.5">
              {times.map((t, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    type="time"
                    value={t}
                    onChange={(e) => {
                      const next = [...times];
                      next[i] = e.target.value;
                      setTimes(next);
                    }}
                  />
                  {times.length > 1 && (
                    <Button size="sm" onClick={() => setTimes(times.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <Button size="sm" className="mt-1.5" onClick={() => setTimes([...times, '20:00'])}>
              Add another time
            </Button>
            <p className="mt-1 text-xxs text-text-subtle">
              Ward clock. Times already past today are skipped, so nothing opens as overdue.
            </p>
          </div>

          <Field label="Days to schedule">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              {[1, 2, 3, 5, 7, 14].map((d) => (
                <option key={d} value={d}>
                  {d} day{d === 1 ? '' : 's'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Recording an as-needed dose.
 *
 * There is no scheduled row to find and sign, because PRN never has one — so
 * the dose is created and signed in a single action. `whyNotScheduled` has told
 * nurses to "record each dose as it is given" since Phase 3, with nowhere in
 * either client to do it.
 */
function GivePrnSheet({
  medicine,
  admissionId,
  onClose,
  onSaved,
  onError,
}: {
  medicine: ChartMedicine | null;
  admissionId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setNotes(''), [medicine]);

  async function save() {
    if (!medicine) return;
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/doses`, {
        method: 'POST',
        body: {
          prescriptionItemId: medicine.prescriptionItemId,
          status: 'GIVEN',
          givenAt: new Date().toISOString(),
          notes: notes.trim() || undefined,
        },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not record that dose');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={medicine !== null}
      onClose={onClose}
      title="Record an as-needed dose"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Recording…' : 'Record as given'}
          </Button>
        </div>
      }
    >
      {medicine && (
        <div className="space-y-3">
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="font-semibold">{medicine.medicineName}</div>
            <div className="font-mono text-xs text-text-muted">
              {medicine.dosage} · {medicine.frequency}
            </div>
          </div>

          <Field
            label="Why was it given?"
            hint="Optional, and worth writing. An as-needed medicine is given on assessment, and the next nurse cannot see what you assessed."
          >
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. pain score 7"
            />
          </Field>

          <p className="text-xxs text-text-subtle">
            Recorded as given now. As-needed medicines are never scheduled, so this creates the
            entry and signs it in one step.
          </p>
        </div>
      )}
    </Sheet>
  );
}
