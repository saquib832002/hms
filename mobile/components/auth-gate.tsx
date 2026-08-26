import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';
import { Button } from './ui';
import LoginScreen from '@/components/login-screen';

/**
 * Three states before any screen renders: booting, signed out, and locked.
 *
 * The lock screen sits *above* the navigator rather than being a route, so
 * there is no way to deep-link past it — a notification tap on a locked phone
 * lands here, not on a patient record.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, locked, unlock, signOut } = useAuth();

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!user) return <LoginScreen />;

  if (locked) {
    return (
      <View style={s.centre}>
        <Text style={s.lockTitle}>Locked</Text>
        <Text style={s.lockBody}>
          Meridian HMS locked after 15 minutes of inactivity.
        </Text>
        <Button label="Unlock" onPress={() => void unlock()} style={s.lockButton} />
        <Button
          label="Sign out"
          variant="secondary"
          onPress={() => void signOut()}
          style={s.lockButton}
        />
      </View>
    );
  }

  return <>{children}</>;
}

const s = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.bg,
    padding: theme.space(6),
  },
  lockTitle: { fontSize: 24, fontWeight: '800', color: theme.color.text },
  lockBody: {
    fontSize: 15,
    color: theme.color.textMuted,
    textAlign: 'center',
    marginTop: theme.space(2),
    marginBottom: theme.space(6),
  },
  lockButton: { alignSelf: 'stretch', marginBottom: theme.space(2) },
});
