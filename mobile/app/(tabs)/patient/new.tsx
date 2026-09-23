import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { theme } from '@/lib/theme';
import { date } from '@/lib/format';
import { Button, Card, FloatingError, Screen } from '@/components/ui';

/**
 * Patient registration.
 *
 * The duplicate check is the point of this screen, not the form. Split patient
 * records are among the most damaging data problems a hospital can have — an
 * allergy recorded against one copy is invisible from the other, and nobody
 * finds out until it matters. So possible matches surface *while typing*,
 * before the record exists, rather than as a report someone reconciles later.
 *
 * It warns; it does not block. Two real people genuinely do share a name, and a
 * receptionist with the patient in front of them is better placed to judge that
 * than a string comparison.
 */

interface DuplicateMatch {
  id: number;
  fullName: string;
  dob: string;
  phone: string | null;
}

type Gender = 'MALE' | 'FEMALE' | 'OTHER';

export default function RegisterPatientScreen() {
  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState<Gender>('FEMALE');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');

  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const dismissed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const name = fullName.trim();
    const tel = phone.trim();
    if (name.length < 3 && tel.length < 6) {
      setDuplicates([]);
      return;
    }

    let cancelled = false;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ fullName: name });
      if (tel) params.set('phone', tel);
      api<{ data: DuplicateMatch[] }>(`/patients/duplicates?${params}`)
        .then((res) => !cancelled && setDuplicates(res.data))
        // A failing duplicate check must never block registration — the patient
        // is standing there. Degrade to no warning rather than to no service.
        .catch(() => !cancelled && setDuplicates([]));
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fullName, phone]);

  const submit = async () => {
    setError(null);

    if (!fullName.trim()) return setError('Name is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob.trim())) {
      return setError('Date of birth must be YYYY-MM-DD.');
    }

    setSaving(true);
    try {
      const created = await api<{ id: number }>('/patients', {
        method: 'POST',
        body: {
          fullName: fullName.trim(),
          dob: dob.trim(),
          gender,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(address.trim() ? { address: address.trim() } : {}),
        },
      });
      router.replace(`/patient/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not register this patient');
    } finally {
      setSaving(false);
    }
  };

  const showDuplicates = duplicates.length > 0 && !dismissed.current;

  return (
    <Screen>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">

          {showDuplicates && (
            <Card style={s.dupCard}>
              <Text style={s.dupTitle}>
                {duplicates.length} possible {duplicates.length === 1 ? 'match' : 'matches'}
              </Text>
              <Text style={s.muted}>
                Check this is not the same person before registering again.
              </Text>
              {duplicates.map((d) => (
                <View key={d.id} style={s.dupRow}>
                  <Text style={s.dupName}>{d.fullName}</Text>
                  <Text style={s.muted}>
                    born {date(d.dob)} · {d.phone ?? 'no phone'}
                  </Text>
                </View>
              ))}
              <Button
                label="Not the same person"
                variant="secondary"
                onPress={() => {
                  dismissed.current = true;
                  setDuplicates([]);
                }}
              />
            </Card>
          )}

          <Field label="Full name" value={fullName} onChange={setFullName} autoCapitalize="words" />
          <Field
            label="Date of birth"
            value={dob}
            onChange={setDob}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
          />

          <View style={s.field}>
            <Text style={s.label}>Gender</Text>
            <View style={s.genderRow}>
              {(['FEMALE', 'MALE', 'OTHER'] as Gender[]).map((g) => (
                <Button
                  key={g}
                  label={g[0] + g.slice(1).toLowerCase()}
                  variant={gender === g ? 'primary' : 'secondary'}
                  onPress={() => setGender(g)}
                  style={s.grow}
                />
              ))}
            </View>
          </View>

          <Field label="Phone" value={phone} onChange={setPhone} keyboardType="phone-pad" />
          <Field
            label="Email"
            value={email}
            onChange={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Field label="Address" value={address} onChange={setAddress} multiline />

          <Button label="Register patient" busy={saving} onPress={() => void submit()} />
          <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
        </ScrollView>
      </KeyboardAvoidingView>

      <FloatingError message={error} onDismiss={() => setError(null)} />
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  autoCapitalize = 'sentences',
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboardType?: React.ComponentProps<typeof TextInput>['keyboardType'];
  autoCapitalize?: React.ComponentProps<typeof TextInput>['autoCapitalize'];
  multiline?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={[s.input, multiline && s.inputMultiline]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.color.textSubtle}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
      />
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: theme.space(4), gap: theme.space(3) },
  field: { gap: theme.space(1) },
  label: { ...theme.font.small, color: theme.color.textMuted },
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
  inputMultiline: { minHeight: theme.touchTarget * 2, paddingTop: theme.space(3) },
  genderRow: { flexDirection: 'row', gap: theme.space(2) },
  grow: { flex: 1 },
  dupCard: { gap: theme.space(2), borderColor: theme.color.warning, borderWidth: 1 },
  dupTitle: { ...theme.font.body, color: theme.color.warning },
  dupRow: { paddingVertical: theme.space(1) },
  dupName: { ...theme.font.body, color: theme.color.text },
  muted: { ...theme.font.small, color: theme.color.textSubtle },
});
