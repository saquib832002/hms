'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import type { MedicationRequest, Prescription } from '@/lib/types';
import { dateTime } from '@/lib/format';
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
 * Medication requests from the wards.
 *
 * A nurse has asked for something that is not on the patient's chart. The two
 * ways to close it are to write the prescription — through the ordinary
 * prescribing route, not from here — or to decline with a reason.
 *
 * WHY THERE IS NO "APPROVE" BUTTON
 * --------------------------------
 * The tempting design is a one-tap approve that creates the prescription from
 * the nurse's text. It reads as a convenience and is prescribing by
 * autocomplete: the medicine, dose and frequency would originate from the
 * person not licensed to choose them, with a prescriber's name attached.
 *
 * So the doctor prescribes normally and then links the prescription here. The
 * request is closed by *id*, and the server checks that prescription exists and
 * belongs to this patient — a status settable without one would let the chart
 * and the request disagree, and a nurse who reads "prescribed" and finds
 * nothing on the chart stops chasing.
 *
 * The queue is every open request in the hospital, not only this doctor's own
 * patients. Ward cover means the doctor who answers at 3am is routinely not the
 * one who admitted — the same reasoning that let `resolveTreatingScope` accept
 * an open admission rather than only the admitting doctor.
 */
const TABS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'prescribed', label: 'Prescribed' },
  { key: 'declined', label: 'Declined' },
] as const;

