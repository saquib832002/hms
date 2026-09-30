import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api, ApiError } from '@/lib/api';
import { BRAND, SIGNUP_BUNDLES } from '@/lib/types';
import { theme } from '@/lib/theme';
import { Button, ErrorBanner } from './ui';

/**
 * Ask to become a customer, from the phone.
 *
 * WHY THIS IS NOT A ROUTE
 * -----------------------
 * `AuthGate` sits *above* the navigator — deliberately, so no deep link or
 * notification tap can land past the lock screen. Nothing under `app/` renders
 * while there is no user, so a `app/signup.tsx` route would be unreachable to
 * exactly the person it exists for. So this is a sibling of `LoginScreen`,
 * toggled by it, which is the same reason the lock screen is not a route.
 *
 * WHY IT IS ON THE PHONE AT ALL
 * -----------------------------
 * `POST /public/signup` sat in `endpoint-coverage.spec.ts`'s single-client list
 * reasoning that *"signing up is done by somebody who is not yet a customer and
 * has no reason to have installed a staff app"*. That was plausible and it was
 * wrong in the same way three earlier exemptions were: the app is on a public
 * store. A clinic owner who finds it, installs it and opens it is precisely the
 * target market this product describes — a small practice whose owner has a
 * phone and may not have a desktop — and what they met was a sign-in form with
 * no way in and nothing saying how to get one.
 *
 * PUBLIC, AND THEREFORE NOT DENSE
 * -------------------------------
 * The one carve-out in the UI rules. The person reading this has no account, no
 * training and no reason to persist, so it is four fields and a sentence.
 *
 * WHAT IT DOES NOT TELL YOU
 * -------------------------
 * Whether this email has applied before, and whether the code is free. Both
 * would be useful and both would turn a public endpoint into a way to enumerate
 * the vendor's customers and prospects. The reviewer sees duplicates and
 * collisions instead. The success message says the same thing either way, which
 * is what makes that hold.
 */
