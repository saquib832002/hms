import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { loadNotifications } from '@/lib/push';
import { theme } from '@/lib/theme';
import { relativeAge } from '@/lib/format';
import { AppHeader, Card, Screen } from '@/components/ui';

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

  /*
   * `expo-notifications` is loaded through `loadNotifications` rather than
   * imported at the top of this file, and that is not a style preference.
   *
   * In Expo Go on Android the module throws **on import**, and Expo Router
   * statically requires every file under `app/` — so a top-level import here
   * took the entire app down at launch with a red screen naming `ExpoRoot.js`,
   * on a screen nobody had opened. See the comment on `loadNotifications`.
   *
   * It resolves to null where push is unavailable, and this screen then simply
   * never receives anything — which is what the empty state already describes.
   */
  useEffect(() => {
    let cancelled = false;
    const subscriptions: { remove: () => void }[] = [];

    void (async () => {
      const Notifications = await loadNotifications();
      // `cancelled` matters: the await means the screen can unmount before the
      // module resolves, and a listener registered after that would never be
      // removed by the cleanup below — it has already run.
      if (!Notifications || cancelled) return;

      subscriptions.push(
        Notifications.addNotificationReceivedListener((n) => {
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
        }),
        Notifications.addNotificationResponseReceivedListener(() => {
          // Every notification kind currently resolves to the queue. The lock
          // screen is passed by AuthGate first, so a tap on a locked phone lands
          // on the unlock prompt rather than a patient record.
          router.push('/(tabs)');
        }),
      );
    })();

    return () => {
      cancelled = true;
      for (const s of subscriptions) s.remove();
    };
  }, [router]);

  return (
    <Screen>
      <AppHeader title={'Alerts'} />
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
    </Screen>
  );
}

const s = StyleSheet.create({
  list: { padding: theme.space(3) },
  kind: {
    ...theme.font.caption,
    letterSpacing: 0.5,
    color: theme.color.textSubtle,
    textTransform: 'uppercase',
  },
  body: { ...theme.font.body, color: theme.color.text, marginTop: 2 },
  age: { ...theme.font.caption, color: theme.color.textMuted, marginTop: 2 },
  empty: { ...theme.font.body, color: theme.color.textMuted, textAlign: 'center' },
  emptyHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(2),
    lineHeight: 17,
  },
});
