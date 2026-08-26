import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDoctorQueue } from '@/lib/use-queue';
import { useAuth } from '@/lib/auth-context';
import { relativeAge, time } from '@/lib/format';
import { statusColors, statusLabel, theme } from '@/lib/theme';
import { Card, ErrorBanner, StatusPill } from '@/components/ui';
import type { QueueItem } from '@/lib/types';

/**
 * Today's queue — the landing screen and the reason this app exists.
 *
 * One `/me/queue` call renders everything here. The web app could afford four
 * requests to compose this; a doctor standing in a corridor on hospital wifi
 * cannot, and they are waiting on it before walking into a room.
 */
export default function QueueScreen() {
  const { user } = useAuth();
  const { queue, loading, error, fetchedAt, stale, refresh } = useDoctorQueue();
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  // /me/queue is doctor-only server-side. A nurse reaching this route (deep
  // link, stale navigation state) should see an explanation, not a 403.
  if (user && user.role !== 'DOCTOR') {
    return (
      <SafeAreaView style={s.root} edges={['top']}>
        <View style={s.header}>
          <Text style={s.title}>Queue</Text>
        </View>
        <Card>
          <Text style={s.empty}>The patient queue belongs to doctors. Your ward is on the Ward tab.</Text>
        </Card>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Today&apos;s Queue</Text>
        <Text style={s.subtitle}>
          {queue?.doctor?.fullName ?? '…'}
          {queue?.doctor?.department ? ` · ${queue.doctor.department}` : ''}
        </Text>
      </View>

      {/* Staleness is stated, never implied. A queue that silently stopped
          updating looks exactly like a quiet morning. */}
      {stale && (
        <View style={s.staleBar}>
          <Text style={s.staleText}>
            Offline — showing data from {relativeAge(fetchedAt)}
          </Text>
        </View>
      )}

      {error && !queue && <ErrorBanner message={error} />}

      <FlatList
        data={queue?.appointments ?? []}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
        ListHeaderComponent={
          queue ? (
            <View style={s.stats}>
              <Stat label="Total" value={queue.stats.total} />
              <Stat label="Waiting" value={queue.stats.waiting} tone={theme.color.warning} />
              <Stat label="Done" value={queue.stats.completed} tone={theme.color.success} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          loading ? null : (
            <Card>
              <Text style={s.empty}>Nothing booked today.</Text>
            </Card>
          )
        }
        renderItem={({ item }) => (
          <QueueRow item={item} onPress={() => router.push(`/patient/${item.patient.id}`)} />
        )}
      />
    </SafeAreaView>
  );
}

function QueueRow({ item, onPress }: { item: QueueItem; onPress: () => void }) {
  const colors = statusColors(item.status);
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {({ pressed }) => (
        <Card
          style={{
            opacity: pressed ? 0.7 : 1,
            borderLeftWidth: item.status === 'IN_PROGRESS' ? 4 : 1,
            borderLeftColor:
              item.status === 'IN_PROGRESS' ? theme.color.danger : theme.color.border,
          }}
        >
          <View style={s.rowTop}>
            <Text style={s.rowTime}>{time(item.scheduledAt)}</Text>
            <StatusPill label={statusLabel[item.status] ?? item.status} bg={colors.bg} fg={colors.fg} />
          </View>
          <View style={s.rowNameLine}>
            <Text style={s.rowName}>{item.patient.fullName}</Text>
            {/* A dot, not the substances. The detail belongs on a screen the
                doctor deliberately opened — which is an audited read. */}
            {item.patient.hasAllergies && (
              <View style={s.allergyDot} accessibilityLabel="Has recorded allergies" />
            )}
          </View>
          <Text style={s.rowMeta}>
            {item.patient.age}y · {item.patient.gender.toLowerCase()}
            {item.reason ? ` · ${item.reason}` : ''}
          </Text>
        </Card>
      )}
    </Pressable>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
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
  subtitle: { fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  staleBar: { backgroundColor: '#3d4148', paddingVertical: 6, paddingHorizontal: theme.space(4) },
  staleText: { color: '#e6e9ec', fontSize: 12, textAlign: 'center' },
  list: { padding: theme.space(3) },
  stats: { flexDirection: 'row', gap: theme.space(2), marginBottom: theme.space(2) },
  stat: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingVertical: theme.space(2),
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800', color: theme.color.text },
  statLabel: { fontSize: 11, color: theme.color.textMuted, textTransform: 'uppercase' },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTime: { fontVariant: ['tabular-nums'], fontSize: 14, fontWeight: '700', color: theme.color.textMuted },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rowName: { fontSize: 18, fontWeight: '700', color: theme.color.text },
  allergyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.danger },
  rowMeta: { fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  empty: { fontSize: 15, color: theme.color.textMuted, textAlign: 'center' },
});
