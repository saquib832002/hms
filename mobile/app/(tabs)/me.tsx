import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { apiOrigin, appEnv, switchableRoles } from '@/lib/api';
import { clearQueueCache } from '@/lib/use-queue';
import { useOutbox } from '@/lib/outbox-context';
import { theme } from '@/lib/theme';
import { AppHeader, Button, Card, Screen } from '@/components/ui';
import type { UserRole } from '@/lib/types';

const ROLE_LABEL: Record<string, string> = {
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  PHARMACIST: 'Pharmacist',
  ADMIN: 'Administrator',
  RECEPTIONIST: 'Reception',
  BILLING_STAFF: 'Billing',
};

/**
 * What the app does for the role currently being worn.
 *
 * WHY THIS IS PER-ROLE AND WHY IT IS MAINTAINED
 * ---------------------------------------------
 * The card this replaces read "Appointment booking, patient registration,
 * billing and full history review are web-only" — and by the time anyone read
 * it again, all four of those had been built. Stale copy describing a
 * limitation that no longer exists is worse than no copy: it is the app telling
 * its own users not to look for a feature that is one tap away, and it is the
 * same failure as the comment that justified locking reception out of mobile
 * for six phases.
 *
 * Keyed on the *active* role rather than every role held, because that is what
 * the tab bar is showing right now. Switching hats changes this list, which is
 * itself a useful demonstration of what switching does.
 */
const CAN_DO: Record<UserRole, string[]> = {
  DOCTOR: [
    'Today’s queue, with waiting times',
    'Patient summary — allergies, recent records, current medicines',
    'Write a prescription',
    'Complete a consultation and call the next patient',
  ],
  NURSE: [
    'Ward board — admit, transfer and discharge',
    'Bedside vitals',
    'Medication round and the drug chart',
    'Vitals and doses save offline and send themselves when signal returns',
  ],
  PHARMACIST: ['Dispensing queue', 'Stock and low-stock alerts'],
  LAB_TECHNICIAN: [
    'The worklist — what is waiting, on the bench and to authorise',
    'Mark a sample taken, or ask for another one',
    'Enter a result and authorise the report',
    'Work sent here by partner hospitals',
    'The laboratory till',
  ],
  RECEPTIONIST: [
    'The schedule for any day — not just today',
    'Check a patient in',
    'Register a patient, with duplicate detection',
    'Book, reschedule and cancel appointments',
    'Raise the consultation invoice at check-in',
  ],
  BILLING_STAFF: ['Outstanding invoices', 'Take a payment'],
  ADMIN: [
    'Overview — appointments, occupancy, staff and denied requests',
    'Takings today and this month, and a six-month trend',
    'Per-doctor workload and revenue',
    'Daily activity — who worked, what they did, and one person’s actions for a day',
    'Set a doctor’s consultation fee',
    'Clinic settings — currency, timezone, slot length, opening hours',
    'Staff roles — who may act as what',
  ],
};

/**
 * Kept deliberately, not by omission.
 *
 * Every line here is a decision with a reason recorded in `CLAUDE.md`. If one
 * of these ever ships on mobile, this list has to shrink on the same day — an
 * inaccurate "we don't do that" is how a working feature stays invisible.
 */
const WEB_ONLY = [
  'Creating staff accounts and resetting passwords — the temporary password has to be read out or written down',
  'Deactivating staff — getting it wrong locks someone out mid-shift',
  'Departments',
  'The full audit browser across all staff — scanning and filtering, which a phone is worst at. One person’s day is on the phone',
  'Invoice aging and the full twelve-month revenue table',
  'Side-by-side history review and bulk entry',
];

