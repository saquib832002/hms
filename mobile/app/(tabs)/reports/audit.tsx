import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, time } from '@/lib/format';
import { AppHeader, Card, EmptyState, ErrorBanner, Screen } from '@/components/ui';
import type { AuditRow } from '@/lib/types';

/**
 * Who did what, and who was refused.
 *
 * WHY IT IS HERE AT ALL, GIVEN IT IS A DESK JOB
 * ---------------------------------------------
 * The full audit browser genuinely belongs on the web: it is scanning and
 * filtering across dates, users and actions, which a phone is worst at, and
 * that is why it stays there.
 *
 * What is on the phone is the question an administrator asks *away* from the
 * desk and cannot currently answer at all: **has anything been refused today**.
 * A spike in denials is either a misconfigured client or somebody probing, and
 * it is the one line on the dashboard that says "look at the audit log" while
 * the app offered no audit log to look at.
 *
 * So: the most recent entries, with failures first-class rather than filtered
 * out. Deliberately not a search — a filter box on a list this dense invites
 * treating a phone as the investigation tool, and it is not.
 */
type Filter = 'denied' | 'all';
const FILTERS: Filter[] = ['denied', 'all'];

export default function AuditScreen() {
  const [filter, setFilter] = useState<Filter>('denied');
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      /*
       * Denials first by default. "Nothing was refused today" is a useful
       * answer and takes one glance; the whole stream is thousands of rows of
       * ordinary work that nobody reads on a phone.
       */
      const qs = filter === 'denied' ? 'outcome=FAILURE&limit=50' : 'limit=50';
      const res = await api<{ data: AuditRow[] }>(`/audit?${qs}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the audit log');
    }
  }, [filter]);

  useLiveData(load);

  return (
    <Screen>
      <AppHeader
        title="Audit log"
        subtitle={
          rows === null
            ? 'Loading…'
            : filter === 'denied'
              ? `${rows.length} refused, most recent first`
              : `${rows.length} most recent`
        }
      />

      <View style={s.segments}>
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => {
              setRows(null);
              setFilter(f);
            }}
            style={[s.segment, filter === f && s.segmentOn]}
          >
            <Text style={[s.segmentText, filter === f && s.segmentTextOn]}>
              {f === 'denied' ? 'Refused' : 'Everything'}
            </Text>
          </Pressable>
        ))}
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => String(r.id)}
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          rows === null ? null : (
            <EmptyState
              glyph="⌾"
              title={filter === 'denied' ? 'Nothing was refused' : 'Nothing recorded yet'}
              body={
                filter === 'denied'
                  ? 'No request has been denied recently. That is the answer you wanted.'
                  : 'Activity appears here as staff use the system.'
              }
            />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <View style={s.row}>
              <Text style={item.outcome === 'FAILURE' ? s.denied : s.action}>{item.action}</Text>
              <Text style={s.when}>{date(item.createdAt)} {time(item.createdAt)}</Text>
            </View>
            <Text style={s.muted}>
              {item.user?.fullName ?? item.actorEmail ?? 'Not signed in'}
              {/* The role worn at the time, not the one they hold now — that is
                  the whole point of recording it per action. */}
              {item.actorRole ? ` · acting as ${item.actorRole.toLowerCase()}` : ''}
            </Text>
            {item.targetType && (
              <Text style={s.muted}>
                {item.targetType} #{item.targetId ?? '—'}
              </Text>
            )}
          </Card>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  segments: { flexDirection: 'row', gap: theme.space(2), padding: theme.space(4), paddingBottom: 0 },
  segment: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  segmentOn: { borderColor: theme.color.primary, backgroundColor: theme.color.surface },
  segmentText: { ...theme.font.caption, color: theme.color.textMuted },
  segmentTextOn: { color: theme.color.text, fontWeight: '700' },
  list: { padding: theme.space(4), gap: theme.space(3) },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space(2) },
  action: { ...theme.font.body, fontWeight: '700', color: theme.color.text, flex: 1 },
  denied: { ...theme.font.body, fontWeight: '700', color: theme.color.danger, flex: 1 },
  when: { ...theme.font.caption, color: theme.color.textSubtle },
  muted: { ...theme.font.caption, color: theme.color.textMuted, marginTop: 2 },
});
