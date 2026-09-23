import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '@/lib/api';
import { useOutbox } from '@/lib/outbox-context';
import { theme } from '@/lib/theme';
import { date, time } from '@/lib/format';
import { AppHeader, Button, Card, Screen } from '@/components/ui';
import type { ObservationFrequency, ObservationSummary } from '@/lib/types';

/**
 * Tightest first, because that is the direction a nurse moves.
 *
 * A nurse may raise how often observations are taken and never relax them:
 * watching somebody more closely because they look unwell is the reason there
 * is a nurse at the bedside, and must not wait for a doctor to be found.
 * Relaxing is a judgement about their condition, so the server refuses it and
 * this list only offers what is tighter than the current plan.
 */
const FREQUENCIES: { value: ObservationFrequency; label: string; minutes: number }[] = [
  { value: 'QUARTER_HOURLY', label: 'Every 15 min', minutes: 15 },
  { value: 'HALF_HOURLY', label: 'Every 30 min', minutes: 30 },
  { value: 'HOURLY', label: 'Hourly', minutes: 60 },
  { value: 'TWO_HOURLY', label: '2-hourly', minutes: 120 },
  { value: 'FOUR_HOURLY', label: '4-hourly', minutes: 240 },
  { value: 'SIX_HOURLY', label: '6-hourly', minutes: 360 },
  { value: 'TWELVE_HOURLY', label: '12-hourly', minutes: 720 },
  { value: 'DAILY', label: 'Once daily', minutes: 1440 },
];

type Field = 'systolic' | 'diastolic' | 'pulse' | 'temperatureC' | 'respiratoryRate' | 'spo2';

const FIELDS: { key: Field; label: string; unit: string; decimal?: boolean }[] = [
  { key: 'systolic', label: 'Systolic', unit: 'mmHg' },
  { key: 'diastolic', label: 'Diastolic', unit: 'mmHg' },
  { key: 'pulse', label: 'Pulse', unit: 'bpm' },
  { key: 'temperatureC', label: 'Temperature', unit: '°C', decimal: true },
  { key: 'respiratoryRate', label: 'Resp. rate', unit: '/min' },
  { key: 'spo2', label: 'SpO₂', unit: '%' },
];

/**
 * Bedside observation entry — the most-used screen in the nurse app.
 *
 * A custom number pad rather than the system keyboard. The OS numeric keyboard
 * on iOS has no decimal point in `numeric` mode and no done key in
 * `number-pad`; more importantly its keys are small, and this is used standing
 * up, one-handed, sometimes with gloves. One field at a time with big targets
 * beats a form of six tiny inputs.
 *
 * Saving goes to the outbox, not the network. The nurse sees it saved because
 * from their point of view it is — the queue guarantees it lands.
 */
