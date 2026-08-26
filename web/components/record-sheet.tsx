'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input, Textarea } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Write a clinical record.
 *
 * There is no edit flow, deliberately. A clinical note is a contemporaneous
 * account of what a clinician observed; editing it afterwards destroys that.
 * Corrections are handled as an addendum — a new record referencing the
 * original — which is a Phase 2 feature rather than an UPDATE button.
 */
export function RecordSheet({
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
  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setDiagnosis('');
      setNotes('');
      setError(null);
    }
  }, [open]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/patients/${patientId}/records`, {
        method: 'POST',
        body: { diagnosis: diagnosis.trim(), notes: notes.trim() || undefined },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the record');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a medical record"
      footer={
        <>
          <Button
            variant="primary"
            disabled={diagnosis.trim().length < 2 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Saving…' : 'Save record'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <span className="text-xxs leading-tight text-text-muted">
            Records cannot
            <br />
            be edited later
          </span>
        </>
      }
    >
      <div className="mb-3 rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{patientName}</div>
        <div className="font-mono text-xs text-text-muted">#{patientId}</div>
      </div>

      <Field label="Diagnosis" required>
        <Input
          value={diagnosis}
          onChange={(e) => setDiagnosis(e.target.value)}
          maxLength={500}
          autoFocus
        />
      </Field>

      <Field label="Clinical notes" hint="Visible to doctors and nurses only.">
        <Textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
      </Field>

      {error && (
        <div role="alert" className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]">
          {error}
        </div>
      )}
    </Sheet>
  );
}
