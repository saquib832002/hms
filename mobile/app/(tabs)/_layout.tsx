import { Tabs } from 'expo-router';
import { Platform, Text } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { accentFor, fillFor, headerBgFor, theme } from '@/lib/theme';

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
  const isReception = user?.role === 'RECEPTIONIST';
  const isBilling = user?.role === 'BILLING_STAFF';

  // The bar wears the same accent as the header, so the app reads as one piece
  // and the active role stays legible from the bottom of the screen too.
  const accent = accentFor(user?.role);

  const icon =
    (glyph: string) =>
    ({ color, focused }: { color: string; focused: boolean }) => (
      <Text style={{ color, fontSize: focused ? 19 : 17 }}>{glyph}</Text>
    );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: theme.color.textSubtle,
        tabBarStyle: {
          // Same pale wash as the header, so the app is bracketed by its colour
          // top and bottom. The active tab uses the darkened accent — the neon
          // fill itself would be unreadable as a 9px label.
          backgroundColor: headerBgFor(user?.role),
          borderTopColor: fillFor(user?.role),
          borderTopWidth: 2,
          // Taller than the default: these are gloved thumbs in a hurry, and
          // the stock 49pt bar puts the labels uncomfortably close to the edge.
          height: Platform.OS === 'ios' ? 82 : 60,
          paddingTop: theme.space(1),
          paddingBottom: Platform.OS === 'ios' ? theme.space(7) : theme.space(2),
          ...theme.elevation.raised,
        },
        tabBarLabelStyle: { ...theme.font.overline, textTransform: 'none' },
        tabBarItemStyle: { paddingVertical: 2 },
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

      {/* Reception — check-in is the reason this role has an app at all. */}
      <Tabs.Screen
        name="schedule"
        options={{ title: 'Schedule', tabBarIcon: icon('▤'), href: isReception ? undefined : null }}
      />
      <Tabs.Screen
        name="patients"
        options={{ title: 'Patients', tabBarIcon: icon('◍'), href: isReception ? undefined : null }}
      />

      {/* Billing — look up and take payment. Aging and reconciliation are web. */}
      <Tabs.Screen
        name="invoices"
        options={{ title: 'Invoices', tabBarIcon: icon('¤'), href: isBilling ? undefined : null }}
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
