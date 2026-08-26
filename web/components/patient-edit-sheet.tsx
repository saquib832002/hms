'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Patient } from '@/lib/types';
import { isoDate } from '@/lib/format';
import { Button, Field, Input, Select, SectionLabel } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Correct a patient's details.
 *
 * Registration happens at a busy front desk with someone talking across a
 * counter; typos in a phone number or a transposed date of birth are routine.
 * Without this screen the only fix is a second record, which is precisely the
 * duplicate problem the registration form works to prevent.
 *
 * Demographics only. Blood group is deliberately absent — it is clinical, and
 * the roles who can reach this screen (reception, admin) do not receive it
 * from the API in the first place. Sending a field back that the server never
 * sent would either fail validation or, worse, blank it.
 */
export function PatientEditSheet({
  patient,
  onClose,
  onSaved,
}: {
  patient: Patient | null;
  onClose: () => void;
  onSaved: (updated: Patient) => void;
}) {
  const [form, setForm] = useState({
    fullName: '',
    dob: '',
    gender: '',
    phone: '',
    email: '',
    address: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!patient) return;
    setForm({
      fullName: patient.fullName,
      dob: isoDate(new Date(patient.dob)),
      gender: patient.gender,
      phone: patient.phone ?? '',
      email: patient.email ?? '',
      address: patient.address ?? '',
      emergencyContactName: patient.emergencyContactName ?? '',
      emergencyContactPhone: patient.emergencyContactPhone ?? '',
    });
    setError(null);
    setFieldErrors([]);
  }, [patient]);

  if (!patient) return null;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!patient) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors([]);
    try {
      const updated = await api<Patient>(`/patients/${patient.id}`, {
        method: 'PATCH',
        body: {
          fullName: form.fullName.trim(),
          dob: new Date(`${form.dob}T00:00:00Z`).toISOString(),
          gender: form.gender,
          // Empty strings clear a field; undefined would leave it untouched.
          // Reception needs to be able to remove a wrong phone number, so the
          // distinction matters.
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          address: form.address.trim() || null,
          emergencyContactName: form.emergencyContactName.trim() || null,
          emergencyContactPhone: form.emergencyContactPhone.trim() || null,
        },
      });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.errors ?? []);
      } else {
        setError('Could not save those changes');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit patient details"
      footer={
        <>
          <Button
            variant="primary"
            disabled={submitting || form.fullName.trim().length < 2 || !form.dob}
            onClick={() => void submit()}
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <span className="text-xxs leading-tight text-text-muted">
            Every change
            <br />
            is audited
          </span>
        </>
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{patient.fullName}</div>
        <div className="font-mono text-xs text-text-muted">#{patient.id}</div>
      </div>

      <SectionLabel>Identity</SectionLabel>
      <Field label="Full name" required>
        <Input value={form.fullName} onChange={set('fullName')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date of birth" required>
          <Input type="date" value={form.dob} onChange={set('dob')} />
        </Field>
        <Field label="Gender" required>
          <Select value={form.gender} onChange={set('gender')}>
            <option value="MALE">Male</option>
            <option value="FEMALE">Female</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
      </div>

      <SectionLabel>Contact</SectionLabel>
      <Field label="Phone">
        <Input value={form.phone} onChange={set('phone')} />
      </Field>
      <Field label="Email">
        <Input type="email" value={form.email} onChange={set('email')} />
      </Field>
      <Field label="Address">
        <Input value={form.address} onChange={set('address')} />
      </Field>

      <SectionLabel>Emergency contact</SectionLabel>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={form.emergencyContactName} onChange={set('emergencyContactName')} />
        </Field>
        <Field label="Phone">
          <Input value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />
        </Field>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
          {fieldErrors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs">
              {fieldErrors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  );
}
