import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOutbox } from '@/lib/outbox-context';
import { theme } from '@/lib/theme';
import { AppHeader, Button, Card, Screen } from '@/components/ui';

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
  const { patientId, patientName } = useLocalSearchParams<{
    patientId?: string;
    patientName?: string;
  }>();
  const router = useRouter();
  const { enqueueVitals, pending } = useOutbox();

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
      if (raw && raw !== '.') body[f.key] = f.decimal ? Number(raw) : parseInt(raw, 10);
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
    </Screen>
  );
}

const s = StyleSheet.create({
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
