import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { OutboxProvider } from '@/lib/outbox-context';
import { AuthGate } from '@/components/auth-gate';
import { accentFor, headerBgFor, theme } from '@/lib/theme';

/**
 * Pushed screens — register a patient, book, reschedule — use the native
 * header rather than the app's own `AppHeader`, because they need a working
 * back gesture and title animation that a hand-rolled bar does not give.
 *
 * They are tinted with the same role accent so the app does not visibly change
 * identity when a modal opens. Left as the platform default, a white bar with
 * black text appeared over a coloured app and looked like a different product.
 */
function Navigator() {
  const { user } = useAuth();
  const accent = accentFor(user?.role);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: headerBgFor(user?.role) },
        headerTintColor: accent,
        headerTitleStyle: { ...theme.font.heading, color: theme.color.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.color.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="patient/new" options={{ headerShown: true, title: 'Register patient' }} />
      <Stack.Screen name="patient/[id]" options={{ headerShown: true, title: 'Patient' }} />
      <Stack.Screen
        name="appointment/new"
        options={{ headerShown: true, title: 'Book appointment' }}
      />
      <Stack.Screen name="appointment/[id]" options={{ headerShown: true, title: 'Reschedule' }} />
      <Stack.Screen
        name="settings/clinic"
        options={{ headerShown: true, title: 'Clinic settings' }}
      />
      <Stack.Screen name="settings/staff" options={{ headerShown: true, title: 'Staff roles' }} />
      <Stack.Screen
        name="reports/activity"
        options={{ headerShown: true, title: 'Daily activity' }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        {/* Dark glyphs: the header is a pale wash, not a saturated fill. */}
        <StatusBar style="dark" />
        <AuthGate>
          <OutboxProvider>
            <Navigator />
          </OutboxProvider>
        </AuthGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
