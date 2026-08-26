import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { theme } from '@/lib/theme';
import { relativeAge } from '@/lib/format';
import { Card } from '@/components/ui';

interface AlertItem {
  id: string;
  kind: string;
  receivedAt: Date;
  appointmentId?: number;
}

const TITLES: Record<string, string> = {
  PATIENT_CHECKED_IN: 'A patient has checked in for you',
  QUEUE_WAITING: 'You have patients waiting',
  PRESCRIPTION_QUERY: 'A prescription needs your clarification',
  CRITICAL_RESULT: 'A result requires your attention',
};

/**
 * Alerts received this session.
 *
 * Note what is NOT here: patient names. The notification the server sent
 * carried only a kind and an id, so that is all this list can show. Tapping
 * through fetches the detail over the authenticated API — a read that lands
 * in the audit log, unlike a glance at a notification tray.
 */
export default function AlertsScreen() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as { kind?: string; appointmentId?: number };
      setAlerts((prev) => [
        {
          id: n.request.identifier,
          kind: data.kind ?? 'QUEUE_WAITING',
          appointmentId: data.appointmentId,
          receivedAt: new Date(),
        },
        ...prev,
      ]);
    });

    const tapped = Notifications.addNotificationResponseReceivedListener(() => {
      // Every notification kind currently resolves to the queue. The lock
      // screen is passed by AuthGate first, so a tap on a locked phone lands
      // on the unlock prompt rather than a patient record.
      router.push('/(tabs)');
    });

    return () => {
      received.remove();
      tapped.remove();
    };
  }, [router]);

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Alerts</Text>
      </View>
      <FlatList
        data={alerts}
        keyExtractor={(a) => a.id}
        contentContainerStyle={s.list}
        ListEmptyComponent={
          <Card>
            <Text style={s.empty}>No alerts yet.</Text>
            <Text style={s.emptyHint}>
              Alerts never contain patient names or clinical details — a lock
              screen is visible to anyone holding the phone.
            </Text>
          </Card>
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={s.kind}>{item.kind.replace(/_/g, ' ')}</Text>
            <Text style={s.body}>{TITLES[item.kind] ?? 'You have a new alert'}</Text>
            <Text style={s.age}>{relativeAge(item.receivedAt)}</Text>
          </Card>
        )}
      />
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
  list: { padding: theme.space(3) },
  kind: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: theme.color.textSubtle,
    textTransform: 'uppercase',
  },
  body: { fontSize: 15, fontWeight: '600', color: theme.color.text, marginTop: 2 },
  age: { fontSize: 12, color: theme.color.textMuted, marginTop: 2 },
  empty: { fontSize: 15, color: theme.color.textMuted, textAlign: 'center' },
  emptyHint: {
    fontSize: 12,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(2),
    lineHeight: 17,
  },
});
