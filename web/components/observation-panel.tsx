'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { ObservationFrequency, ObservationSummary } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { relativeAge } from '@/lib/use-auto-refresh';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * The observation plan for an admitted patient, and the escalation trail.
 *
 * WHAT THIS REPLACES
 * ------------------
 * `OBSERVATION_INTERVAL_HOURS = 4`, applied by the ward board to every patient
 * in the hospital, changeable by nobody. One number, in a source file, deciding
 * whether a nurse gets chased about somebody deteriorating — for a patient four
 * hours post-operative and for one waiting on a lift home alike.
 *
 * WHO MAY CHANGE IT
 * -----------------
 * A doctor sets the plan. A nurse may **tighten** it and never relax it:
 * watching somebody more closely because they look unwell is the entire reason
 * there is a nurse at the bedside and must not wait for a doctor to be found,
 * while deciding somebody needs *less* watching is a judgement about their
 * condition. The server enforces it; this screen only shows what it will allow.
 */
const FREQUENCIES: { value: ObservationFrequency; label: string }[] = [
  { value: 'QUARTER_HOURLY', label: 'Every 15 minutes' },
  { value: 'HALF_HOURLY', label: 'Every 30 minutes' },
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'TWO_HOURLY', label: '2-hourly' },
  { value: 'FOUR_HOURLY', label: '4-hourly' },
  { value: 'SIX_HOURLY', label: '6-hourly' },
  { value: 'TWELVE_HOURLY', label: '12-hourly' },
  { value: 'DAILY', label: 'Once daily' },
];

