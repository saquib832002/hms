'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth-context';
import type { Appointment, Availability, Doctor, Paginated, PatientListItem } from '@/lib/types';
import { isoDate, time } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
} from '@/components/ui/primitives';
import { StatusChip } from '@/components/ui/status-chip';
import { Sheet } from '@/components/ui/sheet';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { RescheduleSheet } from '@/components/reschedule-sheet';

export default function AppointmentsPage() {
  const user = useUser();
  const canBook = user.role === 'RECEPTIONIST' || user.role === 'ADMIN';

  const [date, setDate] = useState(isoDate());
  const [doctorId, setDoctorId] = useState<string>('');
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  useEffect(() => {
    api<Doctor[]>('/doctors')
      .then(setDoctors)
      .catch(() => setDoctors([]));
  }, []);

  // Deliberately does not clear `rows` — see the note in check-in/page.tsx.
  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ date });
      // A doctor's list is scoped server-side to their own appointments; the
      // filter is hidden for them because it can only ever return themselves.
      if (doctorId) qs.set('doctorId', doctorId);
      const res = await api<{ data: Appointment[] }>(`/appointments?${qs}`);
      setRows(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load appointments');
    }
  }, [date, doctorId]);

  // Paused while the booking sheet is open so availability cannot shift
  // under a half-filled form.
  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: !booking && !rescheduling && !cancelling,
  });

  useEffect(() => {
    // Filter change invalidates the current rows; a poll does not.
    setRows(null);
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, doctorId]);

  async function confirmCancel() {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await api(`/appointments/${cancelling.id}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED' },
      });
      setCancelling(null);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel that appointment');
      setCancelling(null);
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-sm border border-border-strong bg-surface px-2 py-1 text-sm"
        />
        {user.role !== 'DOCTOR' && (
          <Select
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            className="w-auto text-sm"
          >
            <option value="">All doctors</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName}
              </option>
            ))}
          </Select>
        )}
        <span className="text-xs text-text-muted">{rows?.length ?? 0} appointments</span>
        <Freshness lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={() => void refreshNow()} />
        {canBook && (
          <Button variant="primary" className="ml-auto" onClick={() => setBooking(true)}>
            Book appointment
          </Button>
        )}
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {error && (
          <div role="alert" className="border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]">
            {error}
          </div>
        )}
        {!rows && !error && <TableSkeleton cols={6} />}
        {rows?.length === 0 && (
          <EmptyState
            title="Nothing booked for this day"
            action={canBook ? <Button onClick={() => setBooking(true)}>Book one</Button> : undefined}
          />
        )}
        {!rows && error && <ErrorState message={error} onRetry={() => void load()} />}

        {rows && rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Time', 'Patient', 'Doctor', 'Reason', 'Status', ''].map((h) => (
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
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-[#fafbfc]">
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    {time(a.scheduledAt)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                    {a.patient?.fullName ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">{a.doctor?.fullName ?? '—'}</td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-text-muted">
                    {a.reason ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">
                    <StatusChip status={a.status} />
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-right">
                    {canBook && !['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(a.status) && (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => setRescheduling(a)}>
                          Reschedule
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setCancelling(a)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canBook && (
        <RescheduleSheet
          appointment={rescheduling}
          doctors={doctors}
          onClose={() => setRescheduling(null)}
          onSaved={() => {
            setRescheduling(null);
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel this appointment?"
        consequence={
          cancelling
            ? `${cancelling.patient?.fullName ?? 'This patient'}'s appointment will be cancelled. Cancellation is final — rebooking creates a new appointment.`
            : ''
        }
        confirmLabel="Cancel appointment"
        busy={cancelBusy}
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelling(null)}
      />

      {canBook && (
        <BookingSheet
          open={booking}
          onClose={() => setBooking(false)}
          doctors={doctors}
          defaultDate={date}
          onBooked={() => {
            setBooking(false);
            void load();
          }}
        />
      )}
    </>
  );
}

