'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Dose, DoseStatus, MedicationRound, Ward } from '@/lib/types';
import { time } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Select,
  TableSkeleton,
  Textarea,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * The ward's drug chart for today, and signing for the doses on it.
 *
 * WHY THIS STOPPED BEING READ-ONLY
 * --------------------------------
 * It was web-read-only for six phases, on the argument that signing for a dose
 * is an act performed at the bedside with the patient and the medicine in front
 * of you, and that a desktop button labelled "given" invites signing for
 * something you have not yet done.
 *
 * That argument is real and it is not the whole picture. A drug trolley on a
 * ward round is pushed alongside a computer-on-wheels in most hospitals that
 * have one, and the ward terminal is where the round is actually recorded in a
 * clinic with no phones issued. The screen said *Sign for doses on the mobile
 * app* to a nurse who did not have one, which is not a curation decision — it
 * is a dead end.
 *
 * It is the same failure as reception being locked out of mobile for six
 * phases, and dispensing being web-only because it happens "at the counter":
 * a plausible story about where work happens, standing in for the fact that
 * nobody built the other half. The standing instruction in CLAUDE.md — every
 * feature on both clients, in the same change — overrides the curation
 * argument, and this is exactly the case it was written for.
 *
 * The safeguard the original argument wanted is kept, and it was always the
 * better answer than withholding the screen: anything other than "given"
 * demands a written reason, and the confirmation names the patient, the bed and
 * the medicine, so a click cannot be a reflex.
 *
 * `endpoint-coverage.spec.ts` could not see this. Both clients call
 * `GET /medications/round/:wardId`, so the round looked covered; what differed
 * was that only one of them could write. `PATCH /medications/doses/:id` sat in
 * `MOBILE_ONLY` with the reason "the web round posts against the schedule",
 * which was simply untrue — the web round posted nothing at all.
 */
