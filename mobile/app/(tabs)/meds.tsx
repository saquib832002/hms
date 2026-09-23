import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { useOutbox } from '@/lib/outbox-context';
import { theme } from '@/lib/theme';
import { time } from '@/lib/format';
import { AppHeader, Button, Card, EmptyState, ErrorBanner, Screen, StatusPill } from '@/components/ui';
import type { Dose, DoseStatus, MedicationRound, Ward } from '@/lib/types';

/**
 * The medication round.
 *
 * Grouped overdue / due now / upcoming rather than shown as one list, because
 * that is the question a nurse is actually asking. "What have I missed" comes
 * before "what is next", and a flat chronological list buries the first inside
 * the second.
 */
export default function MedsScreen() {
  const [wards, setWards] = useState<Ward[]>([]);
  // See the ward screen: "not asked yet" and "there are none" are different
  // facts, and collapsing them left this screen blank with no explanation.
  const [wardsLoaded, setWardsLoaded] = useState(false);
  const [wardId, setWardId] = useState<number | null>(null);
  const [round, setRound] = useState<MedicationRound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<Dose | null>(null);
  const { pending } = useOutbox();

  useEffect(() => {
    api<Ward[]>('/wards')
      .then((w) => {
        setWards(w);
        setWardId((prev) => prev ?? w[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load wards'))
      .finally(() => setWardsLoaded(true));
  }, []);

  const load = useCallback(async () => {
    if (!wardId) return;
    setError(null);
    try {
      setRound(await api<MedicationRound>(`/medications/round/${wardId}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the medication round');
    }
  }, [wardId]);

  // Refetches on focus and every 15s. A dose signed for by someone else must
  // not still read as due — that is the path to a double administration.
  useLiveData(load);

  return (
    <Screen>
      <AppHeader title="Medications" subtitle="Drug round" />
      <View style={s.pickerBar}>
        <View style={s.wardTabs}>
          {wards.map((w) => (
            <Pressable
              key={w.id}
              onPress={() => setWardId(w.id)}
              style={[s.wardTab, w.id === wardId && s.wardTabActive]}
            >
              <Text style={[s.wardTabText, w.id === wardId && s.wardTabTextActive]}>
                {w.name.split('—')[0].trim()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {pending > 0 && (
        <View style={s.syncBar}>
          <Text style={s.syncText}>{pending} record{pending === 1 ? '' : 's'} waiting to sync</Text>
        </View>
      )}

      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <Group title="Overdue" tone={theme.color.danger} doses={round?.overdue ?? []} onAct={setActing} />
        <Group title="Due now" tone={theme.color.warning} doses={round?.dueNow ?? []} onAct={setActing} />
        <Group title="Upcoming" tone={theme.color.textSubtle} doses={round?.upcoming ?? []} onAct={setActing} />
        <Group
          title="Recorded this shift"
          tone={theme.color.success}
          doses={round?.completed ?? []}
          onAct={() => {}}
          readOnly
        />

        {wardsLoaded && wards.length === 0 && (
          <EmptyState
            glyph="℞"
            title="No wards set up yet"
            body="A drug chart belongs to an admitted patient, and there is nowhere to admit one until a ward exists. An administrator adds them on the web, under Settings → Wards & Beds."
          />
        )}

        {round &&
          round.overdue.length + round.dueNow.length + round.upcoming.length === 0 && (
            <Card>
              <Text style={s.muted}>Nothing outstanding on this ward.</Text>
            </Card>
          )}
      </ScrollView>

      <RecordDoseModal dose={acting} onClose={() => setActing(null)} onRecorded={() => void load()} />
    </Screen>
  );
}

function Group({
  title,
  tone,
  doses,
  onAct,
  readOnly,
}: {
  title: string;
  tone: string;
  doses: Dose[];
  onAct: (d: Dose) => void;
  readOnly?: boolean;
}) {
  if (doses.length === 0) return null;
  return (
    <>
      <Text style={[s.group, { color: tone }]}>
        {title} · {doses.length}
      </Text>
      {doses.map((d) => (
        <Pressable key={d.id} disabled={readOnly} onPress={() => onAct(d)}>
          {({ pressed }) => (
            <Card
              style={{
                opacity: pressed ? 0.75 : 1,
                borderLeftWidth: readOnly ? 1 : 4,
                borderLeftColor: readOnly ? theme.color.border : tone,
              }}
            >
              <View style={s.rowTop}>
                <Text style={s.bed}>{d.bed}</Text>
                <Text style={s.due}>{time(d.dueAt)}</Text>
              </View>
              <View style={s.nameLine}>
                <Text style={s.name}>{d.patient.fullName}</Text>
                {d.patient.hasAllergies && <View style={s.allergyDot} />}
              </View>
              <Text style={s.medicine}>
                {d.medicineName} · {d.dosage}
              </Text>
              {readOnly && (
                <View style={{ flexDirection: 'row', marginTop: 6 }}>
                  <StatusPill
                    label={d.status === 'GIVEN' ? `Given${d.givenBy ? ` · ${d.givenBy}` : ''}` : d.status}
                    bg={d.status === 'GIVEN' ? theme.color.successSoft : theme.color.surfaceSunken}
                    fg={d.status === 'GIVEN' ? theme.color.success : theme.color.textMuted}
                  />
                </View>
              )}
              {d.notes && <Text style={s.muted}>{d.notes}</Text>}
            </Card>
          )}
        </Pressable>
      ))}
    </>
  );
}

/**
 * Recording what happened to a dose.
 *
 * "Given" is one tap. Everything else demands a reason, because at a handover
 * "not given" without a why is close to useless — and the server rejects it
 * anyway, so asking here saves a round trip and a confusing error.
 */
function RecordDoseModal({
  dose,
  onClose,
  onRecorded,
}: {
  dose: Dose | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { enqueueDose } = useOutbox();
  const [notes, setNotes] = useState('');
  const [choice, setChoice] = useState<DoseStatus | null>(null);

  useEffect(() => {
    setNotes('');
    setChoice(null);
  }, [dose]);

  if (!dose) return null;

  async function record(status: DoseStatus) {
    if (!dose) return;
    await enqueueDose(
      dose.id,
      { status, notes: notes.trim() || undefined, givenAt: new Date().toISOString() },
      `${status} · ${dose.medicineName} for ${dose.patient.fullName}`,
    );
    onClose();
    onRecorded();
  }

  const needsReason = choice !== null && choice !== 'GIVEN';

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.modalBed}>{dose.bed}</Text>
          <Text style={s.modalName}>{dose.patient.fullName}</Text>
          <Text style={s.modalMedicine}>
            {dose.medicineName} · {dose.dosage}
          </Text>
          <Text style={s.muted}>Due {time(dose.dueAt)}</Text>

          {dose.patient.hasAllergies && (
            <View style={s.allergyWarn}>
              <Text style={s.allergyWarnText}>
                ⚠ This patient has recorded allergies — check the chart before giving.
              </Text>
            </View>
          )}

          {!choice ? (
            <View style={{ marginTop: theme.space(4), gap: theme.space(2) }}>
              <Button label="Given" onPress={() => void record('GIVEN')} />
              <Button label="Patient refused" variant="secondary" onPress={() => setChoice('REFUSED')} />
              <Button label="Withheld" variant="secondary" onPress={() => setChoice('WITHHELD')} />
              <Button label="Missed" variant="danger" onPress={() => setChoice('MISSED')} />
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
          ) : (
            <View style={{ marginTop: theme.space(4) }}>
              <Text style={s.modalPrompt}>
                Why was this dose {choice.toLowerCase()}?
              </Text>
              <TextInput
                style={s.input}
                value={notes}
                onChangeText={setNotes}
                placeholder="Required — this appears at handover"
                placeholderTextColor={theme.color.textSubtle}
                multiline
                autoFocus
              />
              <Button
                label={`Record as ${choice.toLowerCase()}`}
                onPress={() => void record(choice)}
                disabled={!needsReason || notes.trim().length < 3}
              />
              <Button
                label="Back"
                variant="secondary"
                onPress={() => setChoice(null)}
                style={{ marginTop: theme.space(2) }}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  pickerBar: { paddingHorizontal: theme.space(4), paddingTop: theme.space(4) },
  wardTabs: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(2) },
  wardTab: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
    borderRadius: 999,
    backgroundColor: theme.color.bg,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  wardTabActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primary },
  wardTabText: { ...theme.font.small, color: theme.color.textMuted },
  wardTabTextActive: { color: theme.color.primary, fontWeight: '700' },
  syncBar: { backgroundColor: theme.color.warningSoft, paddingVertical: 5 },
  syncText: { color: theme.color.warning, ...theme.font.caption, textAlign: 'center' },
  list: { padding: theme.space(3) },
  group: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bed: { ...theme.font.small, color: theme.color.textMuted, letterSpacing: 0.5 },
  due: { ...theme.font.small, color: theme.color.text },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  name: { ...theme.font.heading, color: theme.color.text },
  allergyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.danger },
  medicine: { ...theme.font.body, color: theme.color.text, marginTop: 2 },
  muted: { ...theme.font.small, color: theme.color.textMuted, marginTop: 2 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: theme.space(5),
    paddingBottom: theme.space(10),
  },
  modalBed: { ...theme.font.small, color: theme.color.textMuted, letterSpacing: 0.5 },
  modalName: { ...theme.font.display, color: theme.color.text },
  modalMedicine: { ...theme.font.heading, color: theme.color.text, marginTop: 2 },
  modalPrompt: { ...theme.font.body, color: theme.color.text, marginBottom: theme.space(2) },
  allergyWarn: {
    marginTop: theme.space(3),
    backgroundColor: theme.color.dangerSoft,
    borderWidth: 1,
    borderColor: 'rgba(255,90,82,0.45)',
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
  },
  allergyWarnText: { color: theme.color.dangerText, ...theme.font.small },
  input: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    minHeight: 90,
    ...theme.font.input,
    color: theme.color.text,
    textAlignVertical: 'top',
    marginBottom: theme.space(3),
  },
});