export default function VitalsScreen() {
  const { patientId, patientName, admissionId } = useLocalSearchParams<{
    patientId?: string;
    patientName?: string;
    admissionId?: string;
  }>();
  const router = useRouter();
  const { enqueueVitals, pending } = useOutbox();

  /*
   * The plan, for an admitted patient.
   *
   * A nurse standing at a bed needs to know what frequency this patient is on
   * before deciding whether they are late — "overdue" means something different
   * at 15-minutely and at 12-hourly. Fetched rather than passed in full because
   * the board's copy is up to 15 seconds stale and this is the screen where it
   * matters.
   *
   * Absent for an outpatient, which is correct: a frequency belongs to a stay.
   */
  const [obs, setObs] = useState<ObservationSummary | null>(null);
  const [escalating, setEscalating] = useState(false);
  const [tightening, setTightening] = useState(false);
  const [responding, setResponding] = useState<number | null>(null);
  const admission = Number(admissionId);

  const loadObs = useCallback(async () => {
    if (!Number.isInteger(admission)) return;
    try {
      setObs(await api<ObservationSummary>(`/admissions/${admission}/observations`));
    } catch {
      // A missing plan must never block recording a set of observations. The
      // numbers are the point of this screen; the plan is context.
      setObs(null);
    }
  }, [admission]);

  useEffect(() => {
    void loadObs();
  }, [loadObs]);

  const [values, setValues] = useState<Partial<Record<Field, string>>>({});
  const [active, setActive] = useState<Field>('systolic');
  const [saved, setSaved] = useState(false);

  const id = Number(patientId);
  const current = values[active] ?? '';
  const field = FIELDS.find((f) => f.key === active)!;

  function press(key: string) {
    setValues((prev) => {
      const existing = prev[active] ?? '';
      if (key === 'del') return { ...prev, [active]: existing.slice(0, -1) };
      if (key === '.') {
        if (!field.decimal || existing.includes('.')) return prev;
        return { ...prev, [active]: existing === '' ? '0.' : `${existing}.` };
      }
      if (existing.length >= 5) return prev;
      return { ...prev, [active]: existing + key };
    });
  }

  const filled = FIELDS.filter((f) => (values[f.key] ?? '').length > 0);

  async function save() {
    const body: Record<string, unknown> = {
      patientId: id,
      recordedAt: new Date().toISOString(),
    };
    for (const f of FIELDS) {
      const raw = values[f.key];
      if (raw && raw !== '.') {
        /*
         * One decimal place for temperature.
         *
         * The API accepts one — `@IsNumber({ maxDecimalPlaces: 1 })` — and the
         * pad happily accepts "36.65", which was then rejected with a generic
         * validation error at the bedside. Rounding to the resolution the pad
         * itself implies is not silent mangling: 0.05°C is below what any ward
         * thermometer reads, and a paper chart records one decimal for the
         * same reason.
         */
        body[f.key] = f.decimal ? Math.round(Number(raw) * 10) / 10 : parseInt(raw, 10);
      }
    }

    await enqueueVitals(body, `Observations for ${patientName ?? `patient ${id}`}`);
    setSaved(true);
    setTimeout(() => router.back(), 900);
  }

  if (!Number.isInteger(id)) {
    return (
      <Screen>
        <AppHeader title={'Vitals'} />
        <View style={s.body}>
          <Card>
            <Text style={s.muted}>
              Choose a patient from the ward board to record observations.
            </Text>
          </Card>
          <Button label="Go to ward" variant="secondary" onPress={() => router.push('/(tabs)')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <AppHeader
          title={patientName ?? `Patient #${id}`}
          subtitle="Recording observations"
          right={
            <Text style={s.back} onPress={() => router.back()}>
              Close
            </Text>
          }
        />

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {obs && (
            <Card style={obs.overdue ? { borderLeftWidth: 4, borderLeftColor: theme.color.danger } : undefined}>
              <Text style={s.planLabel}>
                {obs.order.label} observations
                {obs.order.isExplicit ? '' : ' (default — nobody has set one)'}
              </Text>
              <Text style={s.muted}>
                {obs.neverObserved
                  ? 'No observations recorded this stay'
                  : `Last ${time(obs.lastObservedAt!)} · next due ${obs.nextDueAt ? time(obs.nextDueAt) : '—'}`}
              </Text>
              {obs.openEscalations > 0 && (
                <Text style={s.openEsc}>
                  {obs.openEscalations} escalation{obs.openEscalations === 1 ? '' : 's'} with no response
                </Text>
              )}
              {/*
                Escalating from the phone matters more than from a desk: this
                is where a nurse is standing when they notice. It records the
                call rather than making one.
              */}
              <View style={{ marginTop: theme.space(2), gap: theme.space(2) }}>
                <Button label="Escalate" variant="danger" onPress={() => setEscalating(true)} />
                <Button
                  label="Watch more closely"
                  variant="secondary"
                  onPress={() => setTightening(true)}
                />
              </View>

              {/*
                An escalation nobody answered stays visibly open until somebody
                records what came back. That gap is the finding an incident
                review looks for, so it is not quietly filled in later.
              */}
              {obs.escalations
                .filter((e) => e.respondedAt === null)
                .map((e) => (
                  <View key={e.id} style={{ marginTop: theme.space(3) }}>
                    <Text style={s.openEsc}>
                      {e.escalatedTo} · no response
                    </Text>
                    <Text style={s.muted}>{e.concern}</Text>
                    <Button
                      label="Record what came back"
                      variant="secondary"
                      onPress={() => setResponding(e.id)}
                      style={{ marginTop: theme.space(2) }}
                    />
                  </View>
                ))}
            </Card>
          )}

          {/* The field being edited, big enough to read at arm's length. */}
          <View style={s.display}>
            <Text style={s.displayLabel}>{field.label}</Text>
            <Text style={s.displayValue}>
              {current || '—'}
              <Text style={s.displayUnit}> {field.unit}</Text>
            </Text>
          </View>

          <View style={s.pad}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', field.decimal ? '.' : '', '0', 'del'].map(
              (key, i) => (
                <Pressable
                  key={i}
                  disabled={key === ''}
                  onPress={() => key && press(key)}
                  style={({ pressed }) => [
                    s.key,
                    key === '' && s.keyDisabled,
                    pressed && key !== '' && s.keyPressed,
                  ]}
                  accessibilityLabel={key === 'del' ? 'Delete' : key}
                >
                  <Text style={s.keyText}>{key === 'del' ? '⌫' : key}</Text>
                </Pressable>
              ),
            )}
          </View>

          <View style={s.chips}>
            {FIELDS.map((f) => {
              const value = values[f.key];
              const isActive = f.key === active;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setActive(f.key)}
                  style={[s.chip, isActive && s.chipActive]}
                >
                  <Text style={[s.chipLabel, isActive && s.chipLabelActive]}>{f.label}</Text>
                  <Text style={[s.chipValue, isActive && s.chipLabelActive]}>{value || '—'}</Text>
                </Pressable>
              );
            })}
          </View>

          {pending > 0 && (
            <Text style={s.queued}>
              {pending} observation{pending === 1 ? '' : 's'} waiting to sync
            </Text>
          )}
        </ScrollView>

        <View style={s.actions}>
          <Button
            label={saved ? 'Saved' : `Save ${filled.length || ''} observation${filled.length === 1 ? '' : 's'}`.trim()}
            onPress={() => void save()}
            disabled={filled.length === 0 || saved}
          />
          {/* Says what actually happens — it is queued, not necessarily sent. */}
          <Text style={s.note}>Saved on this device and synced when there is signal</Text>
        </View>
      </KeyboardAvoidingView>

      <TightenModal
        open={tightening}
        admissionId={admission}
        current={obs?.order.frequency ?? 'FOUR_HOURLY'}
        onClose={() => setTightening(false)}
        onDone={() => {
          setTightening(false);
          void loadObs();
        }}
      />

      <RespondModal
        escalationId={responding}
        onClose={() => setResponding(null)}
        onDone={() => {
          setResponding(null);
          void loadObs();
        }}
      />

      <EscalateModal
        open={escalating}
        admissionId={admission}
        onClose={() => setEscalating(false)}
        onDone={() => {
          setEscalating(false);
          void loadObs();
        }}
      />
    </Screen>
  );
}