export default function MeScreen() {
  const { user, signOut, switchRole } = useAuth();
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const roles = switchableRoles(user);
  const { pending, flushing, flush, clear: clearOutbox } = useOutbox();

  async function onSignOut() {
    // The cached queue holds patient names and an allergy flag. Signing out
    // has to take that with it, or the next person to open the app sees the
    // previous doctor's list.
    await clearQueueCache();
    // Queued writes hold patient ids and clinical values. They go with the
    // session — anything still pending is lost, which is why the sign-out
    // button warns first.
    await clearOutbox();
    await signOut();
  }

  return (
    <Screen>
      <AppHeader title={'Account'} />

      {/*
        Scrollable, and it was not.
        --------------------------
        The content grew — roles held, the switcher, pending sync, two capability
        lists — and Sign out sat below the fold on a plain View with no way to
        reach it. A sign-out button you cannot reach is not a cosmetic problem
        on a shared clinical device: it is the control that clears the cached
        queue and any queued bedside writes off a phone somebody is handing over.

        `paddingBottom` clears the tab bar as well as the home indicator, so the
        last button is fully tappable rather than half under the bar.
      */}
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.body}>
        <Card>
          <Text style={s.name}>{user?.fullName}</Text>
          <Text style={s.meta}>{user?.email}</Text>
          <Text style={s.meta}>
            {ROLE_LABEL[user?.role ?? ''] ?? user?.role}
            {user?.hospital?.name ? ` · ${user.hospital.name}` : ''}
          </Text>
        </Card>

        {/*
          Roles held, stated whether or not there is a choice.
          ---------------------------------------------------
          The switcher below only appears when someone holds two or more, which
          is right — but it meant a single-role account and a broken switcher
          looked *identical*: nothing on screen either way. An owner-doctor
          reported the app had no role switching, and there was no way, from
          inside the app, to tell whether they held one role or the feature had
          failed. That ambiguity cost three rounds of guessing.

          So the roles the server says this session holds are always shown. It
          is one line, and it turns an invisible state into a checkable fact.
        */}
        <Card>
          <Text style={s.sectionTitle}>Roles held</Text>
          <Text style={s.note}>
            {(user?.availableRoles ?? []).map((r) => ROLE_LABEL[r] ?? r).join(' · ') || '—'}
          </Text>
          {roles.length < 2 ? (
            <Text style={s.note}>
              Only one role, so there is nothing to switch between. An administrator can grant
              more from Staff roles on the Overview tab, or Staff &amp; Users on the web.
            </Text>
          ) : null}
        </Card>

        {roles.length > 1 ? (
          <Card>
            <Text style={s.sectionTitle}>Acting as</Text>
            <Text style={s.note}>
              You hold more than one role. You act as one at a time — switching does not
              combine them.
            </Text>
            {roles.map((role) => (
              <Button
                key={role}
                label={
                  role === user?.role
                    ? `${ROLE_LABEL[role] ?? role} (current)`
                    : switching === role
                      ? 'Switching…'
                      : `Switch to ${ROLE_LABEL[role] ?? role}`
                }
                variant={role === user?.role ? 'primary' : 'secondary'}
                disabled={role === user?.role || switching !== null}
                onPress={() => {
                  setSwitchError(null);
                  setSwitching(role);
                  void switchRole(role)
                    .catch((e) =>
                      setSwitchError(e instanceof Error ? e.message : 'Could not switch role'),
                    )
                    .finally(() => setSwitching(null));
                }}
              />
            ))}
            {switchError ? <Text style={s.error}>{switchError}</Text> : null}
          </Card>
        ) : null}

        <Card>
          <Text style={s.sectionTitle}>Pending sync</Text>
          {pending === 0 ? (
            <Text style={s.note}>Everything recorded on this device has been sent.</Text>
          ) : (
            <>
              <Text style={s.note}>
                {pending} record{pending === 1 ? '' : 's'} saved on this device and waiting for
                signal. Signing out discards them.
              </Text>
              <Button
                label={flushing ? 'Syncing…' : 'Try to sync now'}
                variant="secondary"
                onPress={() => void flush()}
                style={{ marginTop: theme.space(2) }}
              />
            </>
          )}
        </Card>

        <Card>
          <Text style={s.sectionTitle}>
            What you can do here as {ROLE_LABEL[user?.role ?? ''] ?? 'this role'}
          </Text>
          {(CAN_DO[user?.role as UserRole] ?? []).map((line) => (
            <View key={line} style={s.bulletRow}>
              <Text style={s.bulletDot}>•</Text>
              <Text style={s.bullet}>{line}</Text>
            </View>
          ))}
          {roles.length > 1 ? (
            <Text style={s.footnote}>
              Switching role from the header changes this list — you act as one role at a time.
            </Text>
          ) : null}
        </Card>

        <Card>
          <Text style={s.sectionTitle}>Still on the web</Text>
          {WEB_ONLY.map((line) => (
            <View key={line} style={s.bulletRow}>
              <Text style={s.bulletDot}>•</Text>
              <Text style={s.bullet}>{line}</Text>
            </View>
          ))}
        </Card>

        {/*
          Shown in every build, not only in __DEV__.
          -----------------------------------------
          A staging build and the production one can be installed side by side,
          and the only reliable way to know which you are holding is to ask it.
          "Which database did that go into" is a bad question to have to answer
          after the fact.
        */}
        <Card>
          <Text style={s.sectionTitle}>Build</Text>
          <Text style={s.meta}>
            {appEnv()}
            {__DEV__ ? ' · debug' : ''}
          </Text>
          {__DEV__ && <Text style={s.meta}>API: {apiOrigin()}</Text>}
        </Card>

        <Button label="Sign out" variant="danger" onPress={() => void onSignOut()} />
      </View>
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  scroll: { paddingBottom: theme.space(10) },
  body: { padding: theme.space(3), gap: theme.space(3) },
  name: { ...theme.font.heading, color: theme.color.text },
  meta: { ...theme.font.small, color: theme.color.textMuted, marginTop: 2 },
  sectionTitle: { ...theme.font.small, color: theme.color.text, marginBottom: 4 },
  note: { ...theme.font.small, color: theme.color.textMuted, lineHeight: 19 },
  error: { ...theme.font.small, color: theme.color.danger, marginTop: 6 },

  bulletRow: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(1) },
  bulletDot: { ...theme.font.small, color: theme.color.textSubtle, lineHeight: 19 },
  bullet: { ...theme.font.small, color: theme.color.textMuted, lineHeight: 19, flex: 1 },
  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginTop: theme.space(2),
  },
});
