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

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
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
  devHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(6),
    lineHeight: 18,
  },
});