/**
 * A nurse raising how often observations are taken.
 *
 * Only tighter options are offered, because that is the only direction a nurse
 * may move — and the server refuses the rest anyway. Showing a doctor-only
 * option here would be a button that exists to fail.
 */
function TightenModal({
  open,
  admissionId,
  current,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: number;
  current: ObservationFrequency;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
  }, [open]);

  if (!open) return null;

  const currentMinutes = FREQUENCIES.find((f) => f.value === current)?.minutes ?? 240;
  const tighter = FREQUENCIES.filter((f) => f.minutes < currentMinutes);

  async function set(frequency: ObservationFrequency) {
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/observations/order`, {
        method: 'POST',
        body: { frequency, reason: reason.trim() || undefined },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the plan');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.planLabel}>Watch more closely</Text>
          <Text style={s.muted}>
            Currently {FREQUENCIES.find((f) => f.value === current)?.label.toLowerCase()}. Relaxing
            observations is a doctor&apos;s decision, so only tighter options are here.
          </Text>

          {error && <Text style={s.error}>{error}</Text>}

          <Text style={s.fieldLabel}>Why</Text>
          <TextInput
            style={s.input}
            value={reason}
            onChangeText={setReason}
            placeholder="Pyrexial, BP dropping since 14:00"
            placeholderTextColor={theme.color.textSubtle}
            multiline
          />

          <View style={{ marginTop: theme.space(3), gap: theme.space(2) }}>
            {tighter.length === 0 ? (
              <Text style={s.muted}>
                Already on the closest monitoring this system records. Escalate instead.
              </Text>
            ) : (
              tighter.map((f) => (
                <Button
                  key={f.value}
                  label={f.label}
                  variant="secondary"
                  onPress={() => void set(f.value)}
                  disabled={busy}
                />
              ))
            )}
          </View>

          <Button
            label="Cancel"
            variant="secondary"
            onPress={onClose}
            style={{ marginTop: theme.space(3) }}
          />
        </View>
      </View>
    </Modal>
  );
}

/** What came back. Separate from raising it, because the gap is the finding. */
function RespondModal({
  escalationId,
  onClose,
  onDone,
}: {
  escalationId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResponse('');
    setError(null);
  }, [escalationId]);

  if (escalationId === null) return null;

  async function save() {
    setBusy(true);
    try {
      await api(`/escalations/${escalationId}/response`, {
        method: 'PATCH',
        body: { response: response.trim() },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that response');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.planLabel}>What came back</Text>
          {error && <Text style={s.error}>{error}</Text>}

          <Text style={s.fieldLabel}>Response</Text>
          <TextInput
            style={s.input}
            value={response}
            onChangeText={setResponse}
            placeholder="Attending within 20 minutes. Repeat obs meanwhile."
            placeholderTextColor={theme.color.textSubtle}
            multiline
            autoFocus
          />

          <View style={{ marginTop: theme.space(3) }}>
            <Button
              label="Record"
              onPress={() => void save()}
              disabled={busy || response.trim().length < 2}
            />
          </View>
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
 * Recording an escalation from the bedside.
 *
 * `escalatedTo` is free text: the on-call registrar covering a ward at 3am
 * usually has no account in this hospital's system, and demanding a user id
 * would mean the commonest real escalation could not be recorded at all.
 *
 * This records the call. It does not make one — nothing in this system
 * notifies anybody yet, and a button that looked like it did would be worse
 * than none.
 */
function EscalateModal({
  open,
  admissionId,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [escalatedTo, setTo] = useState('');
  const [concern, setConcern] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTo('');
    setConcern('');
    setError(null);
  }, [open]);

  if (!open) return null;

  async function save() {
    setBusy(true);
    try {
      await api(`/admissions/${admissionId}/observations/escalations`, {
        method: 'POST',
        body: { escalatedTo: escalatedTo.trim(), concern: concern.trim() },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that escalation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.planLabel}>Record an escalation</Text>
          <Text style={s.muted}>
            Make the call, then write down who you spoke to and what you said. This does not
            contact anybody.
          </Text>

          {error && <Text style={s.error}>{error}</Text>}

          <Text style={s.fieldLabel}>Who did you tell</Text>
          <TextInput
            style={s.input}
            value={escalatedTo}
            onChangeText={setTo}
            placeholder="Dr Okafor, medical registrar on call"
            placeholderTextColor={theme.color.textSubtle}
          />

          <Text style={s.fieldLabel}>What was the concern</Text>
          <TextInput
            style={s.input}
            value={concern}
            onChangeText={setConcern}
            placeholder="BP 88/54, pulse 122, clammy since the 02:00 set."
            placeholderTextColor={theme.color.textSubtle}
            multiline
          />

          <View style={{ marginTop: theme.space(3) }}>
            <Button
              label="Record"
              variant="danger"
              onPress={() => void save()}
              disabled={busy || escalatedTo.trim().length < 2 || concern.trim().length < 5}
            />
          </View>
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
  planLabel: { fontSize: 15, fontWeight: '700', color: theme.color.text },
  openEsc: { fontSize: 12, fontWeight: '600', color: theme.color.danger, marginTop: 4 },
  error: { fontSize: 12, color: theme.color.danger, marginTop: theme.space(2) },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.color.text,
    marginTop: theme.space(3),
    marginBottom: theme.space(1),
  },
  input: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    color: theme.color.text,
    backgroundColor: theme.color.bg,
  },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: theme.space(5),
  },
  back: { ...theme.font.bodyStrong, color: theme.color.onAccent },
  muted: { ...theme.font.small, color: theme.color.textMuted },
  body: { padding: theme.space(3) },
  display: {
    backgroundColor: theme.color.surface,
    borderWidth: 2,
    borderColor: theme.color.primary,
    borderRadius: theme.radius.md,
    padding: theme.space(4),
    alignItems: 'center',
    marginBottom: theme.space(3),
  },
  displayLabel: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textMuted,
  },
  displayValue: { ...theme.font.hero, color: theme.color.text, letterSpacing: -1 },
  displayUnit: { ...theme.font.body, color: theme.color.textMuted },
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2) },
  key: {
    width: '31%',
    minHeight: 58,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDisabled: { opacity: 0, borderWidth: 0 },
  keyPressed: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primary },
  keyText: { ...theme.font.display, color: theme.color.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), marginTop: theme.space(3) },
  chip: {
    flexGrow: 1,
    minWidth: '30%',
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(2),
    alignItems: 'center',
  },
  chipActive: { borderColor: theme.color.primary, backgroundColor: theme.color.primarySoft },
  chipLabel: { ...theme.font.caption, color: theme.color.textMuted, textTransform: 'uppercase' },
  chipLabelActive: { color: theme.color.primary },
  chipValue: { ...theme.font.heading, color: theme.color.text },
  queued: {
    marginTop: theme.space(3),
    ...theme.font.caption,
    color: theme.color.warning,
    textAlign: 'center',
  },
  actions: {
    padding: theme.space(3),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  note: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    textAlign: 'center',
    marginTop: theme.space(2),
  },
});
