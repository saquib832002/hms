import { useState } from 'react';
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
import { BRAND } from '@/lib/types';
import { Button, ErrorBanner } from './ui';

/**
 * Ask for a password-reset link, from the phone.
 *
 * WHY THIS IS NOT A ROUTE
 * -----------------------
 * `AuthGate` renders above the navigator, so nothing under `app/` renders while
 * there is no user. A route here would be unreachable to exactly the person it
 * exists for — the same constraint that makes `SignupScreen` a sibling of
 * `LoginScreen` rather than a screen.
 *
 * WHY THE PHONE ASKS AND THE BROWSER FINISHES
 * -------------------------------------------
 * This screen calls `POST /auth/forgot-password`. The link in the email points
 * at the **web** app, and following it on the phone opens the phone's browser,
 * which is where the new password gets chosen.
 *
 * That is a deliberate split rather than a gap, and it is worth being precise
 * about because this project's standing rule is that a feature ships on both
 * clients in the same change. What has to exist on both is the *ask*, and it
 * does: a nurse who is locked out is holding a phone, and telling her to find a
 * desktop to type her own email address into would be the "sign for doses on
 * the mobile app" dead end pointing the other way.
 *
 * What is genuinely single-client is the *link*, and it cannot be otherwise
 * without costing something real. A reset URL has to be one canonical address
 * that works in any mail client on any device, and a deep link into an app the
 * recipient may not have installed is not that. Handing the app a second way to
 * spend a token — pasting it into a box — would mean two paths to the most
 * security-sensitive write in the product, and the second one exists only to
 * avoid a browser that is already open.
 *
 * WHAT THIS SCREEN WILL NOT TELL YOU
 * ----------------------------------
 * Whether the address has an account. The API answers identically either way,
 * because anything else makes a public endpoint a way to ask whether a named
 * person works at a hospital.
 */
export default function ForgotPasswordScreen({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The server's own sentence, held rather than restated here.
   *
   * It has to read identically for an address with an account and one without,
   * which is the whole enumeration defence — and a copy of it on each client is
   * how that quietly stops being true.
   */
  const [sent, setSent] = useState<string | null>(null);

  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
        // Nobody is signed in. Without this the client tries to refresh a
        // session that does not exist, and a clean response becomes a "your
        // session has ended" for somebody who never had one.
        skipRefresh: true,
      });
      setSent(res.message);
    } catch (err) {
      // A 429 is the realistic failure and it says something useful. Anything
      // else is a network problem, worth naming rather than covering with the
      // success sentence.
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not send that just now. Please try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <View style={s.root}>
        <View style={s.inner}>
          <Text style={s.title}>Check your email</Text>
          <Text style={s.body}>{sent}</Text>
          <Text style={s.body}>
            Open the link on this phone or any other device — it goes to the {BRAND} website, where
            you choose the new password.
          </Text>
          {/*
            Said plainly. The commonest reason somebody stares at an empty inbox
            is that the hospital holds a different address for them, and nothing
            in the message can say so — that is what it exists not to reveal.
            The screen can say what to check, which costs nothing and is the
            difference between a flow that works and one people give up on.
          */}
          <Text style={s.note}>
            If nothing arrives, check it is the address your hospital has for you, and look in spam.
            An administrator at your hospital can also reset it for you.
          </Text>
          <Button label="Back to sign in" onPress={onBack} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.inner} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Forgot your password?</Text>
        <Text style={s.body}>
          Enter the address you sign in with and we will send a link to set a new one. It expires in
          30 minutes.
        </Text>

        <View style={s.card}>
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@hospital.example"
            placeholderTextColor={theme.color.textSubtle}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            autoFocus
            onSubmitEditing={() => valid && void submit()}
          />

          {/*
            No hospital code here, unlike the sign-in form. Login needs one
            because it has to pick which account to check a password against;
            this picks nothing — one message goes to the mailbox with a link for
            each hospital the address is registered at. Asking for the code
            would demand the one thing somebody locked out is least likely to
            have, and this is in fact the only place in the product where that
            ambiguity resolves itself without already knowing it.
          */}

          {error && <ErrorBanner message={error} />}

          <Button
            label="Send the link"
            onPress={() => void submit()}
            busy={busy}
            disabled={!valid}
          />
          <Button label="Back to sign in" variant="secondary" onPress={onBack} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  inner: { padding: theme.space(6), paddingTop: theme.space(12), gap: theme.space(3) },
  title: { ...theme.font.display, color: theme.color.text },
  body: { ...theme.font.body, color: theme.color.textMuted },
  note: { ...theme.font.caption, color: theme.color.textSubtle },
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
});
