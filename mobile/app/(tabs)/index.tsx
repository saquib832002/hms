import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useDoctorQueue } from '@/lib/use-queue';
import { useAuth } from '@/lib/auth-context';
import { landingFor } from '@/lib/nav';
import { relativeAge, time } from '@/lib/format';
import { statusColors, statusLabel, theme } from '@/lib/theme';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import {
  AppHeader,
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Screen,
  StatTile,
  StatusPill,
} from '@/components/ui';
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
  /*
   * The redirect below cannot prevent the fetch — hooks run before a component
   * returns anything, so `<Redirect>` is evaluated after `useDoctorQueue` has
   * already asked for a doctor's queue. Non-doctors were producing a 403, and
   * therefore an audit denial, simply by signing in. The hook has to be told.
   */
  const isDoctor = user?.role === 'DOCTOR';
  const { queue, loading, error, fetchedAt, stale, refresh } = useDoctorQueue(isDoctor);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const router = useRouter();

  /*
   * Refetches on focus and every 15s.
   *
   * `useDoctorQueue` fetched once on mount, so completing a consultation and
   * coming back from the patient screen left the row still reading "with
   * doctor" — and a doctor comparing that to the waiting room would reasonably
   * think the app had not saved.
   */
  useLiveData(refresh);

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  /**
   * Move an appointment along the status machine.
   *
   * Deliberately *not* queued through the offline outbox. The outbox exists for
   * bedside observations, where the alternative is a nurse writing on her hand;
   * a consultation status is only meaningful while the clinic day is running,
   * and replaying "started consultation" an hour later would misreport when the
   * patient was seen. If the network is down the doctor should see it fail.
   */
  async function advance(item: QueueItem, status: 'IN_PROGRESS' | 'COMPLETED') {
    setBusyId(item.id);
    setActionError(null);
    try {
      await api(`/appointments/${item.id}/status`, { method: 'PATCH', body: { status } });
      // Refetch rather than patch in place: the queue's own stats — waiting,
      // in progress, completed — are computed server-side and would otherwise
      // disagree with the rows directly beneath them.
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update this appointment');
    } finally {
      setBusyId(null);
    }
  }

  /*
   * Anyone who is not a doctor is sent to their own first screen.
   *
   * Expo Router opens the tab group on `index`, which is this screen, so every
   * other role landed here regardless of who signed in — and read a refusal
   * message as the first thing after login.
   *
   * The redirect lives here rather than in `AuthGate` because a `router.replace`
   * fired from a provider above the navigator runs before the navigator has
   * mounted and is silently dropped. That was the first attempt at this fix and
   * it did nothing. `<Redirect>` is declarative and evaluated while this route
   * is mounted, so it cannot lose the race.
   */
  if (user && !isDoctor) {
    return <Redirect href={landingFor(user.role)} />;
  }


  return (
    <Screen>
      <AppHeader
        title="Today's Queue"
        subtitle={
          queue?.doctor
            ? `${queue.doctor.fullName}${queue.doctor.department ? ` · ${queue.doctor.department}` : ''}`
            : 'Loading…'
        }
        right={<Avatar name={user?.fullName ?? ''} onPress={() => router.push('/(tabs)/me')} />}
      />

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
      {/* A failed status change is shown even when the queue rendered fine —
          otherwise "Complete" appears to do nothing at all. */}
      {actionError && <ErrorBanner message={actionError} />}

      <FlatList
        data={queue?.appointments ?? []}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
        ListHeaderComponent={
          queue ? (
            <View style={s.stats}>
              <StatTile label="Total" value={queue.stats.total} />
              <StatTile label="Waiting" value={queue.stats.waiting} tone={theme.color.warning} />
              <StatTile label="Done" value={queue.stats.completed} tone={theme.color.success} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          loading ? null : (
            <EmptyState glyph="◷" title="Nothing booked today" body="Pull down to refresh." />
          )
        }
        renderItem={({ item }) => (
          <QueueRow
            item={item}
            busy={busyId === item.id}
            onPress={() => router.push(`/patient/${item.patient.id}`)}
            onStatus={(status) => void advance(item, status)}
          />
        )}
      />
    </Screen>
  );
}

