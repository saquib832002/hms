import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { MonthCalendar } from '@/components/calendar';
import { theme } from '@/lib/theme';
import { date as formatDate, time } from '@/lib/format';
import { Button, Card, FloatingError, Screen } from '@/components/ui';
import type { Appointment, Availability, Doctor, Slot } from '@/lib/types';

/**
 * Reschedule an appointment — a different time, a different doctor, or both.
 *
 * WHY THE DOCTOR IS CHANGEABLE HERE
 * ---------------------------------
 * The API has always accepted `doctorId` on this route. The first version of
 * this screen sent only `scheduledAt`, with a comment claiming a doctor change
 * "belongs behind its own explicit choice" — which was a deferred decision
 * dressed up as a rule. The effect was that moving a patient to another doctor
 * meant cancelling and rebooking: two audit entries, a released slot somebody
 * else could take in between, and a lost link to the original booking.
 *
 * "Dr Patel is off sick, can you put me with Dr Chen at the same time" is an
 * ordinary front-desk request, and it is one operation.
 *
 * Cancelling stays on the schedule list, next to the row it applies to and
 * behind a confirmation — `CANCELLED` is terminal, so a mis-tap cannot be
 * undone from the app.
 */
export default function RescheduleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const appointmentId = Number(id);
  const { user } = useAuth();
  const timezone = user?.hospital?.timezone;
  const today = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()),
    [timezone],
  );

  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [doctorId, setDoctorId] = useState<number | null>(null);

  const [availability, setAvailability] = useState<Availability | null>(null);
  const [dateParam, setDateParam] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Appointment>(`/appointments/${appointmentId}`)
      .then((a) => {
        setAppointment(a);
        // Defaults to who they are already seeing — the common case is a time
        // change, and pre-selecting nobody would make that the longer path.
        setDoctorId(a.doctorId);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not load this appointment'),
      );
  }, [appointmentId]);

  useEffect(() => {
    api<Doctor[]>('/doctors')
      .then(setDoctors)
      .catch(() => setError('Could not load the doctor list'));
  }, []);

  const loadAvailability = useCallback(async () => {
    if (doctorId === null) return;
    setSlot(null);
    try {
      // Availability follows the *selected* doctor, not the original one —
      // otherwise choosing Dr Chen would offer Dr Patel's free slots.
      setAvailability(
        await api<Availability>(`/doctors/${doctorId}/availability?date=${dateParam ?? today}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load availability');
      setAvailability(null);
    }
  }, [doctorId, dateParam, today]);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  const movingDoctor = appointment !== null && doctorId !== appointment.doctorId;

  const submit = async () => {
    if (!appointment) return;
    if (!slot && !movingDoctor) {
      return setError('Choose a new time, or a different doctor.');
    }

    setSaving(true);
    setError(null);
    try {
      await api(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        body: {
          // Both are sent only when they actually changed. A no-op field still
          // costs the API a validation pass, and sending `scheduledAt`
          // unchanged would re-run the past-date check against a booking that
          // was legal when it was made.
          ...(slot ? { scheduledAt: slot.time } : {}),
          ...(movingDoctor ? { doctorId } : {}),
        },
      });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reschedule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={s.body}>
        {appointment && (
          <Card style={s.current}>
            <Text style={s.name}>{appointment.patient?.fullName ?? 'Unknown patient'}</Text>
            <Text style={s.muted}>
              Currently {formatDate(appointment.scheduledAt)} at {time(appointment.scheduledAt)}
            </Text>
            <Text style={s.muted}>
              {appointment.doctor ? `with Dr ${appointment.doctor.fullName}` : ''}
            </Text>
          </Card>
        )}

        <Text style={s.step}>Doctor</Text>
        <View style={s.wrap}>
          {doctors.map((d) => (
            <Button
              key={d.id}
              label={d.fullName}
              variant={doctorId === d.id ? 'primary' : 'secondary'}
              onPress={() => setDoctorId(d.id)}
            />
          ))}
        </View>
        {movingDoctor && (
          <Text style={s.notice}>
            Moving to a different doctor. Pick a time from their availability below.
          </Text>
        )}

        <Text style={s.step}>Day</Text>
        <MonthCalendar value={dateParam ?? today} min={today} onChange={setDateParam} />

        <Text style={s.step}>Time</Text>
        {availability && (
          <Text style={s.muted}>
            {availability.slotMinutes}-minute slots · {availability.timezone}
          </Text>
        )}

        <View style={s.wrap}>
          {(availability?.slots ?? []).map((sl) => (
            <Button
              key={sl.time}
              label={formatSlot(sl.time, availability?.timezone)}
              variant={slot?.time === sl.time ? 'primary' : 'secondary'}
              disabled={!sl.available || sl.past}
              onPress={() => setSlot(sl)}
            />
          ))}
        </View>
        {availability && availability.slots.every((sl) => sl.past || !sl.available) && (
          <Text style={s.muted}>Nothing free on this day. Try another date or doctor.</Text>
        )}

        <Button label="Move appointment" busy={saving} onPress={() => void submit()} />
        <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
      </ScrollView>

      <FloatingError message={error} onDismiss={() => setError(null)} />
    </Screen>
  );
}

/** The hospital's timezone, not the device's — see the note in appointment/new. */
function formatSlot(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

const s = StyleSheet.create({
  body: { padding: theme.space(4), gap: theme.space(3) },
  current: { gap: theme.space(1) },
  step: { ...theme.font.bodyStrong, color: theme.color.text, marginTop: theme.space(2) },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2) },
  name: { ...theme.font.heading, color: theme.color.text },
  muted: { ...theme.font.small, color: theme.color.textSubtle },
  notice: { ...theme.font.small, color: theme.color.warning },
});
