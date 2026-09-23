import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, relativeAge } from '@/lib/format';
import { AppHeader, Card, ErrorBanner, Screen } from '@/components/ui';
import type { DispenseQueueItem, PharmacyDashboard } from '@/lib/types';
import { useMoney } from '@/lib/use-money';

/**
 * Who is waiting to be handed medicine.
 *
 * THIS SCREEN USED TO DO TWO JOBS AND SAY NO TO BOTH
 * --------------------------------------------------
 * It carried the queue *and* the stock summary, so reading it meant first
 * working out which half you were looking at — and it ended in a line saying
 * dispensing happens on the web app. A list of work that refuses the work is
 * worse than no list: it is a screen whose only function is to send you
 * somewhere else.
 *
 * Stock is now its own tab, and a row here opens the dispense screen. The two
 * halves answered questions asked at different moments — "who is waiting" with
 * somebody at the counter, "what is running out" with the shelf in front of
 * you — which is what made one screen holding both hard to read.
 */
export default function PharmacyScreen() {
  const [queue, setQueue] = useState<DispenseQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  /*
   * Today's takings, above the queue.
   *
   * A pharmacist checking what the counter has taken is a phone question —
   * they are standing at the till, not at a desk. Only today is shown here;
   * the week and month comparison is a reconciliation task and stays on the
   * web, where the three windows fit side by side and can be read against each
   * other rather than scrolled between.
   */
  const [figures, setFigures] = useState<PharmacyDashboard | null>(null);
  const money = useMoney();

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = await api<{ data: DispenseQueueItem[] }>('/pharmacy/queue');
      setQueue(q.data);
      setFetchedAt(new Date());

      // Fails quietly: the queue is the job, and a missing figure must not
      // stop a pharmacist seeing who is waiting.
      api<PharmacyDashboard>('/pharmacy/dashboard')
        .then(setFigures)
        .catch(() => setFigures(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the dispensing queue');
    }
  }, []);

  // Refetches on focus and every 15s, so the queue length is worth walking on.
  useLiveData(load);

  return (
    <Screen>
      {/* Was a literal `{relativeAge(fetchedAt)}` inside quotes — a template
          that never interpolated, so the subtitle printed its own source. */}
      <AppHeader
        title="Dispense"
        subtitle={
          queue === null
            ? `Updated ${relativeAge(fetchedAt)}`
            : `${queue.length} waiting · ${relativeAge(fetchedAt)}`
        }
      />

      {error && <ErrorBanner message={error} />}

      <FlatList
        ListHeaderComponent={
          figures ? (
            <TodayCard figures={figures} money={money} />
          ) : null
        }
        data={queue ?? []}
        keyExtractor={(item) => String(item.id)}
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
          /* Distinguishes "nothing waiting" from "not loaded yet". They look
             identical as an empty list, and only one of them means go home. */
          <Text style={s.empty}>
            {queue === null ? 'Loading…' : 'Nothing waiting to be dispensed.'}
          </Text>
        }
        renderItem={({ item }) => (
          /* The row is the way in. */
          <Pressable
            onPress={() => router.push(`/dispense/${item.id}`)}
            style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
          >
            <Card>
              <View style={s.rowTop}>
                <Text style={s.rxId}>#{item.id}</Text>
                <Text style={s.muted}>{date(item.issuedAt)}</Text>
              </View>
              <View style={s.nameLine}>
                <Text style={s.name}>{item.patient.fullName}</Text>
                {item.patient.hasAllergies && <View style={s.allergyDot} />}
              </View>
              <Text style={s.muted}>
                {item.itemCount} item{item.itemCount === 1 ? '' : 's'}
                {item.doctor ? ` · ${item.doctor}` : ''}
              </Text>
              {item.hasUncataloguedItem && (
                <Text style={s.warn}>An item needs mapping to the catalogue before dispensing</Text>
              )}
              <Text style={s.open}>Dispense ›</Text>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  today: { marginBottom: theme.space(2) },
  todayLabel: { ...theme.font.caption, color: theme.color.textSubtle, letterSpacing: 1 },
  todayNet: { ...theme.font.title, fontSize: 26, color: theme.color.text },
  todayHint: { ...theme.font.caption, color: theme.color.textSubtle },
  todayRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: theme.space(1),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    paddingTop: theme.space(1),
  },
  todayMuted: { ...theme.font.caption, color: theme.color.textMuted },
  todayBad: { ...theme.font.caption, color: theme.color.danger, marginTop: 2 },
  todayWarn: { ...theme.font.caption, color: theme.color.warning, marginTop: 2 },
  list: { padding: theme.space(3) },
  muted: { ...theme.font.small, color: theme.color.textMuted },
  empty: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(6),
  },
  open: { ...theme.font.caption, color: theme.color.text, fontWeight: '700', marginTop: theme.space(1) },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rxId: { ...theme.font.small, color: theme.color.textMuted, letterSpacing: 0.5 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  name: { ...theme.font.heading, color: theme.color.text, flexShrink: 1 },
  allergyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.danger },
  warn: { ...theme.font.caption, color: theme.color.warning, fontWeight: '600', marginTop: 4 },
});


/**
 * Today's counter, in one card.
 *
 * Net is the headline because it is the figure billing and the owner both see;
 * billed and refunded sit under it so the two can be reconciled rather than
 * taken on trust. "Handed over unpriced" is here because it is the number
 * nothing else surfaces daily — a handover with no price still leaves the
 * shelf, and the loss is otherwise found a month later in a report.
 */
function TodayCard({
  figures,
  money,
}: {
  figures: PharmacyDashboard;
  money: (amount: string) => string;
}) {
  const today = figures.periods.find((p) => p.period === 'today');
  if (!today) return null;

  return (
    <Card style={s.today}>
      <Text style={s.todayLabel}>TODAY</Text>
      <Text style={s.todayNet}>{money(today.net)}</Text>
      <Text style={s.todayHint}>collected, net of refunds</Text>

      <View style={s.todayRow}>
        <Text style={s.todayMuted}>{today.sales} sales</Text>
        <Text style={s.todayMuted}>billed {money(today.billed)}</Text>
      </View>

      {Number(today.refunded) > 0 && (
        <Text style={s.todayBad}>refunded {money(today.refunded)}</Text>
      )}
      {today.reversals > 0 && (
        // Counted apart from sales: a reversal means the medicine never left.
        <Text style={s.todayBad}>{today.reversals} reversed</Text>
      )}
      {today.unpricedSales > 0 && (
        <Text style={s.todayWarn}>
          {today.unpricedSales} handed over with no price — nothing was charged
        </Text>
      )}
      {Number(figures.outstanding) > 0 && (
        <Text style={s.todayWarn}>{money(figures.outstanding)} unpaid at this counter</Text>
      )}
    </Card>
  );
}