function BookingSheet({
  open,
  onClose,
  doctors,
  defaultDate,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  doctors: Doctor[];
  defaultDate: string;
  onBooked: () => void;
}) {
  const [patientQuery, setPatientQuery] = useState('');
  const [patients, setPatients] = useState<PatientListItem[]>([]);
  const [patientId, setPatientId] = useState<number | null>(null);
  const [doctorId, setDoctorId] = useState<string>('');
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<Availability | null>(null);
  const [slot, setSlot] = useState<string>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setPatientQuery('');
      setPatientId(null);
      setSlot('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const q = patientQuery.trim();
    if (q.length < 2) {
      setPatients([]);
      return;
    }
    const t = setTimeout(() => {
      api<Paginated<PatientListItem>>(`/patients?q=${encodeURIComponent(q)}&limit=6`)
        .then((r) => setPatients(r.data))
        .catch(() => setPatients([]));
    }, 250);
    return () => clearTimeout(t);
  }, [patientQuery]);

  // Availability comes from the server, which knows which slots are taken.
  // The UI never computes this itself — it would be wrong the moment another
  // receptionist booked something.
  useEffect(() => {
    setSlots(null);
    setSlot('');
    if (!doctorId || !date) return;
    api<Availability>(`/doctors/${doctorId}/availability?date=${date}`)
      .then(setSlots)
      .catch(() => setSlots(null));
  }, [doctorId, date]);

  async function submit() {
    if (!patientId || !slot) return;
    setSubmitting(true);
    setError(null);
    try {
      await api('/appointments', {
        method: 'POST',
        body: { patientId, doctorId: Number(doctorId), scheduledAt: slot, reason: reason || undefined },
      });
      onBooked();
    } catch (err) {
      // A 409 means someone else took the slot between loading and clicking.
      setError(err instanceof ApiError ? err.message : 'Could not book that appointment');
      if (doctorId && date) {
        api<Availability>(`/doctors/${doctorId}/availability?date=${date}`)
          .then(setSlots)
          .catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  }

  const selected = patients.find((p) => p.id === patientId);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Book an appointment"
      footer={
        <>
          <Button variant="primary" disabled={!patientId || !slot || submitting} onClick={() => void submit()}>
            {submitting ? 'Booking…' : 'Book appointment'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Field label="Patient" required>
        {selected ? (
          <div className="flex items-center justify-between rounded-sm border border-border bg-bg px-2.5 py-1.5">
            <span className="text-sm font-medium">
              {selected.fullName}{' '}
              <span className="font-mono text-xs text-text-muted">#{selected.id}</span>
            </span>
            <Button size="sm" onClick={() => setPatientId(null)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <Input
              value={patientQuery}
              onChange={(e) => setPatientQuery(e.target.value)}
              placeholder="Search by name or phone…"
            />
            {patients.length > 0 && (
              <div className="mt-1 max-h-40 overflow-y-auto rounded-sm border border-border">
                {patients.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPatientId(p.id)}
                    className="flex w-full justify-between px-2.5 py-1.5 text-left text-sm hover:bg-primary-soft"
                  >
                    <span>{p.fullName}</span>
                    <span className="font-mono text-xs text-text-subtle">#{p.id}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Field>

      <Field label="Doctor" required>
        <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          <option value="">Select a doctor…</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fullName} — {d.specialization}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Date" required>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      <Field label="Time" required hint={slots ? `Times shown in ${slots.timezone}` : undefined}>
        {!doctorId ? (
          <p className="text-sm text-text-subtle">Choose a doctor first</p>
        ) : !slots ? (
          <p className="text-sm text-text-subtle">Loading availability…</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {slots.slots.map((s) => (
              <button
                key={s.time}
                type="button"
                disabled={!s.available}
                title={s.past ? 'This time has passed' : !s.available ? 'Already booked' : undefined}
                onClick={() => setSlot(s.time)}
                /*
                 * Three states, not two. "Gone" and "taken" are different
                 * answers to a receptionist on the phone — one means try
                 * another time, the other means try another doctor — so a
                 * past slot is dimmed while a booked one keeps the strike
                 * through it always had.
                 */
                className={`rounded-sm border px-1 py-1 font-mono text-xs ${
                  slot === s.time
                    ? 'border-primary bg-primary text-white'
                    : s.past
                      ? 'cursor-not-allowed border-border bg-bg text-text-subtle/50'
                      : s.available
                        ? 'border-border-strong bg-surface hover:border-primary'
                        : 'cursor-not-allowed border-border bg-bg text-text-subtle line-through'
                }`}
              >
                {time(s.time)}
              </button>
            ))}
          </div>
        )}
        {slots && slots.slots.every((s) => !s.available) ? (
          // Better than an empty-looking grid of dead buttons: this is the
          // state that looked like a broken booking page when the hospital's
          // timezone was wrong.
          <p className="mt-2 text-sm text-text-subtle">
            No times left on {slots.date} — every slot is booked or has passed. Try another
            date or doctor.
          </p>
        ) : null}
        <p className="mt-2 flex flex-wrap gap-3 text-xs text-text-subtle">
          <span className="opacity-50">faded = time has passed</span>
          <span className="line-through">struck through = already booked</span>
        </p>
      </Field>

      <Field label="Reason" hint="What the patient said when booking — not a diagnosis.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </Field>

      {error && (
        <div role="alert" className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]">
          {error}
        </div>
      )}
    </Sheet>
  );
}
