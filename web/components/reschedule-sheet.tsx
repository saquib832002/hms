'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Appointment, Availability, Doctor } from '@/lib/types';
import { dateTime, isoDate, time } from '@/lib/format';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Move an existing appointment.
 *
 * Rescheduling is most of a receptionist's day — patients ring to move things
 * far more often than they book from scratch. Doing it as cancel-and-rebook
 * would work but lose the thread: the original slot's history disappears and
 * the patient ends up with a cancellation on their record for an appointment
 * they never missed.
 *
 * The patient cannot be changed here. The backend's UpdateAppointmentDto
 * omits `patientId` on purpose — repointing an appointment at a different
 * patient would silently move any record written against it too.
 */
export function RescheduleSheet({
  appointment,
  doctors,
  onClose,
  onSaved,
}: {
  appointment: Appointment | null;
  doctors: Doctor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Availability | null>(null);
  const [slot, setSlot] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!appointment) return;
    setDoctorId(String(appointment.doctor?.id ?? appointment.doctorId));
    setDate(isoDate(new Date(appointment.scheduledAt)));
    setReason(appointment.reason ?? '');
    setSlot('');
    setError(null);
  }, [appointment]);

  useEffect(() => {
    setSlots(null);
    if (!doctorId || !date) return;
    let cancelled = false;
    api<Availability>(`/doctors/${doctorId}/availability?date=${date}`)
      .then((a) => !cancelled && setSlots(a))
      .catch(() => !cancelled && setSlots(null));
    return () => {
      cancelled = true;
    };
  }, [doctorId, date]);

  if (!appointment) return null;

  const currentSlot = new Date(appointment.scheduledAt).getTime();

  async function submit() {
    if (!appointment || !slot) return;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/appointments/${appointment.id}`, {
        method: 'PATCH',
        body: { doctorId: Number(doctorId), scheduledAt: slot, reason: reason || undefined },
      });
      onSaved();
    } catch (err) {
      // 409 = someone took the slot in the meantime; 400 = moved into the past.
      setError(err instanceof ApiError ? err.message : 'Could not reschedule that appointment');
      if (doctorId && date) {
        api<Availability>(`/doctors/${doctorId}/availability?date=${date}`)
          .then(setSlots)
          .catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Reschedule appointment"
      footer={
        <>
          <Button variant="primary" disabled={!slot || submitting} onClick={() => void submit()}>
            {submitting ? 'Moving…' : 'Move appointment'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{appointment.patient?.fullName}</div>
        <div className="font-mono text-xs text-text-muted">
          Currently {dateTime(appointment.scheduledAt)} · {appointment.doctor?.fullName}
        </div>
      </div>

      <p className="mb-3 mt-2.5 text-xs text-text-subtle">
        The patient stays the same. To book for someone else, create a new appointment.
      </p>

      <Field label="Doctor" required>
        <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fullName} — {d.specialization}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="New date" required>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      <Field label="New time" required hint={slots ? `Times shown in ${slots.timezone}` : undefined}>
        {!slots ? (
          <p className="text-sm text-text-subtle">Loading availability…</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {slots.slots.map((s) => {
              // The slot this appointment already occupies reads as "taken"
              // from the server's point of view. Showing it as unavailable
              // would be confusing, so it is labelled as the current one.
              const isCurrent = new Date(s.time).getTime() === currentSlot;
              const selectable = s.available || isCurrent;
              return (
                <button
                  key={s.time}
                  type="button"
                  disabled={!selectable}
                  title={isCurrent ? 'Current appointment time' : undefined}
                  onClick={() => setSlot(s.time)}
                  className={`rounded-sm border px-1 py-1 font-mono text-xs ${
                    slot === s.time
                      ? 'border-primary bg-primary text-white'
                      : isCurrent
                        ? 'border-primary bg-primary-soft text-primary'
                        : s.available
                          ? 'border-border-strong bg-surface hover:border-primary'
                          : 'cursor-not-allowed border-border bg-bg text-text-subtle line-through'
                  }`}
                >
                  {time(s.time)}
                </button>
              );
            })}
          </div>
        )}
      </Field>

      <Field label="Reason">
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
