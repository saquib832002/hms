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
        <Text style={s.brand}>
          Meridian<Text style={{ color: theme.color.primary }}>HMS</Text>
        </Text>
        <Text style={s.sub}>Clinical sign in</Text>

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

        <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={() => void submit()} busy={busy} />

        {__DEV__ && (
          <Text style={s.devHint}>
            doctor@demo.test · nurse@demo.test{'\n'}pharmacy@demo.test{'\n'}ChangeMe123!{'\n'}
            Set the API address in app.json → expo.extra.apiOrigin
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg, justifyContent: 'center' },
  inner: { padding: theme.space(6) },
  brand: { fontSize: 28, fontWeight: '800', textAlign: 'center', color: theme.color.text },
  sub: {
    fontSize: 15,
    color: theme.color.textMuted,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: theme.space(6),
  },
  input: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(3),
    minHeight: theme.touchTarget,
    fontSize: 16,
    color: theme.color.text,
    marginBottom: theme.space(3),
  },
  devHint: {
    marginTop: theme.space(6),
    fontSize: 12,
    color: theme.color.textSubtle,
    textAlign: 'center',
    lineHeight: 18,
  },
});