export function ObservationPanel({
  admissionId,
  canRelax,
  refreshKey,
}: {
  admissionId: number;
  /** True for a doctor. A nurse sees the looser options disabled, not hidden. */
  canRelax: boolean;
  /** Bumped by the parent after an observation is recorded, to re-read "due". */
  refreshKey: number;
}) {
  const [summary, setSummary] = useState<ObservationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingOrder, setSettingOrder] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [responding, setResponding] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api<ObservationSummary>(`/admissions/${admissionId}/observations`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the observation plan');
    }
  }, [admissionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!summary) return null;

  const { order } = summary;

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xxs font-bold uppercase tracking-wider text-text-subtle">
          Observation plan
        </h3>
        <Button size="sm" className="ml-auto" onClick={() => setSettingOrder(true)}>
          Change
        </Button>
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-lg font-bold text-text">{order.label}</span>
        {/*
          "The doctor wants 4-hourly" and "nobody has thought about it" look
          identical on a screen and mean different things. The default is
          labelled as one so a ward round can see what has actually been decided.
        */}
        {!order.isExplicit && (
          <span className="rounded-full bg-[#eef0f2] px-2 py-0.5 text-xxs font-semibold text-text-muted">
            default — nobody has set one
          </span>
        )}
        {order.isEscalation && (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xxs font-semibold text-warning">
            raised by nursing
          </span>
        )}
      </div>

      {order.setBy && (
        <div className="mt-0.5 text-xs text-text-subtle">
          set by {order.setBy} · {order.setAt ? dateTime(order.setAt) : ''}
          {order.reason ? ` — ${order.reason}` : ''}
        </div>
      )}

      <dl className="mt-2.5 space-y-0.5 border-t border-border pt-2 text-xs">
        <Row
          label="Last observed"
          value={
            summary.lastObservedAt
              ? `${relativeAge(new Date(summary.lastObservedAt))} · ${dateTime(summary.lastObservedAt)}`
              : 'never'
          }
          tone={summary.neverObserved ? 'danger' : undefined}
        />
        <Row
          label="Next due"
          value={summary.nextDueAt ? dateTime(summary.nextDueAt) : 'as soon as possible'}
          tone={summary.overdue ? 'danger' : undefined}
        />
      </dl>

      {/*
        A patient with no observations at all is overdue, and it is the case
        that matters most: somebody admitted an hour ago whose baseline was
        never taken is exactly who should be shouted about, and reading no data
        as nothing-to-worry-about is how they stay invisible.
      */}
      {summary.overdue && (
        <p
          role="alert"
          className="mt-2 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-1.5 text-xs font-semibold text-[#8a2a1f]"
        >
          {summary.neverObserved
            ? 'No observations have ever been recorded for this stay.'
            : 'Observations are overdue.'}
        </p>
      )}

      <div className="mt-3 flex items-baseline border-t border-border pt-2">
        <h3 className="text-xxs font-bold uppercase tracking-wider text-text-subtle">
          Escalations
          {summary.openEscalations > 0 && (
            <span className="ml-1.5 text-danger">{summary.openEscalations} open</span>
          )}
        </h3>
        <Button size="sm" variant="danger" className="ml-auto" onClick={() => setEscalating(true)}>
          Escalate
        </Button>
      </div>

      {summary.escalations.length === 0 ? (
        <p className="mt-1.5 text-xs text-text-subtle">
          Nothing escalated this stay. Record it here when you raise a concern — who you told and
          what was said is the first thing asked afterwards.
        </p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {summary.escalations.map((e) => (
            <div
              key={e.id}
              className={`rounded-sm border px-2.5 py-1.5 text-xs ${
                e.respondedAt ? 'border-border bg-bg' : 'border-[#f2c4be] bg-danger-soft'
              }`}
            >
              <div className="flex items-baseline gap-2">
                <strong className="text-text">{e.escalatedTo}</strong>
                <span className="ml-auto font-mono text-xxs text-text-subtle">
                  {dateTime(e.raisedAt)}
                  {e.raisedBy ? ` · ${e.raisedBy.fullName}` : ''}
                </span>
              </div>
              <div className="mt-0.5 text-text-muted">{e.concern}</div>

              {e.respondedAt ? (
                <div className="mt-1 border-t border-black/5 pt-1 text-text">{e.response}</div>
              ) : (
                /*
                  An escalation nobody answered is the finding, not a gap in the
                  data. It stays visibly open rather than being filled in later
                  in one go, which would quietly lose every unanswered call.
                */
                <div className="mt-1 flex items-baseline gap-2 border-t border-[#f2c4be]/50 pt-1">
                  <span className="font-semibold text-[#8a2a1f]">No response recorded</span>
                  <button
                    onClick={() => setResponding(e.id)}
                    className="ml-auto text-primary hover:underline"
                  >
                    Record what came back
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <SetOrderSheet
        open={settingOrder}
        admissionId={admissionId}
        current={order.frequency}
        canRelax={canRelax}
        onClose={() => setSettingOrder(false)}
        onSaved={() => {
          setSettingOrder(false);
          void load();
        }}
        onError={setError}
      />

      <EscalateSheet
        open={escalating}
        admissionId={admissionId}
        onClose={() => setEscalating(false)}
        onSaved={() => {
          setEscalating(false);
          void load();
        }}
        onError={setError}
      />

      <RespondSheet
        escalationId={responding}
        onClose={() => setResponding(null)}
        onSaved={() => {
          setResponding(null);
          void load();
        }}
        onError={setError}
      />
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`font-mono ${tone === 'danger' ? 'font-semibold text-danger' : 'text-text'}`}>
        {value}
      </dd>
    </div>
  );
}

const MINUTES: Record<ObservationFrequency, number> = {
  QUARTER_HOURLY: 15,
  HALF_HOURLY: 30,
  HOURLY: 60,
  TWO_HOURLY: 120,
  FOUR_HOURLY: 240,
  SIX_HOURLY: 360,
  TWELVE_HOURLY: 720,
  DAILY: 1440,
};

function SetOrderSheet({
  open,
  admissionId,
  current,
  canRelax,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  admissionId: number;
  current: ObservationFrequency;
  canRelax: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [frequency, setFrequency] = useState<ObservationFrequency>(current);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFrequency(current);
    setReason('');
  }, [open, current]);

  async function save() {
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/observations/order`, {
        method: 'POST',
        body: { frequency, reason: reason.trim() || undefined },
      });
      onSaved();
    } catch (e) {
      // The server explains the nurse-cannot-relax refusal in its own words,
      // naming the current frequency — better than anything guessable here.
      onError(e instanceof ApiError ? e.message : 'Could not change the observation plan');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Change the observation plan"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Set'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="How often" required>
          <Select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ObservationFrequency)}
          >
            {FREQUENCIES.map((f) => {
              // Disabled rather than hidden: a nurse should be able to see that
              // 12-hourly exists and that relaxing to it is a doctor's call,
              // rather than wondering why the option vanished.
              const relaxing = MINUTES[f.value] > MINUTES[current];
              return (
                <option key={f.value} value={f.value} disabled={relaxing && !canRelax}>
                  {f.label}
                  {relaxing && !canRelax ? ' — doctor only' : ''}
                </option>
              );
            })}
          </Select>
        </Field>

        {!canRelax && (
          <p className="rounded-sm border border-border bg-bg px-2.5 py-2 text-xs text-text-muted">
            You can increase how often observations are taken. Relaxing them is a decision about
            how closely this patient needs watching, so it goes to the treating doctor.
          </p>
        )}

        <Field label="Why" hint="Read at handover. Worth a line even when it is obvious.">
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Pyrexial, BP dropping since 14:00"
          />
        </Field>
      </div>
    </Sheet>
  );
}

/**
 * Recording an escalation.
 *
 * `escalatedTo` is free text because the on-call registrar covering a ward at
 * 3am usually has no account in this hospital's system, and demanding a user id
 * would mean the commonest real escalation could not be recorded at all.
 */
function EscalateSheet({
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
  const [escalatedTo, setTo] = useState('');
  const [concern, setConcern] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTo('');
    setConcern('');
  }, [open]);

  async function save() {
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/observations/escalations`, {
        method: 'POST',
        body: { escalatedTo: escalatedTo.trim(), concern: concern.trim() },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not record that escalation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record an escalation"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || escalatedTo.trim().length < 2 || concern.trim().length < 5}
            onClick={() => void save()}
          >
            {busy ? 'Recording…' : 'Record'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="rounded-sm border border-border bg-bg px-2.5 py-2 text-xs text-text-muted">
          This records that you raised a concern. It does not contact anybody — make the call, then
          write down who you spoke to and what you said.
        </p>

        <Field label="Who did you tell" required hint="A name and a role. They need no account here.">
          <Input
            value={escalatedTo}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Dr Okafor, medical registrar on call"
          />
        </Field>

        <Field
          label="What was the concern"
          required
          hint="The numbers, and how the patient looked. This is the part read back later."
        >
          <Textarea
            rows={4}
            value={concern}
            onChange={(e) => setConcern(e.target.value)}
            placeholder="BP 88/54, pulse 122, clammy and drowsy since the 02:00 set."
          />
        </Field>
      </div>
    </Sheet>
  );
}

/** What came back. Separate from raising it, because the gap is the finding. */
function RespondSheet({
  escalationId,
  onClose,
  onSaved,
  onError,
}: {
  escalationId: number | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setResponse(''), [escalationId]);

  async function save() {
    if (!escalationId) return;
    setBusy(true);
    try {
      await api(`/escalations/${escalationId}/response`, {
        method: 'PATCH',
        body: { response: response.trim() },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not record that response');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={escalationId !== null}
      onClose={onClose}
      title="What came back"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || response.trim().length < 2} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Record'}
          </Button>
        </div>
      }
    >
      <Field
        label="Response"
        required
        hint="What you were told to do, or that they are coming — and when."
      >
        <Textarea
          autoFocus
          rows={4}
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          placeholder="Attending within 20 minutes. Repeat obs meanwhile and start fluids."
        />
      </Field>
    </Sheet>
  );
}