export default function MedicationRequestsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('waiting');
  const [rows, setRows] = useState<MedicationRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<MedicationRequest | null>(null);
  const [declining, setDeclining] = useState<MedicationRequest | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api<MedicationRequest[]>(`/medication-requests?status=${tab}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load requests');
    }
  }, [tab]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: answering === null && declining === null,
  });

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-4 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-sm px-2.5 py-1 text-sm ${
              tab === t.key ? 'bg-primary-soft font-semibold text-primary' : 'text-text-muted'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      {error && rows && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface p-4">
        {!rows && <TableSkeleton cols={4} />}

        {rows?.length === 0 && (
          <EmptyState
            title={tab === 'waiting' ? 'Nothing waiting' : `No ${tab} requests`}
            description={
              tab === 'waiting'
                ? 'Nurses ask here when a patient needs something that has not been prescribed.'
                : undefined
            }
          />
        )}

        <div className="max-w-3xl space-y-2.5">
          {rows?.map((r) => (
            <div key={r.id} className="rounded-md border border-border bg-surface p-3">
              <div className="flex items-baseline gap-2">
                <Link
                  href={`/patients?id=${r.admission.patient.id}`}
                  className="font-semibold text-text underline-offset-2 hover:underline"
                >
                  {r.admission.patient.fullName}
                </Link>
                <span className="font-mono text-xs text-text-muted">
                  {r.admission.bed?.label ?? '—'} · {r.admission.bed?.ward?.name ?? ''}
                </span>
                <span className="ml-auto font-mono text-xxs text-text-subtle">
                  {dateTime(r.requestedAt)}
                  {r.requestedBy ? ` · ${r.requestedBy.fullName}` : ''}
                </span>
              </div>

              {/*
                Allergies before the request, not after it. The prescriber is
                about to decide whether to write something, and this is the
                first thing they need — putting it below the ask means reading
                it second.
              */}
              {r.admission.patient.allergies.length > 0 && (
                <p
                  role="alert"
                  className="mt-2 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-1.5 text-xs text-[#8a2a1f]"
                >
                  <strong>Allergic to:</strong>{' '}
                  {r.admission.patient.allergies.map((a) => a.substance).join(', ')}
                </p>
              )}

              <div className="mt-2 text-sm">
                <span className="text-text-subtle">Asked for: </span>
                <strong className="text-text">{r.medicineText}</strong>
              </div>
              <div className="mt-0.5 text-sm text-text-muted">{r.reason}</div>

              {r.responseNote && (
                <div className="mt-2 border-t border-border pt-2 text-sm">
                  {r.respondedBy ? <strong>{r.respondedBy.fullName}: </strong> : null}
                  {r.responseNote}
                </div>
              )}

              {r.status === 'REQUESTED' && (
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => setAnswering(r)}>
                    I have prescribed it
                  </Button>
                  <Button size="sm" onClick={() => setDeclining(r)}>
                    Decline
                  </Button>
                  {/*
                    The prescribing sheet is on the patient record, and that is
                    where it stays. A second prescribing path reachable from a
                    nurse's request is exactly how "the nurse never prescribes"
                    quietly stops being true.
                  */}
                  <Link
                    href={`/patients?id=${r.admission.patient.id}&tab=prescriptions`}
                    className="self-center text-xs text-primary hover:underline"
                  >
                    Open the patient to write it →
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <LinkPrescriptionSheet
        request={answering}
        onClose={() => setAnswering(null)}
        onDone={() => {
          setAnswering(null);
          void load();
        }}
        onError={setError}
      />

      <DeclineSheet
        request={declining}
        onClose={() => setDeclining(null)}
        onDone={() => {
          setDeclining(null);
          void load();
        }}
        onError={setError}
      />
    </>
  );
}

/**
 * Closing a request against a prescription that already exists.
 *
 * The list is this patient's prescriptions, newest first, so the doctor picks
 * the one they just wrote. Nothing here creates one.
 */
function LinkPrescriptionSheet({
  request,
  onClose,
  onDone,
  onError,
}: {
  request: MedicationRequest | null;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [options, setOptions] = useState<Prescription[] | null>(null);
  const [prescriptionId, setPrescriptionId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const patientId = request?.admission.patient.id;

  useEffect(() => {
    setOptions(null);
    setPrescriptionId('');
    setNote('');
    if (!patientId) return;
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => {
        const usable = r.data.filter((p) => p.status !== 'CANCELLED');
        setOptions(usable);
        if (usable.length > 0) setPrescriptionId(String(usable[0].id));
      })
      .catch(() => setOptions([]));
  }, [patientId]);

  async function save() {
    if (!request || !prescriptionId) return;
    setBusy(true);
    try {
      await api(`/medication-requests/${request.id}/fulfil`, {
        method: 'POST',
        body: { prescriptionId: Number(prescriptionId), note: note.trim() || undefined },
      });
      onDone();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not close that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={request !== null}
      onClose={onClose}
      title="Link the prescription"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !prescriptionId} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Close the request'}
          </Button>
        </div>
      }
    >
      {request && (
        <div className="space-y-3">
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="font-semibold">{request.admission.patient.fullName}</div>
            <div className="text-xs text-text-muted">asked for {request.medicineText}</div>
          </div>

          {options?.length === 0 ? (
            <p className="text-sm text-text-subtle">
              This patient has no prescriptions to link. Write one first, then come back — the
              request stays waiting until you do.
            </p>
          ) : (
            <Field label="Which prescription answers this" required>
              <Select
                value={prescriptionId}
                onChange={(e) => setPrescriptionId(e.target.value)}
                disabled={!options}
              >
                {!options && <option>Loading…</option>}
                {options?.map((p) => (
                  <option key={p.id} value={p.id}>
                    #{p.id} · {p.items.map((i) => i.medicineName).join(', ').slice(0, 60)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Note back to the ward" hint="Optional.">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Declining, and the reason is kept forever.
 *
 * A decline is a clinical decision worth reading later, not an absence of one —
 * and "I asked and was told no, and here is why" is precisely what the nurse
 * needs on record.
 */
function DeclineSheet({
  request,
  onClose,
  onDone,
  onError,
}: {
  request: MedicationRequest | null;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setReason(''), [request]);

  async function save() {
    if (!request) return;
    setBusy(true);
    try {
      await api(`/medication-requests/${request.id}/decline`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      onDone();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not decline that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={request !== null}
      onClose={onClose}
      title="Decline this request"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 5}
            onClick={() => void save()}
          >
            {busy ? 'Declining…' : 'Decline'}
          </Button>
        </div>
      }
    >
      {request && (
        <div className="space-y-3">
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="font-semibold">{request.admission.patient.fullName}</div>
            <div className="text-xs text-text-muted">asked for {request.medicineText}</div>
            <div className="mt-1 text-xs text-text-subtle">{request.reason}</div>
          </div>

          <Field
            label="Why"
            required
            hint="The ward sees this and it stays on record. Say what they should do instead, if anything."
          >
            <Textarea
              autoFocus
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Already covered by the regular antiemetic at 14:00 — review if still symptomatic after that."
            />
          </Field>
        </div>
      )}
    </Sheet>
  );
}
