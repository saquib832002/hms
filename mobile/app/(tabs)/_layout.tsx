import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';

/**
 * Tabs are derived from the signed-in role, exactly like the web sidebar.
 *
 * Expo Router registers every screen in the folder, so screens that do not
 * belong to the current role are hidden with `href: null` rather than omitted —
 * that removes them from the bar *and* from deep linking, so a notification
 * cannot drop a doctor onto the medication round.
 *
 * As on web, this is a usability boundary. The API is the security one.
 */
export default function TabsLayout() {
  const { user } = useAuth();
  const isNurse = user?.role === 'NURSE';
  const isDoctor = user?.role === 'DOCTOR';
  const isPharmacist = user?.role === 'PHARMACIST';
  const isAdmin = user?.role === 'ADMIN';

  const icon = (glyph: string) => ({ color }: { color: string }) => (
    <Text style={{ color, fontSize: 18 }}>{glyph}</Text>
  );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.primary,
        tabBarInactiveTintColor: theme.color.textSubtle,
        tabBarStyle: { borderTopColor: theme.color.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      {/* Doctor */}
      <Tabs.Screen
        name="index"
        options={{ title: 'Queue', tabBarIcon: icon('▤'), href: isDoctor ? undefined : null }}
      />

      {/* Nurse */}
      <Tabs.Screen
        name="ward"
        options={{ title: 'Ward', tabBarIcon: icon('▥'), href: isNurse ? undefined : null }}
      />
      <Tabs.Screen
        name="vitals"
        options={{ title: 'Vitals', tabBarIcon: icon('♥'), href: isNurse ? undefined : null }}
      />
      <Tabs.Screen
        name="meds"
        options={{ title: 'Meds', tabBarIcon: icon('℞'), href: isNurse ? undefined : null }}
      />

      {/* Pharmacist — read-only. Dispensing needs the stock in front of you. */}
      <Tabs.Screen
        name="pharmacy"
        options={{ title: 'Pharmacy', tabBarIcon: icon('℞'), href: isPharmacist ? undefined : null }}
      />

      {/* Admin — aggregates only, no patient reachable from here. */}
      <Tabs.Screen
        name="overview"
        options={{ title: 'Overview', tabBarIcon: icon('▨'), href: isAdmin ? undefined : null }}
      />

      {/* All roles */}
      <Tabs.Screen name="alerts" options={{ title: 'Alerts', tabBarIcon: icon('🔔') }} />
      <Tabs.Screen name="me" options={{ title: 'Me', tabBarIcon: icon('☰') }} />
    </Tabs>
  );
}
