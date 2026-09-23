import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api, ApiError } from '@/lib/api';
import { theme } from '@/lib/theme';
import { Button, Card, ErrorBanner } from './ui';

/**
 * Write a clinical record, on the phone.
 *
 * WHY THIS DID NOT EXIST, AND WHAT IT COST
 * ----------------------------------------
 * `POST /patients/:patientId/records` had a caller on the web and none at all
 * on mobile — no sheet, no form, nothing. So a doctor seeing a patient with the
 * phone in their hand could start the consultation, complete it, and prescribe,
 * and had no way to record *what they found*. The one artefact a consultation
 * exists to produce was the one thing the app could not make.
 *
 * Reported by the product owner, and neither guard test could see it.
 * `endpoint-coverage.spec.ts` asks whether *a* client calls a route and mobile
 * was simply absent from its answer; `screen-parity.spec.ts` compares tabs, and
 * this is an action inside a screen rather than a screen. A third shape of the
 * same failure: what was never built looks exactly like what is working.
 *
 * NO EDIT FLOW, DELIBERATELY — the same rule the web sheet states.
 * A clinical note is a contemporaneous account of what a clinician observed.
 * Editing it afterwards destroys the property that makes it worth keeping, so a
 * correction is a new record rather than an UPDATE.
 *
 * AN IN-SCREEN OVERLAY, NOT A `Modal`
 * -----------------------------------
 * Copied from `prescription-sheet.tsx`, and it is not a style preference:
 * `Modal` renders in its own native window above everything the navigator
 * draws, including the tab bar, so writing a note would strip a doctor
 * mid-consultation of any way back to their queue. That cost is why Close is a
 * real button here — Android back no longer reaches `onRequestClose`.
 */
export function RecordSheet({
  visible,
  patientId,
  patientName,
  onClose,
  onSaved,
}: {
  visible: boolean;
  patientId: number;
  patientName: string;
  onClose: () => void;
  /** Called after a successful write so the caller can refresh its list. */
  onSaved: () => void;
}) {
  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Cleared on close rather than on open: a sheet reopened after a failure
  // should not silently discard what the doctor had already typed, and a sheet
  // opened for the next patient must never inherit the last one's diagnosis.
  useEffect(() => {
    if (!visible) {
      setDiagnosis('');
      setNotes('');
      setError(null);
    }
  }, [visible]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api(`/patients/${patientId}/records`, {
        method: 'POST',
        body: { diagnosis: diagnosis.trim(), notes: notes.trim() || undefined },
      });
      onSaved();
      onClose();
    } catch (err) {
      /*
       * The server's message, not a generic one.
       *
       * The refusal a doctor actually meets here is `resolveTreatingScope` —
       * no attended appointment inside the prescribing window and no open
       * admission — and "Could not save" tells them nothing they can act on
       * while "you are not currently treating this patient" does.
       */
      setError(err instanceof ApiError ? err.message : 'Could not save the record');
    } finally {
      setSaving(false);
    }
  }

  if (!visible) return null;

  return (
    <View style={s.overlay} pointerEvents="auto">
      <KeyboardAvoidingView
        style={s.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.header}>
          <Text style={s.title}>New record</Text>
          <Text style={s.close} onPress={onClose}>
            Close
          </Text>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {/* Who this is about, restated at the moment of writing. The same
              reason the medication round restates the patient, bed and medicine
              at the moment of signing. */}
          <Card>
            <Text style={s.patient}>{patientName}</Text>
            <Text style={s.muted}>#{patientId}</Text>
          </Card>

          {error && <ErrorBanner message={error} />}

          <Card>
            <Text style={s.label}>Diagnosis</Text>
            <TextInput
              style={s.input}
              value={diagnosis}
              onChangeText={setDiagnosis}
              placeholder="What you are treating"
              placeholderTextColor={theme.color.textSubtle}
              autoCapitalize="sentences"
            />

            <Text style={[s.label, s.spaced]}>Notes</Text>
            <TextInput
              style={[s.input, s.multiline]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Findings, history, plan — optional"
              placeholderTextColor={theme.color.textSubtle}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              autoCapitalize="sentences"
            />
          </Card>

          <Text style={s.footnote}>
            Saved as written and not editable afterwards — a correction is a new record. It attaches
            to today&rsquo;s appointment if there is one.
          </Text>
        </ScrollView>

        <View style={s.actions}>
          <Button
            label="Save record"
            busy={saving}
            // A record with no diagnosis is a note nobody can find again, and
            // the API refuses it anyway — better to say so before the round trip.
            disabled={!diagnosis.trim()}
            onPress={() => void submit()}
            style={s.grow}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.bg,
    zIndex: 20,
  },
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  title: { ...theme.font.title, color: theme.color.text },
  close: { ...theme.font.body, color: theme.color.primary },
  body: { padding: theme.space(4), gap: theme.space(3) },
  patient: { ...theme.font.heading, color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  label: { ...theme.font.caption, color: theme.color.textSubtle },
  spaced: { marginTop: theme.space(3) },
  input: {
    ...theme.font.body,
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    marginTop: theme.space(1),
    backgroundColor: theme.color.surface,
  },
  multiline: { minHeight: 120 },
  footnote: { ...theme.font.caption, color: theme.color.textSubtle },
  actions: {
    flexDirection: 'row',
    gap: theme.space(2),
    padding: theme.space(4),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  grow: { flex: 1 },
});
