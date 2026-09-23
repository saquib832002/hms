import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';
import { Button, ErrorBanner } from './ui';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The hospital's own code, shown only after something has already failed.
   *
   * An email address is unique *per hospital*, so one person can hold accounts
   * at two — and login refuses to guess between them, because asking "which
   * hospital did you mean" confirms the address is registered and at more than
   * one place. Saying which is the way out, and the API has accepted `hospital`
   * since login was written while **neither client could send it**: anybody in
   * that position got *Invalid email or password* against a correct password.
   *
   * Revealed after **any** failure, a wrong password included — never only
   * after the ambiguous one. Showing it exactly when the address really is at
   * two hospitals would leak by the shape of the form what the single refusal
   * message exists to hide.
   */
  const [hospital, setHospital] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password, hospital.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={s.inner}>
        <View style={s.mark}>
          <Text style={s.markGlyph}>✚</Text>
        </View>
        <Text style={s.brand}>
          Meridian<Text style={{ color: theme.color.primary }}>HMS</Text>
        </Text>
        <Text style={s.sub}>Clinical sign in</Text>

        <View style={s.card}>
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={theme.color.textSubtle}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
          />
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={theme.color.textSubtle}
            secureTextEntry
            textContentType="password"
            onSubmitEditing={() => void submit()}
          />

          {/* After any failure, never only after the ambiguous one. */}
          {failed && (
            <>
              <TextInput
                style={s.input}
                value={hospital}
                onChangeText={setHospital}
                placeholder="Hospital code (only if you have two accounts)"
                placeholderTextColor={theme.color.textSubtle}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="organizationName"
                onSubmitEditing={() => void submit()}
              />
              <Text style={s.hint}>
                An administrator can read it off the clinic settings screen.
              </Text>
            </>
          )}

        {error && <ErrorBanner message={error} />}

          <Button label="Sign in" onPress={() => void submit()} busy={busy} />
        </View>

        {__DEV__ && (
          <Text style={s.devHint}>
            doctor@demo.test · nurse@demo.test · pharmacy@demo.test{'\n'}
            reception@demo.test · billing@demo.test · admin@demo.test{'\n'}
            ChangeMe123!
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg, justifyContent: 'center' },
  inner: { padding: theme.space(6) },
  mark: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.color.cross,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.space(4),
    ...theme.elevation.raised,
  },
  markGlyph: { ...theme.font.hero, color: theme.color.onAccent, fontWeight: '800' },
  brand: { ...theme.font.display, textAlign: 'center', color: theme.color.text },
  sub: {
    ...theme.font.small,
    textAlign: 'center',
    color: theme.color.textSubtle,
    marginBottom: theme.space(6),
  },
  card: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.lg,
    padding: theme.space(4),
    gap: theme.space(3),
    ...theme.elevation.card,
  },
  input: {
    minHeight: theme.touchTarget,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space(4),
    ...theme.font.input,
    color: theme.color.text,
  },
  hint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    marginTop: -theme.space(1),
    marginBottom: theme.space(2),
  },
  devHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(6),
    lineHeight: 18,
  },
});
