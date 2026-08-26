import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiOrigin, switchableRoles } from '@/lib/api';
import { clearQueueCache } from '@/lib/use-queue';
import { useOutbox } from '@/lib/outbox-context';
import { theme } from '@/lib/theme';
import { Button, Card } from '@/components/ui';

const ROLE_LABEL: Record<string, string> = {
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  PHARMACIST: 'Pharmacist',
  ADMIN: 'Administrator',
  RECEPTIONIST: 'Reception',
  BILLING_STAFF: 'Billing',
};

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
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Account</Text>
      </View>

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
          Only when there is a real choice. Most staff hold one role, and an
          owner-doctor may hold roles this app has no screens for — those are
          filtered out rather than offered and then refused.
        */}
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
          <Text style={s.sectionTitle}>What this app does not do</Text>
          <Text style={s.note}>
            Appointment booking, patient registration, billing and full history
            review are web-only. Mobile covers what can reasonably be done
            standing up.
          </Text>
        </Card>

        {__DEV__ && (
          <Card>
            <Text style={s.sectionTitle}>Development</Text>
            <Text style={s.meta}>API: {apiOrigin()}</Text>
          </Card>
        )}

        <Button label="Sign out" variant="danger" onPress={() => void onSignOut()} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  header: {
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(2),
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  title: { fontSize: 24, fontWeight: '800', color: theme.color.text },
  body: { padding: theme.space(3) },
  name: { fontSize: 18, fontWeight: '700', color: theme.color.text },
  meta: { fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: theme.color.text, marginBottom: 4 },
  note: { fontSize: 13, color: theme.color.textMuted, lineHeight: 19 },
  error: { fontSize: 13, color: theme.color.danger, marginTop: 6 },
});
