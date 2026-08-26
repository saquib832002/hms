import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api, ApiError } from '@/lib/api';
import { theme } from '@/lib/theme';
import { titleCase } from '@/lib/format';
import { Button, Card, ErrorBanner } from './ui';
import { AllergyBanner } from './allergy-banner';
import type { Allergy, Prescription } from '@/lib/types';

interface Item {
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
}

const EMPTY: Item = { medicineName: '', dosage: '', frequency: '', duration: '' };

/**
 * Issue a prescription from the phone.
 *
 * This is the one genuinely creative act the mobile app allows, and it is here
 * because it is a real between-rounds task — a doctor finishing a consultation
 * on a ward should not have to walk back to a desk to prescribe.
 *
 * A full-screen modal rather than a bottom sheet: prescribing is not a glance,
 * and the patient header has to stay visible throughout. Getting the wrong
 * patient is the mistake this layout is guarding against.
 */
export function PrescriptionSheet({
  visible,
  patientId,
  patientName,
  allergies,
  onClose,
  onIssued,
}: {
  visible: boolean;
  patientId: number;
  patientName: string;
  allergies?: Allergy[];
  onClose: () => void;
  onIssued: () => void;
}) {
  const [items, setItems] = useState<Item[]>([{ ...EMPTY }]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Prescription | null>(null);

  useEffect(() => {
    if (!visible) {
      setItems([{ ...EMPTY }]);
      setNotes('');
      setError(null);
      setIssued(null);
    }
  }, [visible]);

  const setItem = (i: number, k: keyof Item, v: string) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)));

  /**
   * Substring match only — catches "Penicillin V" against a penicillin
   * allergy, misses "Amoxicillin" which is a penicillin sharing no substring.
   * The server runs the same check and returns authoritative warnings. Neither
   * blocks in Phase 2; an unreliable check presented as authoritative would be
   * worse than none, and the reliable version needs the Phase 4 drug catalogue.
   */
  const warningsFor = (medicineName: string) => {
    if (!allergies?.length || medicineName.trim().length < 3) return [];
    const med = medicineName.toLowerCase();
    return allergies.filter(
      (a) => med.includes(a.substance.toLowerCase()) || a.substance.toLowerCase().includes(med),
    );
  };

  const valid = items.every(
    (i) => i.medicineName.trim() && i.dosage.trim() && i.frequency.trim() && i.duration.trim(),
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await api<Prescription>('/prescriptions', {
        method: 'POST',
        body: { patientId, items, notes: notes || undefined },
      });
      setIssued(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the prescription');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.header}>
          <Text style={s.title}>{issued ? 'Prescription issued' : 'New prescription'}</Text>
          <Text style={s.close} onPress={onClose}>
            Close
          </Text>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={s.patient}>{patientName}</Text>
            <Text style={s.muted}>#{patientId}</Text>
          </Card>

          <AllergyBanner allergies={allergies} />

          {issued ? (
            <>
              <Card>
                <Text style={s.muted}>Reference</Text>
                <Text style={s.patient}>#{issued.id}</Text>
                {issued.items.map((i) => (
                  <Text key={i.id} style={s.itemLine}>
                    {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                  </Text>
                ))}
              </Card>

              {issued.allergyWarnings && issued.allergyWarnings.length > 0 && (
                <View style={s.warn}>
                  <Text style={s.warnTitle}>Allergy warnings recorded</Text>
                  {issued.allergyWarnings.map((w, i) => (
                    <Text key={i} style={s.warnBody}>
                      {w.matchedMedicine} matches a {titleCase(w.severity)} allergy to {w.substance}
                    </Text>
                  ))}
                </View>
              )}

              <Text style={s.footnote}>
                Printing is on the web app — the patient copy comes from the front desk.
              </Text>
            </>
          ) : (
            <>
              {items.map((item, i) => {
                const warnings = warningsFor(item.medicineName);
                return (
                  <Card key={i}>
                    <View style={s.itemHeader}>
                      <Text style={s.itemIndex}>Medicine {i + 1}</Text>
                      {items.length > 1 && (
                        <Text
                          style={s.remove}
                          onPress={() => setItems((p) => p.filter((_, idx) => idx !== i))}
                        >
                          Remove
                        </Text>
                      )}
                    </View>

                    <TextInput
                      style={[s.input, warnings.length ? s.inputWarn : null]}
                      value={item.medicineName}
                      onChangeText={(v) => setItem(i, 'medicineName', v)}
                      placeholder="Medicine"
                      placeholderTextColor={theme.color.textSubtle}
                      autoCapitalize="words"
                    />

                    {warnings.length > 0 && (
                      <View style={s.warn}>
                        <Text style={s.warnTitle}>⚠ Possible allergy conflict</Text>
                        <Text style={s.warnBody}>
                          Recorded{' '}
                          {warnings
                            .map((w) => `${titleCase(w.severity)} allergy to ${w.substance}`)
                            .join(', ')}
                          . Verify before issuing.
                        </Text>
                      </View>
                    )}

                    <TextInput
                      style={s.input}
                      value={item.dosage}
                      onChangeText={(v) => setItem(i, 'dosage', v)}
                      placeholder="Dosage (e.g. 5 mg)"
                      placeholderTextColor={theme.color.textSubtle}
                    />
                    <TextInput
                      style={s.input}
                      value={item.frequency}
                      onChangeText={(v) => setItem(i, 'frequency', v)}
                      placeholder="Frequency (e.g. Once daily)"
                      placeholderTextColor={theme.color.textSubtle}
                    />
                    <TextInput
                      style={s.input}
                      value={item.duration}
                      onChangeText={(v) => setItem(i, 'duration', v)}
                      placeholder="Duration (e.g. 30 days)"
                      placeholderTextColor={theme.color.textSubtle}
                    />
                  </Card>
                );
              })}

              <Button
                label="+ Add medicine"
                variant="secondary"
                onPress={() => setItems((p) => [...p, { ...EMPTY }])}
                style={{ marginBottom: theme.space(3) }}
              />

              <TextInput
                style={[s.input, s.notes]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Instructions for the patient (optional)"
                placeholderTextColor={theme.color.textSubtle}
                multiline
              />
            </>
          )}

          {error && <ErrorBanner message={error} />}
        </ScrollView>

        <View style={s.actions}>
          {issued ? (
            <Button label="Done" onPress={onIssued} />
          ) : (
            <>
              <Button
                label={busy ? 'Issuing…' : 'Issue prescription'}
                onPress={() => void submit()}
                disabled={!valid}
                busy={busy}
              />
              {/* States the consequence rather than saying "Submit". */}
              <Text style={s.consequence}>Cannot be edited once dispensed</Text>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(12),
    paddingBottom: theme.space(3),
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  title: { fontSize: 20, fontWeight: '800', color: theme.color.text },
  close: { fontSize: 16, color: theme.color.primary },
  body: { padding: theme.space(3) },
  patient: { fontSize: 18, fontWeight: '700', color: theme.color.text },
  muted: { fontSize: 13, color: theme.color.textMuted },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: theme.space(2) },
  itemIndex: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
  },
  remove: { fontSize: 13, color: theme.color.danger },
  itemLine: { fontSize: 15, color: theme.color.text, marginTop: 4 },
  input: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(3),
    minHeight: theme.touchTarget,
    fontSize: 16,
    color: theme.color.text,
    marginBottom: theme.space(2),
  },
  inputWarn: { borderColor: theme.color.danger },
  notes: { minHeight: 90, textAlignVertical: 'top', paddingTop: theme.space(3) },
  warn: {
    backgroundColor: theme.color.warningSoft,
    borderWidth: 1,
    borderColor: '#ecdca6',
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  warnTitle: { color: '#6b5314', fontWeight: '800', fontSize: 13 },
  warnBody: { color: '#6b5314', fontSize: 13, marginTop: 2, lineHeight: 18 },
  footnote: {
    fontSize: 12,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(4),
  },
  actions: {
    padding: theme.space(3),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  consequence: {
    fontSize: 12,
    color: theme.color.textMuted,
    textAlign: 'center',
    marginTop: theme.space(2),
  },
});
