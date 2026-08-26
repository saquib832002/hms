'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorState, Field, TableSkeleton } from '@/components/ui/primitives';
import { TimezoneSelect } from '@/components/ui/timezone-select';

interface ClinicSettings {
  timezone: string;
  slotMinutes: number;
  clinicStartHour: number;
  clinicEndHour: number;
  currency: string;
  slotsPerDoctorPerDay: number;
  summary: string;
  allowedSlotMinutes: number[];
}

/**
 * A short list rather than every ISO 4217 code.
 *
 * ~180 currencies exist and a hospital uses exactly one, so an exhaustive
 * dropdown is all cost and no benefit. The server accepts any valid code, so
 * adding one here is a one-line change and nothing else has to move.
 */
const CURRENCIES = [
  { code: 'GBP', name: 'Pound sterling' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'SAR', name: 'Saudi riyal' },
  { code: 'PKR', name: 'Pakistani rupee' },
  { code: 'BDT', name: 'Bangladeshi taka' },
  { code: 'LKR', name: 'Sri Lankan rupee' },
  { code: 'NPR', name: 'Nepalese rupee' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'ZAR', name: 'South African rand' },
  { code: 'NGN', name: 'Nigerian naira' },
  { code: 'KES', name: 'Kenyan shilling' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'BRL', name: 'Brazilian real' },
];

function symbolFor(code: string): string {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? code
    );
  } catch {
    return code;
  }
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * The hospital's clinic day.
 *
 * These are not display preferences — they generate the booking grid. Changing
 * the slot length changes which appointment times exist; changing the timezone
 * moves the whole clinic day. The screen says so, because a setting that
 * quietly reshapes the appointment book is worse than one that explains itself.
 */
export default function ClinicSettingsPage() {
  const [saved, setSaved] = useState<ClinicSettings | null>(null);
  const [form, setForm] = useState<Partial<ClinicSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<ClinicSettings>('/admin/clinic-settings');
      setSaved(res);
      setForm(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed =
    saved !== null &&
    (['timezone', 'slotMinutes', 'clinicStartHour', 'clinicEndHour', 'currency'] as const).some(
      (k) => form[k] !== saved[k],
    );

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<ClinicSettings>('/admin/clinic-settings', {
        method: 'PATCH',
        body: {
          timezone: form.timezone,
          slotMinutes: Number(form.slotMinutes),
          clinicStartHour: Number(form.clinicStartHour),
          clinicEndHour: Number(form.clinicEndHour),
          currency: form.currency,
        },
      });
      setSaved(res);
      setForm(res);
      setNotice('Saved. New appointment slots use these settings from now on.');
    } catch (e) {
      // The server explains why — an end hour before the start, an unknown
      // timezone, a slot length that does not divide an hour.
      setError(e instanceof ApiError ? e.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }

  if (error && !saved) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!saved) return <TableSkeleton rows={4} />;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-text">Clinic settings</h1>
        <p className="mt-1 text-sm text-text-subtle">
          These decide which appointment times exist. They apply to this hospital only.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-surface p-4 text-sm">
        <div className="font-medium text-text">Currently: {saved.summary}</div>
        <div className="mt-1 text-text-subtle">
          {saved.slotsPerDoctorPerDay} appointment slots per doctor per day
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Timezone"
          required
          hint="The hospital's wall clock — it decides what 'today' means on a queue."
        >
          <TimezoneSelect
            value={form.timezone ?? 'UTC'}
            onChange={(timezone) => setForm({ ...form, timezone })}
          />
        </Field>

        <Field label="Slot length" required hint="How long one appointment lasts.">
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.slotMinutes ?? 30}
            onChange={(e) => setForm({ ...form, slotMinutes: Number(e.target.value) })}
          >
            {saved.allowedSlotMinutes.map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Currency"
          required
          hint="Changes the symbol on invoices and reports. Amounts are NOT converted."
        >
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.currency ?? 'GBP'}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name} ({symbolFor(c.code)})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Opens" required>
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.clinicStartHour ?? 9}
            onChange={(e) => setForm({ ...form, clinicStartHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hh(h)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Closes" required hint="The last slot begins before this hour.">
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.clinicEndHour ?? 17}
            onChange={(e) => setForm({ ...form, clinicEndHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hh(h)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {changed ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-text">
          Appointments already booked keep their existing times — only new bookings use the
          changed grid.
          {form.currency !== saved.currency ? (
            <>
              {' '}
              Changing the currency <strong>relabels</strong> existing invoices from{' '}
              {saved.currency} to {form.currency}; no amount is converted.
            </>
          ) : null}
        </p>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}

      <div className="flex gap-2">
        <Button variant="primary" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" disabled={!changed || busy} onClick={() => setForm(saved)}>
          Discard
        </Button>
      </div>
    </div>
  );
}
