import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { api } from '@/lib/api';
import { date, time } from '@/lib/format';
import { theme } from '@/lib/theme';
import { Button, Card, EmptyState, ErrorBanner, Screen, StatusPill } from '@/components/ui';
import type {
  ChartMedicine,
  MedicationChart,
  MedicationRequest,
  SupplyRequest,
} from '@/lib/types';

/**
 * The drug chart — the MAR — for one admission.
 *
 * The medication round answers "what is due on this ward today". A nurse taking
 * over a patient asks a different question: what is this person on, and what
 * have they actually had. Nothing in the system answered it on either client.
 *
 * It also closes a dead end. `parseFrequency` refuses to guess at a frequency
 * it cannot read, and returned those items saying a nurse should set the times
 * — with nowhere in either client to set them. A refusal that leads nowhere is
 * a missing medicine with a paragraph attached.
 *
 * Web-and-mobile in the same change, per the standing instruction. A ward round
 * happens walking between beds, which is the case the phone is for; the
 * previous two rounds of this argument both ended with somebody locked out of
 * the surface they were actually standing at.
 */
export default function DrugChartScreen() {
  const { admissionId } = useLocalSearchParams<{ admissionId: string }>();
  const id = Number(admissionId);

  const [chart, setChart] = useState<MedicationChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<ChartMedicine | null>(null);
  const [supplyFor, setSupplyFor] = useState<ChartMedicine | null>(null);
  const [asking, setAsking] = useState(false);
  const [supplies, setSupplies] = useState<SupplyRequest[]>([]);
  const [asks, setAsks] = useState<MedicationRequest[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      /*
       * The chart and both request queues. A request whose answer is invisible
       * from the bed it was raised at is one the nurse chases by phone, which
       * is exactly what these queues replace.
       */
      const [c, s, m] = await Promise.all([
        api<MedicationChart>(`/admissions/${id}/chart`),
        api<SupplyRequest[]>(`/admissions/${id}/supply-requests`),
        api<MedicationRequest[]>(`/admissions/${id}/medication-requests`),
      ]);
      setChart(c);
      setSupplies(s);
      setAsks(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the drug chart');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const charted = chart?.medicines.filter((m) => m.doses.length > 0) ?? [];
  const uncharted = chart?.medicines.filter((m) => m.doses.length === 0) ?? [];

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Drug chart', headerShown: true }} />

      {error && <ErrorBanner message={error} />}

      <ScrollView contentContainerStyle={s.list}>
        {chart && (
          <Card>
            <Text style={s.name}>{chart.patient.fullName}</Text>
            <Text style={s.muted}>
              {chart.admission.bed ?? '—'} · {chart.admission.ward ?? ''} · age {chart.patient.age}
            </Text>
            <Text style={s.muted}>admitted {date(chart.admission.admittedAt)}</Text>

            {/*
              The substances, not a flag. This is the screen where somebody is
              about to give a drug — "has allergies" without saying to what is
              the least useful form of that warning at the moment it matters.
            */}
            {chart.patient.allergies.length > 0 && (
              <View style={s.allergy}>
                <Text style={s.allergyText}>
                  ⚠ Allergic to: {chart.patient.allergies.join(', ')}
                </Text>
              </View>
            )}
          </Card>
        )}

        {chart && chart.medicines.length === 0 && (
          <EmptyState
            glyph="℞"
            title="Nothing prescribed"
            body="A doctor needs to write a prescription before there is a chart to build."
          />
        )}

        {/*
          Prescribed-but-not-charted first, above the medicines that are
          already working. These are the ones needing a decision, and putting
          them second is how a medicine goes unnoticed — which is the failure
          this screen exists to fix.
        */}
        {uncharted.length > 0 && (
          <>
            <Text style={s.sectionWarn}>Prescribed · not on the chart · {uncharted.length}</Text>
            {uncharted.map((m) => (
              <Card key={m.prescriptionItemId} accent={theme.color.warning}>
                <Text style={s.medicine}>{m.medicineName}</Text>
                <Text style={s.muted}>
                  {m.dosage} · as written: “{m.frequency}” · {m.duration}
                </Text>
                <Text style={s.reason}>{m.notScheduledReason}</Text>
                <View style={{ marginTop: theme.space(2) }}>
                  <Button
                    label={m.asNeeded ? 'Record a dose as given' : 'Set the times'}
                    onPress={() => setActing(m)}
                  />
                </View>
              </Card>
            ))}
          </>
        )}

        {charted.length > 0 && (
          <>
            <Text style={s.section}>On the chart · {charted.length}</Text>
            {charted.map((m) => (
              <Card key={m.prescriptionItemId}>
                <Text style={s.medicine}>{m.medicineName}</Text>
                <Text style={s.muted}>
                  {m.dosage} · {m.scheduleLabel ?? m.frequency}
                </Text>
                <View style={s.doses}>
                  {m.doses.map((d) => (
                    <View key={d.id} style={[s.dose, doseTone(d.status)]}>
                      <Text style={s.doseText}>
                        {time(d.dueAt)}
                        {d.status !== 'DUE' ? ` ${GLYPH[d.status] ?? ''}` : ''}
                      </Text>
                    </View>
                  ))}
                </View>
                {m.doses.some((d) => d.notes) && (
                  <Text style={s.muted}>
                    {m.doses.filter((d) => d.notes).map((d) => `${time(d.dueAt)}: ${d.notes}`).join(' · ')}
                  </Text>
                )}
                {/*
                  Beside the medicine it is about — "we have run out of THIS"
                  is the thought the nurse is having. A generic button
                  elsewhere would mean retyping a name already on screen,
                  which is where transcription errors come from.
                */}
                <View style={{ marginTop: theme.space(2) }}>
                  <Button
                    label="Ask pharmacy for stock"
                    variant="secondary"
                    onPress={() => setSupplyFor(m)}
                  />
                </View>
              </Card>
            ))}
          </>
        )}

        {/*
          Asking a doctor is the only action here not about a medicine already
          on screen — because it is for one that is not. Worded as a request
          throughout: a nurse asks, a nurse never prescribes, and no path from
          this button puts anything on the chart.
        */}
        {chart && (
          <>
            <Text style={s.section}>Requests</Text>
            <Button label="Ask a doctor to prescribe" onPress={() => setAsking(true)} />

            {asks.length === 0 && supplies.length === 0 && (
              <Text style={s.muted}>
                Nothing asked for on this patient yet.
              </Text>
            )}

            {asks.map((r) => (
              <Card key={`m${r.id}`}>
                <Text style={s.reqKind}>Doctor · {r.status.toLowerCase()}</Text>
                <Text style={s.medicine}>{r.medicineText}</Text>
                <Text style={s.muted}>{r.reason}</Text>
                {r.responseNote && (
                  <Text style={s.answer}>
                    {r.respondedBy ? `${r.respondedBy.fullName}: ` : ''}
                    {r.responseNote}
                  </Text>
                )}
              </Card>
            ))}

            {supplies.map((r) => (
              <Card key={`s${r.id}`}>
                <Text style={s.reqKind}>Pharmacy · {r.status.toLowerCase()}</Text>
                <Text style={s.medicine}>{r.prescriptionItem.medicineName}</Text>
                <Text style={s.muted}>
                  {r.quantity ? `${r.quantity} requested` : ''} {r.note ?? ''}
                </Text>
                {r.responseNote && (
                  <Text style={s.answer}>
                    {r.respondedBy ? `${r.respondedBy.fullName}: ` : ''}
                    {r.responseNote}
                  </Text>
                )}
              </Card>
            ))}
          </>
        )}
      </ScrollView>

      <AskModal
        supplyFor={supplyFor}
        askingDoctor={asking}
        admissionId={id}
        onClose={() => {
          setSupplyFor(null);
          setAsking(false);
        }}
        onDone={() => {
          setSupplyFor(null);
          setAsking(false);
          void load();
        }}
        onError={setError}
      />

      <ActionModal
        medicine={acting}
        admissionId={id}
        onClose={() => setActing(null)}
        onDone={() => {
          setActing(null);
          void load();
        }}
        onError={setError}
      />
    </Screen>
  );
}

/**
 * A tick alone would make every non-DUE dose read as given. Refused, withheld
 * and missed differ from each other and from given, and a chart that blurs them
 * is one a handover cannot be run from.
 */
const GLYPH: Record<string, string> = {
  GIVEN: '✓',
  REFUSED: '✗',
  WITHHELD: '⊘',
  MISSED: '!',
};

function doseTone(status: string) {
  if (status === 'GIVEN') return { backgroundColor: theme.color.successSoft };
  if (status === 'MISSED') return { backgroundColor: theme.color.dangerSoft };
  if (status === 'DUE') return { backgroundColor: theme.color.surfaceSunken };
  return { backgroundColor: theme.color.warningSoft };
}

/**
 * One modal, two jobs, chosen by `asNeeded`.
 *
 * Setting times for an as-needed medicine would make the round show a dose as
 * *due*, which is the exact misreading PRN exists to prevent — so that path is
 * not offered for one, and recording-as-given is not the primary action for the
 * other.
 */
function ActionModal({
  medicine,
  admissionId,
  onClose,
  onDone,
  onError,
}: {
  medicine: ChartMedicine | null;
  admissionId: number;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [times, setTimes] = useState('08:00, 20:00');
  const [days, setDays] = useState('3');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTimes('08:00, 20:00');
    setDays('3');
    setNotes('');
  }, [medicine]);

  if (!medicine) return null;

  async function setSchedule() {
    if (!medicine) return;
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/medication-schedule/manual`, {
        method: 'POST',
        body: {
          prescriptionItemId: medicine.prescriptionItemId,
          times: times
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          days: Number(days) || 3,
        },
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not set those times');
    } finally {
      setBusy(false);
    }
  }

  async function givePrn() {
    if (!medicine) return;
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/doses`, {
        method: 'POST',
        body: {
          prescriptionItemId: medicine.prescriptionItemId,
          status: 'GIVEN',
          givenAt: new Date().toISOString(),
          notes: notes.trim() || undefined,
        },
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not record that dose');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.medicine}>{medicine.medicineName}</Text>
          <Text style={s.muted}>
            {medicine.dosage} · “{medicine.frequency}”
          </Text>

          {medicine.asNeeded ? (
            <View style={{ marginTop: theme.space(4) }}>
              <Text style={s.label}>Why was it given?</Text>
              <TextInput
                style={s.input}
                value={notes}
                onChangeText={setNotes}
                placeholder="e.g. pain score 7"
                placeholderTextColor={theme.color.textSubtle}
                multiline
              />
              <Text style={s.hint}>
                As-needed medicines are never scheduled, so this creates the entry and signs it in
                one step.
              </Text>
              <Button label="Record as given" onPress={() => void givePrn()} disabled={busy} />
            </View>
          ) : (
            <View style={{ marginTop: theme.space(4) }}>
              <Text style={s.label}>Times each day (ward clock)</Text>
              <TextInput
                style={s.input}
                value={times}
                onChangeText={setTimes}
                placeholder="08:00, 14:00, 20:00"
                placeholderTextColor={theme.color.textSubtle}
                autoCapitalize="none"
              />
              <Text style={s.label}>Days</Text>
              <TextInput
                style={s.input}
                value={days}
                onChangeText={setDays}
                keyboardType="number-pad"
              />
              <Text style={s.hint}>
                Times already past today are skipped, so nothing opens as overdue.
              </Text>
              <Button label="Add to chart" onPress={() => void setSchedule()} disabled={busy} />
            </View>
          )}

          <Button
            label="Cancel"
            variant="secondary"
            onPress={onClose}
            style={{ marginTop: theme.space(2) }}
          />
        </View>
      </View>
    </Modal>
  );
}

/**
 * Both asks, in one modal, kept visibly distinct.
 *
 * They are two different requests answered by two different people — a
 * pharmacist sends stock that is already prescribed, a doctor decides whether
 * to prescribe at all. The sheet says which is which every time, because a
 * nurse picking the wrong one sends a clinical question to a stock room.
 */
function AskModal({
  supplyFor,
  askingDoctor,
  admissionId,
  onClose,
  onDone,
  onError,
}: {
  supplyFor: ChartMedicine | null;
  askingDoctor: boolean;
  admissionId: number;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [medicineText, setMedicineText] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuantity('');
    setNote('');
    setMedicineText('');
    setReason('');
  }, [supplyFor, askingDoctor]);

  if (!supplyFor && !askingDoctor) return null;

  async function sendSupply() {
    if (!supplyFor) return;
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/supply-requests`, {
        method: 'POST',
        body: {
          prescriptionItemId: supplyFor.prescriptionItemId,
          ...(Number(quantity) > 0 ? { quantity: Number(quantity) } : {}),
          note: note.trim() || undefined,
        },
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not send that request');
    } finally {
      setBusy(false);
    }
  }

  async function sendAsk() {
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/medication-requests`, {
        method: 'POST',
        body: { medicineText: medicineText.trim(), reason: reason.trim() },
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not send that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          {supplyFor ? (
            <>
              <Text style={s.medicine}>{supplyFor.medicineName}</Text>
              <Text style={s.muted}>
                {supplyFor.dosage} · already prescribed
              </Text>
              <Text style={s.hint}>
                Asking the pharmacy to send stock to the ward. Nothing on the chart changes.
              </Text>

              <Text style={s.label}>How many (optional)</Text>
              <TextInput
                style={s.input}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="number-pad"
                placeholder="20"
                placeholderTextColor={theme.color.textSubtle}
              />
              <Text style={s.label}>Note (optional)</Text>
              <TextInput
                style={s.input}
                value={note}
                onChangeText={setNote}
                placeholder="Needed for the 20:00 round"
                placeholderTextColor={theme.color.textSubtle}
              />
              <View style={{ marginTop: theme.space(3) }}>
                <Button label="Send to pharmacy" onPress={() => void sendSupply()} disabled={busy} />
              </View>
            </>
          ) : (
            <>
              <Text style={s.medicine}>Ask a doctor to prescribe</Text>
              <Text style={s.hint}>
                This asks a prescriber to write it. It does not add anything to the chart — the
                doctor writes it, or declines and says why.
              </Text>

              <Text style={s.label}>What is needed</Text>
              <TextInput
                style={s.input}
                value={medicineText}
                onChangeText={setMedicineText}
                placeholder="Something for nausea"
                placeholderTextColor={theme.color.textSubtle}
              />
              <Text style={s.label}>Why</Text>
              <TextInput
                style={s.input}
                value={reason}
                onChangeText={setReason}
                placeholder="Vomiting since 04:00, has not kept the morning dose down"
                placeholderTextColor={theme.color.textSubtle}
                multiline
              />
              <View style={{ marginTop: theme.space(3) }}>
                <Button
                  label="Send to a doctor"
                  onPress={() => void sendAsk()}
                  disabled={busy || medicineText.trim().length < 2 || reason.trim().length < 12}
                />
              </View>
            </>
          )}

          <Button
            label="Cancel"
            variant="secondary"
            onPress={onClose}
            style={{ marginTop: theme.space(2) }}
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  list: { padding: theme.space(4), gap: theme.space(3) },
  reqKind: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginBottom: 2,
  },
  answer: {
    fontSize: 12,
    color: theme.color.text,
    marginTop: theme.space(2),
    paddingTop: theme.space(2),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  name: { fontSize: 18, fontWeight: '700', color: theme.color.text },
  medicine: { fontSize: 15, fontWeight: '700', color: theme.color.text },
  muted: { fontSize: 12, color: theme.color.textMuted, marginTop: 2 },
  reason: { fontSize: 12, color: theme.color.warning, marginTop: theme.space(2) },
  section: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
  },
  sectionWarn: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.warning,
    marginTop: theme.space(3),
  },
  allergy: {
    marginTop: theme.space(2),
    backgroundColor: theme.color.dangerSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
  },
  allergyText: { color: theme.color.danger, fontSize: 12, fontWeight: '600' },
  doses: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(1), marginTop: theme.space(2) },
  dose: { paddingHorizontal: theme.space(2), paddingVertical: 2, borderRadius: theme.radius.sm },
  doseText: { fontSize: 11, fontVariant: ['tabular-nums'], color: theme.color.text },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: theme.space(5),
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.color.text,
    marginTop: theme.space(3),
    marginBottom: theme.space(1),
  },
  hint: { fontSize: 11, color: theme.color.textSubtle, marginBottom: theme.space(3) },
  input: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    color: theme.color.text,
    backgroundColor: theme.color.bg,
  },
});
