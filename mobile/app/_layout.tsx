import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/lib/auth-context';
import { OutboxProvider } from '@/lib/outbox-context';
import { AuthGate } from '@/components/auth-gate';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <AuthGate>
          <OutboxProvider>
            <Stack screenOptions={{ headerShown: false }} />
          </OutboxProvider>
        </AuthGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
