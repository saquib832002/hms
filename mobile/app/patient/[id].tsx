import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { date, time } from '@/lib/format';
import { theme } from '@/lib/theme';
import { Button, Card, ErrorBanner } from '@/components/ui';
import { AllergyBanner } from '@/components/allergy-banner';
import { PrescriptionSheet } from '@/components/prescription-sheet';
import type { MedicalRecord, Patient, Prescription } from '@/lib/types';

/**
 * Patient summary — read-only, deliberately partial.
 *
 * Allergies, active medication, the last visit, and two actions. Not the full
 * history: reviewing years of records on a phone is a bad experience that
 * would take real effort to build badly, and it is a desk task. The screen
 * says so rather than leaving the doctor hunting for a tab that does not exist.
 */
export default function PatientScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const patientId = Number(id);
  const router = useRouter();

  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<MedicalRecord[] | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writingRx, setWritingRx] = useState(false);

  useEffect(() => {
    if (!Number.isInteger(patientId)) return;
    api<Patient>(`/patients/${patientId}`)
      .then(setPatient)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load this patient'));
    api<{ data: MedicalRecord[] }>(`/patients/${patientId}/records`)
      .then((r) => setRecords(r.data))
      .catch(() => setRecords([]));
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => setPrescriptions(r.data))
      .catch(() => setPrescriptions([]));
  }, [patientId]);

  const active = (prescriptions ?? []).filter((p) => p.status !== 'CANCELLED').slice(0, 3);

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <Text style={s.back} onPress={() => router.back()}>
          ‹ Queue
        </Text>
        <Text style={s.name}>{patient?.fullName ?? '…'}</Text>
        {patient && (
          <Text style={s.meta}>
            {patient.age}y · {patient.gender.toLowerCase()}
            {patient.bloodGroup ? ` · ${patient.bloodGroup}` : ''} · #{patient.id}
          </Text>
        )}
      </View>

      {error && <ErrorBanner message={error} />}

      <ScrollView contentContainerStyle={s.body}>
        {patient && <AllergyBanner allergies={patient.allergies} />}

        <Text style={s.section}>Active medication</Text>
        {active.length === 0 ? (
          <Card>
            <Text style={s.muted}>
              {prescriptions === null ? 'Loading…' : 'None recorded.'}
            </Text>
          </Card>
        ) : (
          active.map((p) => (
            <Card key={p.id}>
              {p.items.map((i) => (
                <Text key={i.id} style={s.mono}>
                  {i.medicineName} · {i.dosage} · {i.frequency}
                </Text>
              ))}
              <Text style={s.muted}>
                Issued {date(p.issuedAt)}
                {p.dispensedAt ? ' · dispensed' : ''}
              </Text>
            </Card>
          ))
        )}

        <Text style={s.section}>Last visit</Text>
        <Card>
          {records === null ? (
            <Text style={s.muted}>Loading…</Text>
          ) : records.length === 0 ? (
            <Text style={s.muted}>First visit.</Text>
          ) : (
            <>
              <Text style={s.recordDate}>{date(records[0].visitDate)}</Text>
              <Text style={s.recordDiagnosis}>{records[0].diagnosis}</Text>
              {records[0].notes && <Text style={s.muted}>{records[0].notes}</Text>}
            </>
          )}
        </Card>

        <Text style={s.footnote}>
          Full history, records and appointment management are on the web app.
        </Text>
      </ScrollView>

      <View style={s.actions}>
        <Button label="Write prescription" onPress={() => setWritingRx(true)} />
      </View>

      {patient && (
        <PrescriptionSheet
          visible={writingRx}
          patientId={patient.id}
          patientName={patient.fullName}
          allergies={patient.allergies}
          onClose={() => setWritingRx(false)}
          onIssued={() => {
            setWritingRx(false);
            api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
              .then((r) => setPrescriptions(r.data))
              .catch(() => {});
          }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  header: {
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(2),
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  back: { color: theme.color.primary, fontSize: 15, marginBottom: 4 },
  name: { fontSize: 22, fontWeight: '800', color: theme.color.text },
  meta: { fontSize: 13, color: theme.color.textMuted, fontVariant: ['tabular-nums'] },
  body: { padding: theme.space(3), paddingBottom: theme.space(6) },
  section: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
  muted: { fontSize: 13, color: theme.color.textMuted },
  mono: { fontSize: 15, fontWeight: '600', color: theme.color.text },
  recordDate: { fontSize: 13, fontWeight: '700', color: theme.color.text },
  recordDiagnosis: { fontSize: 15, color: theme.color.text, marginVertical: 2 },
  footnote: {
    fontSize: 12,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(5),
  },
  actions: {
    padding: theme.space(3),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
});
