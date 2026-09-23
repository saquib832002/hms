import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';
import { Button, Field } from './ui';

/**
 * Blocks the app until a forced password change is done.
 *
 * WHY THIS EXISTS, AND WHY IT IS LATE
 * -----------------------------------
 * The web has had `PasswordGate` since Phase 1. Mobile had nothing, so
 * `mustChangePassword` — set whenever an administrator creates an account or
 * resets a password — was simply ignored on a phone. A member of staff with no
 * laptop signed in on a temporary password that had been read aloud or written
 * on a slip of paper, and was never once asked to replace it. It stayed valid
 * indefinitely.
 *
 * That is a credential two people know, and it reads patient records.
 *
 * Nothing found it for a whole phase because every test asked whether *a*
 * client called `POST /me/password`, and one did. The per-client parity check
 * in `endpoint-coverage.spec.ts` is what surfaced it.
 *
 * ABOVE THE NAVIGATOR, NOT A ROUTE
 * --------------------------------
 * Same reasoning as the idle lock it sits beside: a route can be deep-linked
 * past, and a push notification tapped on a phone in this state would otherwise
 * land on a patient record. `mustChangePassword` is rebuilt from the database
 * by `JwtStrategy` on every request, so relaunching the app cannot get past it
 * either.
 */
export function PasswordGate({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user?.mustChangePassword) return <>{children}</>;

  const mismatch = confirm.length > 0 && next !== confirm;
  const valid = current.length > 0 && next.length >= 12 && next === confirm;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('/me/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      /*
       * The server revokes every session on a successful change, including this
       * one. Signing out is the honest consequence — pretending the tokens in
       * memory still work would produce a confusing 401 on the next tap.
       */
      await signOut();
    } catch (e) {
      // The server returns the specific weakness ("Include a number"), which is
      // more useful than restating the rules.
      setError(e instanceof Error ? e.message : 'Could not change your password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Choose a password</Text>
        <Text style={s.body_}>
          Your account was set up with a temporary password, which somebody else knows. Pick your
          own before going any further.
        </Text>

        <Field
          label="Temporary password"
          value={current}
          onChange={setCurrent}
          placeholder="The one you were given"
          autoCapitalize="none"
          secure
        />
        <Field
          label="New password"
          value={next}
          onChange={setNext}
          placeholder="At least 12 characters"
          autoCapitalize="none"
          secure
        />
        <Field
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          placeholder="Type it again"
          autoCapitalize="none"
          secure
        />

        {/* Stated as you type rather than on submit — a mismatch you learn
            about after pressing the button means retyping both fields. */}
        {mismatch && <Text style={s.warn}>The two new passwords do not match.</Text>}
        {next.length > 0 && next.length < 12 && (
          <Text style={s.warn}>{12 - next.length} more characters needed.</Text>
        )}
        {error && <Text style={s.error}>{error}</Text>}

        <Button
          label="Set password"
          onPress={() => void submit()}
          disabled={!valid}
          busy={busy}
          style={s.action}
        />
        <Button
          label="Sign out instead"
          variant="secondary"
          disabled={busy}
          onPress={() => void signOut()}
          style={s.action}
        />

        <Text style={s.footnote}>
          You will be signed out once it is changed — every other session ends too, which is the
          point.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  body: { padding: theme.space(6), paddingTop: theme.space(10) },
  title: { ...theme.font.hero, color: theme.color.text, marginBottom: theme.space(2) },
  body_: {
    ...theme.font.body,
    color: theme.color.textMuted,
    lineHeight: 20,
    marginBottom: theme.space(5),
  },
  warn: { ...theme.font.small, color: theme.color.warning, marginTop: theme.space(1) },
  error: { ...theme.font.small, color: theme.color.danger, marginTop: theme.space(2) },
  action: { marginTop: theme.space(3) },
  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginTop: theme.space(5),
    textAlign: 'center',
  },
});