export default function MedicationsPage() {
  const [wards, setWards] = useState<Ward[]>([]);
  // See the ward board for why this is tracked separately from `wards.length`:
  // no wards left this screen on a permanent loading skeleton too.
  const [wardsLoaded, setWardsLoaded] = useState(false);
  const [wardId, setWardId] = useState<number | null>(null);
  const [round, setRound] = useState<MedicationRound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Dose | null>(null);
  /*
   * A request that never resolves is indistinguishable from a fast one while
   * the skeleton is up. It stays a skeleton, so this only adds a line saying
   * the server has not answered — enough to tell "nothing here" apart from
   * "nothing came back", which is the distinction that had people reporting a
   * working screen as a hung backend.
   */
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    api<Ward[]>('/wards')
      .then((w) => {
        setWards(w);
        setWardId((prev) => prev ?? w[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load wards'))
      .finally(() => setWardsLoaded(true));
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

  if (wardsLoaded && wards.length === 0) {
    return (
      <EmptyState
        title="No wards have been set up yet"
        description="A drug chart belongs to an admitted patient, and there is nowhere to admit one until a ward exists. An administrator adds them under Settings → Wards & Beds."
      />
    );
  }

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
          {/*
            This said "Sign for doses on the mobile app", which was a dead end
            for any nurse without one. The round is signed here too now.
          */}
          <span className="text-xxs text-text-subtle">
            Also available on the mobile app, offline
          </span>
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!round && (
          <>
            {slow && (
              <p className="border-b border-border px-4 py-2 text-xs text-text-subtle">
                Still waiting for the server. Nothing has failed yet — if this does not clear,
                the API may not be running.
              </p>
            )}
            <TableSkeleton cols={6} />
          </>
        )}
        {round && total === 0 && round.completed.length === 0 && (
          <EmptyState title="No doses scheduled" description="Nothing is charted for this ward today." />
        )}

        {round && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Due', 'Bed', 'Patient', 'Medicine', 'Dose', 'Status', ''].map((h) => (
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
              <Group title="Overdue" doses={round.overdue} tone="danger" onRecord={setRecording} />
              <Group title="Due now" doses={round.dueNow} tone="warning" onRecord={setRecording} />
              <Group title="Upcoming" doses={round.upcoming} onRecord={setRecording} />
              {/*
                Already signed for, so no action. Reopening a recorded dose
                would be an edit to a clinical record, which is a correction
                with its own trail rather than a second click on a button.
              */}
              <Group title="Recorded" doses={round.completed} tone="success" />
            </tbody>
          </table>
        )}
      </div>

      <RecordDoseSheet
        dose={recording}
        onClose={() => setRecording(null)}
        onRecorded={() => {
          setRecording(null);
          void refreshNow();
        }}
        onError={setError}
      />
    </>
  );
}

/**
 * Signing for one dose.
 *
 * "Given" is one click; everything else demands a written reason, because at a
 * handover "not given" without a why is close to useless — and the server
 * rejects it anyway, so asking here saves a round trip and a confusing error.
 * Identical rule to the mobile sheet, deliberately: a nurse who learns one
 * should not have to learn the other.
 *
 * The patient, bed and medicine are restated at the moment of signing. That is
 * the safeguard the old web-read-only rule was reaching for, and it is the
 * better version of it — withholding the screen from a nurse at a ward
 * terminal did not make the round safer, it made it unrecorded.
 */
function RecordDoseSheet({
  dose,
  onClose,
  onRecorded,
  onError,
}: {
  dose: Dose | null;
  onClose: () => void;
  onRecorded: () => void;
  onError: (m: string) => void;
}) {
  const [choice, setChoice] = useState<DoseStatus | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setChoice(null);
    setNotes('');
  }, [dose]);

  async function record(status: DoseStatus) {
    if (!dose) return;
    setBusy(true);
    try {
      await api(`/medications/doses/${dose.id}`, {
        method: 'PATCH',
        body: {
          status,
          notes: notes.trim() || undefined,
          // When it was given, not when the request arrived. On a slow ward
          // network those differ, and the chart should show the former.
          givenAt: new Date().toISOString(),
        },
      });
      onRecorded();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not record that dose');
    } finally {
      setBusy(false);
    }
  }

  const reasonTooShort = notes.trim().length < 3;

  return (
    <Sheet
      open={dose !== null}
      onClose={onClose}
      title="Record this dose"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {choice && (
            <Button
              variant="primary"
              disabled={busy || reasonTooShort}
              onClick={() => void record(choice)}
            >
              {busy ? 'Recording…' : `Record as ${choice.toLowerCase()}`}
            </Button>
          )}
        </div>
      }
    >
      {dose && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="font-mono text-xs font-bold text-text-subtle">{dose.bed}</div>
            <div className="font-medium text-text">{dose.patient.fullName}</div>
            <div className="text-sm text-text-muted">
              {dose.medicineName} · {dose.dosage}
            </div>
            <div className="mt-1 font-mono text-xs text-text-subtle">Due {time(dose.dueAt)}</div>
          </div>

          {dose.patient.hasAllergies && (
            <p
              role="alert"
              className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-xs text-[#8a2a1f]"
            >
              ⚠ This patient has recorded allergies — check the chart before giving.
            </p>
          )}

          {!choice ? (
            <div className="grid gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void record('GIVEN')}>
                Given
              </Button>
              <Button onClick={() => setChoice('REFUSED')}>Patient refused</Button>
              <Button onClick={() => setChoice('WITHHELD')}>Withheld</Button>
              <Button variant="danger" onClick={() => setChoice('MISSED')}>
                Missed
              </Button>
            </div>
          ) : (
            <Field
              label={`Why was this dose ${choice.toLowerCase()}?`}
              required
              hint="This appears at handover, so write it for the nurse taking over."
            >
              <Textarea
                autoFocus
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Required"
              />
            </Field>
          )}

          {choice && (
            <button onClick={() => setChoice(null)} className="text-xs text-primary hover:underline">
              ← back to the options
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Group({
  title,
  doses,
  tone,
  onRecord,
}: {
  title: string;
  doses: Dose[];
  tone?: 'danger' | 'warning' | 'success';
  /** Omitted for doses already signed for — a recorded dose offers no action. */
  onRecord?: (d: Dose) => void;
}) {
  if (doses.length === 0) return null;
  const colour =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-text-subtle';

  return (
    <>
      <tr>
        <td
          colSpan={7}
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
          <td className="border-b border-[#f0f2f4] px-3 py-2 text-right">
            {onRecord && d.status === 'DUE' && (
              <Button size="sm" onClick={() => onRecord(d)}>
                Record
              </Button>
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
