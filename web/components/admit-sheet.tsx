'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { BedRow, Paginated, PatientListItem } from '@/lib/types';
import { Button, Field, Input, Select, SectionLabel } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Admit a patient to a bed.
 *
 * Web-only, deliberately. Bed management is desk work — it means knowing what
 * is free across the ward and coordinating with whoever is discharging. The
 * phone covers what happens *at* the bedside; this is what happens at the
 * nurses' station.
 *
 * Only free, in-service beds are offered. The server enforces the real
 * guarantee via a unique index, so a 409 here means someone else took the bed
 * between this list loading and the submit — which is why the error is shown
 * verbatim and the board reloads.
 */
export function AdmitSheet({
  open,
  beds,
  onClose,
  onAdmitted,
}: {
  open: boolean;
  beds: BedRow[];
  onClose: () => void;
  onAdmitted: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientListItem[]>([]);
  const [patient, setPatient] = useState<PatientListItem | null>(null);
  const [bedId, setBedId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setPatient(null);
      setBedId('');
      setReason('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api<Paginated<PatientListItem>>(`/patients?q=${encodeURIComponent(q)}&limit=6`)
        .then((r) => !cancelled && setResults(r.data))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const freeBeds = beds.filter((b) => !b.admission && b.bed.isActive);

  async function submit() {
    if (!patient || !bedId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api('/admissions', {
        method: 'POST',
        body: { patientId: patient.id, bedId: Number(bedId), reason: reason || undefined },
      });
      onAdmitted();
    } catch (err) {
      // 409 is either "bed taken" or "patient already admitted" — the server
      // distinguishes them, so show what it said rather than guessing.
      setError(err instanceof ApiError ? err.message : 'Could not admit that patient');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Admit a patient"
      footer={
        <>
          <Button
            variant="primary"
            disabled={!patient || !bedId || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Admitting…' : 'Admit to bed'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <SectionLabel>Patient</SectionLabel>
      {patient ? (
        <div className="mb-3 flex items-center justify-between rounded-sm border border-border bg-bg px-2.5 py-1.5">
          <span className="text-sm font-medium">
            {patient.fullName}{' '}
            <span className="font-mono text-xs text-text-muted">
              #{patient.id} · {patient.age}y
            </span>
          </span>
          <Button size="sm" onClick={() => setPatient(null)}>
            Change
          </Button>
        </div>
      ) : (
        <Field label="Search" required>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or phone…"
            autoFocus
          />
          {results.length > 0 && (
            <div className="mt-1 max-h-40 overflow-y-auto rounded-sm border border-border">
              {results.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPatient(p)}
                  className="flex w-full justify-between px-2.5 py-1.5 text-left text-sm hover:bg-primary-soft"
                >
                  <span>
                    {p.fullName}
                    {p.hasAllergies && (
                      <span
                        title="Has recorded allergies"
                        className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle"
                      />
                    )}
                  </span>
                  <span className="font-mono text-xs text-text-subtle">#{p.id}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
      )}

      <SectionLabel>Bed</SectionLabel>
      <Field
        label="Available beds"
        required
        hint={
          freeBeds.length === 0
            ? 'This ward is full. Discharge or transfer someone first.'
            : `${freeBeds.length} free on this ward`
        }
      >
        <Select value={bedId} onChange={(e) => setBedId(e.target.value)} disabled={freeBeds.length === 0}>
          <option value="">Select a bed…</option>
          {freeBeds.map((b) => (
            <option key={b.bed.id} value={b.bed.id}>
              {b.bed.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Reason for admission" hint="Brief — the clinical detail belongs in the record.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </Field>

      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}

/**
 * Move a patient to another bed.
 *
 * A transfer is one continuous stay, not a discharge and a readmission —
 * splitting it would orphan the observations and doses already recorded
 * against the admission.
 */
export function TransferSheet({
  row,
  beds,
  onClose,
  onTransferred,
}: {
  row: BedRow | null;
  beds: BedRow[];
  onClose: () => void;
  onTransferred: () => void;
}) {
  const [bedId, setBedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setBedId('');
    setError(null);
  }, [row]);

  if (!row?.admission) return null;

  const freeBeds = beds.filter((b) => !b.admission && b.bed.isActive);

  async function submit() {
    if (!row?.admission || !bedId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/admissions/${row.admission.id}/transfer`, {
        method: 'PATCH',
        body: { bedId: Number(bedId) },
      });
      onTransferred();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not transfer that patient');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Transfer patient"
      footer={
        <>
          <Button variant="primary" disabled={!bedId || submitting} onClick={() => void submit()}>
            {submitting ? 'Moving…' : 'Move patient'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{row.admission.patient.fullName}</div>
        <div className="font-mono text-xs text-text-muted">Currently in {row.bed.label}</div>
      </div>

      <p className="mb-3 mt-2.5 text-xs text-text-subtle">
        Observations and medication already recorded stay with this admission.
      </p>

      <Field label="New bed" required>
        <Select value={bedId} onChange={(e) => setBedId(e.target.value)}>
          <option value="">Select a bed…</option>
          {freeBeds.map((b) => (
            <option key={b.bed.id} value={b.bed.id}>
              {b.bed.label}
            </option>
          ))}
        </Select>
      </Field>

      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}