/**
 * A queue row, and the two buttons that move the clinic day along.
 *
 * These were missing entirely until the first device run: the queue was
 * read-only, so a doctor could open a patient and write a prescription but had
 * no way to say "I am seeing this person now" or "I am done". The appointment
 * stayed CHECKED_IN forever, reception's board never advanced, and the doctor's
 * own stats always read zero completed.
 *
 * The web queue has had Start and Complete since Phase 1 — `endpoint-coverage`
 * saw a caller for `PATCH /appointments/:id/status` and was satisfied, because
 * it asks whether *a* client calls a route, not whether every client that needs
 * it does. That is a real limit of that test, worth knowing.
 *
 * Which transitions are legal is the server's decision, not this screen's:
 * CHECKED_IN → IN_PROGRESS → COMPLETED, doctor-only, and nothing moves
 * backwards. The buttons mirror it so a doctor is not offered an action that
 * will be refused.
 */
function QueueRow({
  item,
  busy,
  onPress,
  onStatus,
}: {
  item: QueueItem;
  busy: boolean;
  onPress: () => void;
  onStatus: (status: 'IN_PROGRESS' | 'COMPLETED') => void;
}) {
  const colors = statusColors(item.status);
  const canStart = item.status === 'CHECKED_IN';
  const canComplete = item.status === 'IN_PROGRESS';

  return (
    <Card
      style={{
        borderLeftWidth: item.status === 'IN_PROGRESS' ? 4 : 1,
        borderLeftColor: item.status === 'IN_PROGRESS' ? theme.color.danger : theme.color.border,
      }}
    >
      <Pressable onPress={onPress} accessibilityRole="button">
        {({ pressed }) => (
          <View style={{ opacity: pressed ? 0.7 : 1 }}>
            <View style={s.rowTop}>
              <Text style={s.rowTime}>{time(item.scheduledAt)}</Text>
              <StatusPill
                label={statusLabel[item.status] ?? item.status}
                bg={colors.bg}
                fg={colors.fg}
              />
            </View>
            <View style={s.rowNameLine}>
              <Text style={s.rowName} numberOfLines={1}>
                {item.patient.fullName}
              </Text>
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
          </View>
        )}
      </Pressable>

      {(canStart || canComplete) && (
        <View style={s.rowActions}>
          {canStart && (
            <Button
              label="Start consultation"
              busy={busy}
              onPress={() => onStatus('IN_PROGRESS')}
              style={s.grow}
            />
          )}
          {canComplete && (
            <>
              <Button
                label="Open"
                variant="secondary"
                onPress={onPress}
                style={s.grow}
              />
              <Button
                label="Complete"
                busy={busy}
                onPress={() => onStatus('COMPLETED')}
                style={s.grow}
              />
            </>
          )}
        </View>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  staleBar: {
    backgroundColor: theme.color.slateBar,
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(4),
  },
  staleText: { ...theme.font.caption, color: theme.color.text, textAlign: 'center' },
  list: { padding: theme.space(4), gap: theme.space(3) },
  stats: { flexDirection: 'row', gap: theme.space(2), marginBottom: theme.space(1) },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space(2),
  },
  rowTime: {
    fontVariant: ['tabular-nums'],
    ...theme.font.bodyStrong,
    color: theme.color.textMuted,
    flexShrink: 1,
  },
  rowNameLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: theme.space(1),
  },
  rowName: { ...theme.font.heading, color: theme.color.text, flexShrink: 1 },
  allergyDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.color.danger },
  rowMeta: { ...theme.font.small, color: theme.color.textMuted, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(4) },
  grow: { flex: 1 },
});
