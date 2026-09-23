import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { OutboxProvider } from '@/lib/outbox-context';
import { AuthGate } from '@/components/auth-gate';
import { PasswordGate } from '@/components/password-gate';
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
          {/*
            Above the navigator, like the idle lock, so no deep link or
            notification tap can land past it. A temporary password set by an
            administrator is a credential two people know, and this is where it
            stops being shared.
          */}
          <PasswordGate>
            <OutboxProvider>
              <Navigator />
            </OutboxProvider>
          </PasswordGate>
        </AuthGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
