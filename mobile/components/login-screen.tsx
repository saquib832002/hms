import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';
import { Button, ErrorBanner } from './ui';
import SignupScreen from './signup-screen';
import ForgotPasswordScreen from './forgot-password-screen';
import Wordmark from './wordmark';
import { api } from '@/lib/api';
import { BRAND } from '@/lib/types';

export default function LoginScreen() {
  const { signIn } = useAuth();

  /**
   * Applying for an account, for somebody who does not have one yet.
   *
   * Held as state rather than reached as a route: `AuthGate` renders this screen
   * *above* the navigator so nothing can be deep-linked past the lock, which
   * means no route under `app/` renders while there is no user. A signup route
   * would be unreachable to precisely the person it is for.
   */
  const [applying, setApplying] = useState(false);

  /**
   * Asking for a reset link. A sibling too, for the same reason as signup —
   * nothing under `app/` renders while there is no user.
   */
  const [forgetting, setForgetting] = useState(false);

  /**
   * Whether this deployment has a mail transport at all.
   *
   * `null` is "not asked yet", and the link renders on `true` only, so a slow
   * or failed health check shows nothing rather than flashing an offer and
   * withdrawing it. The web login screen asks the same question of the same
   * endpoint.
   */
  const [resetAvailable, setResetAvailable] = useState<boolean | null>(null);
  /** `smtp` | `log` | `none` — so the screen can say what will happen. */
  const [resetDelivery, setResetDelivery] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ passwordResetAvailable?: boolean; passwordResetDelivery?: string }>('/health', {
      skipRefresh: true,
    })
      .then((body) => {
        if (cancelled) return;
        setResetAvailable(body?.passwordResetAvailable === true);
        setResetDelivery(body?.passwordResetDelivery ?? null);
      })
      /*
       * Hide the link, and say why in the log. Not surfaced to the user — a
       * failed health check on a sign-in screen is noise — but not silent
       * either: "no mail transport" and "the check did not answer" are
       * opposite problems that render as the same missing link.
       */
      .catch((err) => {
        if (cancelled) return;
        console.warn('Could not read password-reset capability; hiding the reset link.', err);
        setResetAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /*
   * Both siblings render here, after every hook. Putting a conditional return
   * above `useState` is the classic way to break the rules of hooks — the hook
   * order changes between renders — and it compiles perfectly.
   */
  if (applying) return <SignupScreen onBack={() => setApplying(false)} />;
  if (forgetting) return <ForgotPasswordScreen onBack={() => setForgetting(false)} />;

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
        <Wordmark style={s.brand} />
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

          {/*
            Inside the card, under the button, and only where the deployment can
            actually send one — see `resetAvailable`. A link into a flow that
            says "check your email" and sends nothing is the failure this repo
            keeps reopening, and the worst place to repeat it is the screen
            somebody reaches when they are already locked out.
          */}
          {resetAvailable === true && (
            <>
              <Text style={s.forgot} onPress={() => setForgetting(true)}>
                Forgot your password?
              </Text>
              {/* Same note as the web screen: with the `log` transport the
                  link is printed in the API log rather than emailed, and a
                  control that quietly behaves differently in development is
                  how somebody concludes mail works here. */}
              {resetDelivery === 'log' && (
                <Text style={s.forgotNote}>
                  Development: the link is printed in the API log, not emailed.
                </Text>
              )}
            </>
          )}
        </View>

        {/*
         * Below the card, and worded as an application rather than as
         * "Register".
         *
         * Everybody who opens this screen on an ordinary day already has an
         * account, so it must not compete with the password field. But the app
         * is on a public store, and a clinic owner who installs it to look at
         * the product previously met a sign-in form with no way in and nothing
         * saying how to get one — which is the shape this project keeps
         * recording. "Register" would promise self-service; this creates an
         * application a human reads, and no hospital exists until it is
         * approved.
         */}
        <Text style={s.applyLead}>
          Not a {BRAND} hospital yet?{' '}
          <Text style={s.applyLink} onPress={() => setApplying(true)}>
            Apply for an account
          </Text>
        </Text>

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
  /*
   * Underlined as well as coloured, like the apply link and for the same
   * reason: colour alone is not an affordance, and this is the only thing on
   * the screen that helps somebody who cannot get past it.
   */
  forgot: {
    ...theme.font.small,
    color: theme.color.primary,
    textDecorationLine: 'underline',
    textAlign: 'center',
    marginTop: theme.space(3),
  },
  forgotNote: {
    ...theme.font.caption,
    color: theme.color.warning,
    textAlign: 'center',
    marginTop: theme.space(1),
  },
  applyLead: {
    ...theme.font.small,
    color: theme.color.textMuted,
    textAlign: 'center',
    marginTop: theme.space(5),
  },
  /*
   * Underlined as well as coloured. Colour alone is not an affordance for
   * somebody who cannot distinguish it, and this is the only way into the
   * product for a person who has no account.
   */
  applyLink: { color: theme.color.primary, fontWeight: '600', textDecorationLine: 'underline' },
  devHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(6),
    lineHeight: 18,
  },
});
