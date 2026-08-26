'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Allergy, Patient, Prescription } from '@/lib/types';
import { titleCase } from '@/lib/format';
import { Button, Field, Input, Textarea, SectionLabel } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { AllergyBanner } from '@/components/allergy-banner';

interface Item {
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
}

const EMPTY: Item = { medicineName: '', dosage: '', frequency: '', duration: '' };

/**
 * A side sheet, not a dialog — clinical forms need the room, and the patient
 * header stays pinned so the doctor cannot lose track of who they are
 * prescribing for.
 */
export function PrescriptionSheet({
  open,
  onClose,
  patientId,
  patientName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  patientId: number;
  patientName: string;
  onSaved: () => void;
}) {
  const [items, setItems] = useState<Item[]>([{ ...EMPTY }]);
  const [notes, setNotes] = useState('');
  const [allergies, setAllergies] = useState<Allergy[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<Prescription | null>(null);

  useEffect(() => {
    if (!open) {
      setItems([{ ...EMPTY }]);
      setNotes('');
      setError(null);
      setIssued(null);
      return;
    }
    api<Patient>(`/patients/${patientId}`)
      .then((p) => setAllergies(p.allergies))
      .catch(() => setAllergies(undefined));
  }, [open, patientId]);

  const setItem = (i: number, k: keyof Item, v: string) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)));

  /**
   * Client-side allergy hint, shown as the doctor types.
   *
   * Substring matching only — it catches "Penicillin V" against a penicillin
   * allergy and misses "Amoxicillin", which is a penicillin sharing no
   * substring. The server runs the same check and returns authoritative
   * warnings on save. Neither blocks the prescription in Phase 1; making an
   * unreliable check look authoritative would be worse than not having it.
   */
  const localWarnings = (medicineName: string) => {
    if (!allergies?.length || medicineName.trim().length < 3) return [];
    const med = medicineName.toLowerCase();
    return allergies.filter(
      (a) => med.includes(a.substance.toLowerCase()) || a.substance.toLowerCase().includes(med),
    );
  };

  const valid = items.every(
    (i) => i.medicineName.trim() && i.dosage.trim() && i.frequency.trim() && i.duration.trim(),
  );

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const created = await api<Prescription>('/prescriptions', {
        method: 'POST',
        body: { patientId, items, notes: notes || undefined },
      });
      setIssued(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the prescription');
    } finally {
      setSubmitting(false);
    }
  }

  if (issued) {
    return (
      <Sheet
        open={open}
        onClose={() => {
          setIssued(null);
          onSaved();
        }}
        title="Prescription issued"
        footer={
          <>
            <a href={`/api/v1/prescriptions/${issued.id}/print`} target="_blank" rel="noreferrer">
              <Button variant="primary">Print</Button>
            </a>
            <Button
              onClick={() => {
                setIssued(null);
                onSaved();
              }}
            >
              Done
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Prescription <span className="font-mono">#{issued.id}</span> issued for{' '}
          <strong>{patientName}</strong>.
        </p>

        {issued.allergyWarnings && issued.allergyWarnings.length > 0 && (
          <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
            <strong>Allergy warnings recorded.</strong>
            <ul className="mt-1 list-inside list-disc text-xs">
              {issued.allergyWarnings.map((w, i) => (
                <li key={i}>
                  {w.matchedMedicine} matches a recorded {titleCase(w.severity)} allergy to{' '}
                  {w.substance}
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className="mt-3 space-y-1">
          {issued.items.map((i) => (
            <li key={i.id} className="font-mono text-xs">
              {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New prescription"
      footer={
        <>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? 'Issuing…' : 'Issue prescription'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {/* States the consequence rather than saying "Submit". */}
          <span className="text-xxs leading-tight text-text-muted">
            Cannot be edited
            <br />
            once dispensed
          </span>
        </>
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{patientName}</div>
        <div className="font-mono text-xs text-text-muted">#{patientId}</div>
      </div>

      <div className="mt-2.5">
        <AllergyBanner allergies={allergies} />
      </div>

      <SectionLabel>Medicines</SectionLabel>

      {items.map((item, i) => {
        const warnings = localWarnings(item.medicineName);
        return (
          <div key={i} className="mb-2.5 rounded-sm border border-border bg-[#fcfcfd] p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xxs font-semibold uppercase tracking-wider text-text-subtle">
                Medicine {i + 1}
              </span>
              {items.length > 1 && (
                <button
                  onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-xs text-danger hover:underline"
                >
                  Remove
                </button>
              )}
            </div>

            <Field label="Medicine" required>
              <Input
                value={item.medicineName}
                onChange={(e) => setItem(i, 'medicineName', e.target.value)}
                className={warnings.length ? 'border-danger' : ''}
              />
            </Field>

            {warnings.length > 0 && (
              <div className="mb-2.5 rounded-sm border border-[#ecdca6] bg-warning-soft px-2.5 py-2 text-xs text-[#6b5314]">
                <strong>⚠ Possible allergy conflict.</strong> This patient has a recorded{' '}
                {warnings.map((w) => `${titleCase(w.severity)} allergy to ${w.substance}`).join(', ')}
                . Verify before issuing.
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Dosage" required>
                <Input value={item.dosage} onChange={(e) => setItem(i, 'dosage', e.target.value)} placeholder="5 mg" />
              </Field>
              <Field label="Frequency" required>
                <Input
                  value={item.frequency}
                  onChange={(e) => setItem(i, 'frequency', e.target.value)}
                  placeholder="Once daily"
                />
              </Field>
            </div>
            <Field label="Duration" required>
              <Input
                value={item.duration}
                onChange={(e) => setItem(i, 'duration', e.target.value)}
                placeholder="30 days"
              />
            </Field>
          </div>
        );
      })}

      <Button className="w-full" onClick={() => setItems((prev) => [...prev, { ...EMPTY }])}>
        + Add medicine
      </Button>

      <SectionLabel>Instructions</SectionLabel>
      <Textarea
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional instructions for the patient…"
      />

      {error && (
        <div role="alert" className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]">
          {error}
        </div>
      )}
    </Sheet>
  );
}
