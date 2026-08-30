import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { MonthCalendar } from '@/components/calendar';
import { theme } from '@/lib/theme';
import { Button, Card, FloatingError, Screen } from '@/components/ui';
import type { Availability, Doctor, Paginated, Patient, PatientListItem, Slot } from '@/lib/types';

/**
 * Booking, against the hospital's own clinic day.
 *
 * THE SLOT GRID IS NOT COSMETIC
 * -----------------------------
 * Slot length, clinic hours and timezone are per-tenant. This screen never
 * generates times itself — it renders exactly what `GET /doctors/:id/availability`
 * returns, and books only what that endpoint offered. Building a grid on the
 * client would mean two implementations of the clinic day that drift, and the
 * symptom is a booking that succeeds and then cannot be seen in the availability
 * view it would have to be cancelled from.
 *
 * `past` also comes from the server. The device clock is not authoritative and
 * a phone in the wrong timezone would otherwise grey out the wrong half of the
 * morning.
 */
export default function BookAppointmentScreen() {
  const { patientId: preselected } = useLocalSearchParams<{ patientId?: string }>();
  const { user } = useAuth();
  const timezone = user?.hospital?.timezone;

  // Today in the clinic's zone — the floor for the calendar, and the day it
  // opens on. A device-local "today" would offer a day the clinic has finished.
  const today = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()),
    [timezone],
  );

  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [doctorId, setDoctorId] = useState<number | null>(null);

  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PatientListItem[]>([]);
  const [patient, setPatient] = useState<PatientListItem | null>(null);

  const [availability, setAvailability] = useState<Availability | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [dateParam, setDateParam] = useState<string | null>(null);

  /*
   * Arrived from a patient row, so step 1 is already answered.
   *
   * The id comes in on the route rather than the whole patient: a route
   * parameter is a string in a URL, and passing a serialised record through one
   * means the screen renders whatever the list happened to know, which may be
   * stale. Re-reading it is one indexed lookup and is also audited, which
   * matters — opening a patient is a PHI access whichever screen does it.
   */
  useEffect(() => {
    if (!preselected) return;
    api<Patient>(`/patients/${preselected}`)
      .then((p) =>
        setPatient({
          id: p.id,
          fullName: p.fullName,
          dob: p.dob,
          age: p.age,
          gender: p.gender,
          phone: p.phone,
        }),
      )
      .catch(() => {
        // Not fatal — fall back to the search box rather than dead-ending.
        setError('Could not load that patient. Search for them instead.');
      });
  }, [preselected]);

  useEffect(() => {
    api<Doctor[]>('/doctors')
      .then(setDoctors)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not load the doctor list'),
      );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim();
      if (q.length < 2 || patient) return;
      api<Paginated<PatientListItem>>(`/patients?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => setMatches(r.data))
        .catch(() => setMatches([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, patient]);

  const loadAvailability = useCallback(async () => {
    if (doctorId === null) return;
    setError(null);
    setSlot(null);
    try {
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

  const submit = async () => {
    if (!patient) return setError('Choose a patient.');
    if (doctorId === null) return setError('Choose a doctor.');
    if (!slot) return setError('Choose a time.');

    setSaving(true);
    setError(null);
    try {
      await api('/appointments', {
        method: 'POST',
        body: {
          patientId: patient.id,
          doctorId,
          // The exact ISO string the server offered. Reconstructing it from
          // parts on the device is how an off-grid booking gets created.
          scheduledAt: slot.time,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not book this appointment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">

        {/* 1. Patient */}
        <Text style={s.step}>Patient</Text>
        {patient ? (
          <Card style={s.row}>
            <View style={s.grow}>
              <Text style={s.name}>{patient.fullName}</Text>
              <Text style={s.muted}>
                {patient.age} · {patient.phone ?? 'no phone'}
              </Text>
            </View>
            <Button
              label="Change"
              variant="secondary"
              onPress={() => {
                setPatient(null);
                setQuery('');
                setMatches([]);
              }}
            />
          </Card>
        ) : (
          <>
            <TextInput
              style={s.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Search name or phone"
              placeholderTextColor={theme.color.textSubtle}
              autoCorrect={false}
            />
            {matches.map((m) => (
              <Card key={m.id} style={s.row}>
                <View style={s.grow}>
                  <Text style={s.name}>{m.fullName}</Text>
                  <Text style={s.muted}>
                    {m.age} · {m.phone ?? 'no phone'}
                  </Text>
                </View>
                <Button
                  label="Select"
                  variant="secondary"
                  onPress={() => {
                    setPatient(m);
                    setMatches([]);
                  }}
                />
              </Card>
            ))}
          </>
        )}

        {/* 2. Doctor */}
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

        {/* 3. Time */}
        {doctorId !== null && (
          <>
            <Text style={s.step}>Day</Text>
            <MonthCalendar
              value={dateParam ?? today}
              min={today}
              onChange={(d) => setDateParam(d)}
            />

            <Text style={s.step}>Time</Text>
            {availability && (
              <Text style={s.muted}>
                {availability.slotMinutes}-minute slots · {availability.timezone}
              </Text>
            )}
            <View style={s.wrap}>
              {(availability?.slots ?? []).map((sl) => {
                const bookable = sl.available && !sl.past;
                return (
                  <Button
                    key={sl.time}
                    label={formatSlot(sl.time, availability?.timezone)}
                    variant={slot?.time === sl.time ? 'primary' : 'secondary'}
                    disabled={!bookable}
                    onPress={() => setSlot(sl)}
                  />
                );
              })}
            </View>
            {availability && availability.slots.every((sl) => sl.past || !sl.available) && (
              <Text style={s.muted}>
                Nothing free on this day. Pick another date above, or another doctor.
              </Text>
            )}
          </>
        )}

        {/* 4. Reason */}
        <Text style={s.step}>Reason (optional)</Text>
        <TextInput
          style={s.input}
          value={reason}
          onChangeText={setReason}
          placeholder="e.g. follow-up"
          placeholderTextColor={theme.color.textSubtle}
        />

        <Button label="Book appointment" busy={saving} onPress={() => void submit()} />
        <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
      </ScrollView>

      <FloatingError message={error} onDismiss={() => setError(null)} />
    </Screen>
  );
}

/**
 * Renders the server's ISO instant in the *hospital's* timezone.
 *
 * Not the device's. A receptionist whose phone is on the wrong zone would
 * otherwise read a correct booking as an hour out and "fix" it.
 */
function formatSlot(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Steps the date string forward. Plain date arithmetic, no timezone involved. */
const s = StyleSheet.create({
  body: { padding: theme.space(4), gap: theme.space(3) },
  step: { ...theme.font.body, color: theme.color.text, marginTop: theme.space(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space(3) },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2) },
  grow: { flex: 1 },
  name: { ...theme.font.body, color: theme.color.text },
  muted: { ...theme.font.small, color: theme.color.textSubtle },
  input: {
    minHeight: theme.touchTarget,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space(3),
    ...theme.font.input,
    color: theme.color.text,
  },
});
