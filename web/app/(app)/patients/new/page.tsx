'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { date as fmtDate } from '@/lib/format';
import { Button, Field, Input, Select, SectionLabel } from '@/components/ui/primitives';

interface DuplicateMatch {
  id: number;
  fullName: string;
  dob: string;
  phone: string | null;
}

/**
 * Patient registration.
 *
 * The duplicate check is the important part of this screen. Split patient
 * records are among the most damaging data problems in a hospital system —
 * clinical history divides silently across two IDs and neither tells the
 * whole story. Catching it at the moment of creation costs one query;
 * merging two records afterwards is a project.
 */
export default function RegisterPatientPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    fullName: '',
    dob: '',
    gender: '',
    phone: '',
    email: '',
    address: '',
    bloodGroup: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
  });
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const dismissed = useRef(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // Debounced duplicate lookup on name or phone.
  useEffect(() => {
    const name = form.fullName.trim();
    const phone = form.phone.trim();
    if (name.length < 3 && phone.length < 6) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ fullName: name });
      if (phone) params.set('phone', phone);
      api<{ data: DuplicateMatch[] }>(`/patients/duplicates?${params}`)
        .then((res) => !cancelled && setDuplicates(res.data))
        .catch(() => !cancelled && setDuplicates([]));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form.fullName, form.phone]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSubmitting(true);
    try {
      const created = await api<{ id: number }>('/patients', {
        method: 'POST',
        body: {
          fullName: form.fullName.trim(),
          dob: new Date(`${form.dob}T00:00:00Z`).toISOString(),
          gender: form.gender,
          phone: form.phone || undefined,
          email: form.email || undefined,
          address: form.address || undefined,
          bloodGroup: form.bloodGroup || undefined,
          emergencyContactName: form.emergencyContactName || undefined,
          emergencyContactPhone: form.emergencyContactPhone || undefined,
        },
      });
      router.push(`/patients?id=${created.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.errors ?? []);
      } else {
        setError('Could not register this patient');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const showDuplicates = duplicates.length > 0 && !dismissed.current;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <form onSubmit={onSubmit} className="mx-auto max-w-[560px] px-6 py-6">
        <h2 className="text-xl font-semibold tracking-tight">Register a new patient</h2>
        <p className="mt-1 text-sm text-text-muted">
          Check the duplicate warnings before creating a record.
        </p>

        <SectionLabel>Identity</SectionLabel>
        <Field label="Full name" required>
          <Input value={form.fullName} onChange={set('fullName')} required autoFocus />
        </Field>

        {showDuplicates && (
          <div className="mb-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2.5 text-sm text-[#6b5314]">
            <div className="font-semibold">
              {duplicates.length} possible {duplicates.length === 1 ? 'match' : 'matches'}
            </div>
            <p className="mt-0.5 text-xs">
              A patient with these details may already exist. Opening the existing record keeps
              their history in one place.
            </p>
            <div className="mt-2 space-y-1 rounded-sm border border-[#e5d9b4] bg-surface p-2">
              {duplicates.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <strong>{d.fullName}</strong>{' '}
                    <span className="font-mono text-xs text-text-muted">
                      #{d.id} · {fmtDate(d.dob)}
                      {d.phone ? ` · ${d.phone}` : ''}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => router.push(`/patients?id=${d.id}`)}
                  >
                    Open
                  </Button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                dismissed.current = true;
                setDuplicates([]);
              }}
              className="mt-2 text-xs underline underline-offset-2"
            >
              None of these — this is a new patient
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth" required>
            <Input type="date" value={form.dob} onChange={set('dob')} required />
          </Field>
          <Field label="Gender" required>
            <Select value={form.gender} onChange={set('gender')} required>
              <option value="">Select…</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
        </div>

        <SectionLabel>Contact</SectionLabel>
        <Field label="Phone">
          <Input value={form.phone} onChange={set('phone')} placeholder="+44 …" />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Address">
          <Input value={form.address} onChange={set('address')} placeholder="Street, city, postcode" />
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

        <SectionLabel>Clinical basics</SectionLabel>
        <Field
          label="Blood group"
          hint="Recorded at registration; clinical staff can see it, reception cannot."
        >
          <Select value={form.bloodGroup} onChange={set('bloodGroup')}>
            <option value="">Unknown</option>
            {['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </Field>

        {error && (
          <div role="alert" className="mb-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-3 py-2 text-sm text-[#8a2a1f]">
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

        <div className="flex gap-2 border-t border-border pt-4">
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Registering…' : 'Register patient'}
          </Button>
          <Button type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