export default function SignupScreen({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState({
    hospitalName: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    requestedSlug: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /**
   * Which shape of business they are, as the bundle id — the set is derived at
   * submit from `SIGNUP_BUNDLES`, which lives in `types.ts` precisely so this
   * screen and the web form cannot disagree about what "a pharmacy" includes.
   *
   * Empty stays empty. Nothing here is required, and an unanswered question
   * reaches the reviewer as "did not say" rather than as a guess.
   */
  const [bundle, setBundle] = useState<string>('');

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  /*
   * The same three conditions the web form applies, and deliberately not more.
   * A phone keyboard makes every extra required field cost more than it does at
   * a desk, and bed counts and department lists are a telephone call.
   */
  const valid =
    form.hospitalName.trim().length >= 2 &&
    form.contactName.trim().length >= 2 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.contactEmail.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('/public/signup', {
        method: 'POST',
        body: {
          hospitalName: form.hospitalName.trim(),
          contactName: form.contactName.trim(),
          contactEmail: form.contactEmail.trim(),
          contactPhone: form.contactPhone.trim() || undefined,
          requestedSlug: form.requestedSlug.trim().toLowerCase() || undefined,
          // The set, never the bundle id — a commercial label must not reach the
          // data model, for the reason `Tenant.modules` is a set rather than a
          // plan name. Same line as the web form.
          requestedModules: SIGNUP_BUNDLES.find((b) => b.id === bundle)?.modules,
          notes: form.notes.trim() || undefined,
        },
        /*
         * Nobody is signed in. Without this the client tries to refresh a
         * session that does not exist, and a clean 4xx becomes a "your session
         * has ended" message to somebody who never had one.
         */
        skipRefresh: true,
      });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not send that just now. Please try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <View style={s.root}>
        <View style={s.inner}>
          <Text style={s.title}>Application sent</Text>
          <Text style={s.body}>
            Somebody will read it and be in touch by email. Nothing has been created yet — your
            hospital is set up once the application is approved, and you will be sent a temporary
            password then.
          </Text>
          <Button label="Back to sign in" onPress={onBack} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.inner} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Apply for an account</Text>
        <Text style={s.body}>
          For a hospital, clinic, pharmacy or laboratory that does not use {BRAND} yet. This sends
          an application for somebody to read — it does not create an account.
        </Text>

        <View style={s.card}>
          <Field
            label="Hospital or clinic name"
            value={form.hospitalName}
            onChangeText={set('hospitalName')}
          />
          <Field label="Your name" value={form.contactName} onChangeText={set('contactName')} />
          <Field
            label="Email"
            value={form.contactEmail}
            onChangeText={set('contactEmail')}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <Field
            label="Phone (optional)"
            value={form.contactPhone}
            onChangeText={set('contactPhone')}
            keyboardType="phone-pad"
          />
          {/*
           * Worded to match the web form, and neither says "web address" — the
           * slug is in no URL in this product. It is the code a partner pharmacy
           * or laboratory identifies this hospital by, and what staff type at
           * sign-in when they hold accounts at two. See the web signup page for
           * the longer note.
           */}
          <Field
            label="Short code for your hospital (optional)"
            value={form.requestedSlug}
            onChangeText={set('requestedSlug')}
            autoCapitalize="none"
            hint="Lowercase, no spaces — like st-marys. Partners use it to identify you, and staff type it at sign-in if they have accounts at two hospitals. We can pick one for you."
          />
          {/*
           * What they run, tapped rather than typed — six rows, each its own
           * touch target, because the difference between "a clinic" and "a
           * clinic with a laboratory" is the thing being chosen and a picker
           * that hides five options behind a tap makes it unreadable.
           *
           * Tapping the chosen row again clears it. A radio group with no way
           * back means an accidental tap is permanent for the life of the form,
           * and this question is optional — so "none of these" has to stay
           * reachable after somebody has answered.
           */}
          <View>
            <Text style={s.label}>What do you run? (optional)</Text>
            <Text style={s.hint}>
              So we set you up with the parts you need. We can change it later.
            </Text>
            {SIGNUP_BUNDLES.map((b) => {
              const on = bundle === b.id;
              return (
                <Pressable
                  key={b.id}
                  onPress={() => setBundle(on ? '' : b.id)}
                  style={[s.bundle, on && s.bundleOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[s.bundleLabel, on && s.bundleLabelOn]}>{b.label}</Text>
                  <Text style={s.bundleHint}>{b.hint}</Text>
                </Pressable>
              );
            })}
          </View>

          <Field
            label="Anything else (optional)"
            value={form.notes}
            onChangeText={set('notes')}
            multiline
          />

          {error && <ErrorBanner message={error} />}

          <Button
            label="Send application"
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

/**
 * A labelled input. Labels rather than placeholders, because a placeholder
 * vanishes the moment somebody types and this form has six boxes a stranger is
 * filling in on a phone — "what was this one?" is answered by looking, not by
 * clearing the field to check.
 */
function Field({
  label,
  hint,
  multiline,
  ...input
}: {
  label: string;
  hint?: string;
  multiline?: boolean;
  value: string;
  onChangeText: (v: string) => void;
  autoCapitalize?: 'none' | 'sentences';
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
}) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={[s.input, multiline && s.multiline]}
        placeholderTextColor={theme.color.textSubtle}
        autoCorrect={false}
        multiline={multiline}
        {...input}
      />
      {hint && <Text style={s.hint}>{hint}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  inner: { padding: theme.space(6), paddingTop: theme.space(10), gap: theme.space(3) },
  title: { ...theme.font.display, color: theme.color.text },
  body: { ...theme.font.body, color: theme.color.textMuted, marginBottom: theme.space(2) },
  card: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.lg,
    padding: theme.space(4),
    gap: theme.space(3),
    ...theme.elevation.card,
  },
  label: { ...theme.font.caption, color: theme.color.textMuted, marginBottom: theme.space(1) },
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
  multiline: { minHeight: theme.touchTarget * 2, paddingTop: theme.space(3) },
  /*
   * A row, not a chip. `minHeight` is the shared touch target rather than a
   * guessed number, so this stays large enough for a thumb if that value ever
   * changes — and the selected state carries a border as well as a tint,
   * because colour alone is not a state for somebody who cannot see it.
   */
  bundle: {
    minHeight: theme.touchTarget,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(3),
    marginTop: theme.space(2),
  },
  bundleOn: { borderColor: theme.color.primary, borderWidth: 2 },
  bundleLabel: { ...theme.font.body, color: theme.color.text },
  bundleLabelOn: { fontWeight: '700' },
  bundleHint: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: theme.space(1) },
  hint: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: theme.space(1) },
});
