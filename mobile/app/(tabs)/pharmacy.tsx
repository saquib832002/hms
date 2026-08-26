import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { theme } from '@/lib/theme';
import { date, relativeAge } from '@/lib/format';
import { Card, ErrorBanner, StatusPill } from '@/components/ui';
import type { DispenseQueueItem, Inventory } from '@/lib/types';

/**
 * Pharmacist mobile view — read-only, on purpose.
 *
 * Dispensing is not here. It requires the physical stock in front of you, a
 * batch number to read off a box, and a signature that decrements inventory.
 * A phone in a corridor has none of those, and a "dispense" button that can be
 * pressed away from the shelf is an invitation to sign for something not yet
 * done.
 *
 * What a phone is genuinely good for: knowing how long the queue is before
 * walking back, and knowing what has run out.
 */
export default function PharmacyScreen() {
  const [queue, setQueue] = useState<DispenseQueueItem[] | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [q, inv] = await Promise.all([
        api<{ data: DispenseQueueItem[] }>('/pharmacy/queue'),
        api<Inventory>('/pharmacy/inventory'),
      ]);
      setQueue(q.data);
      setInventory(inv);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load pharmacy data');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only what needs attention — a full stock list is a desk screen.
  const lowStock = (inventory?.data ?? []).filter((r) => r.belowReorderLevel || r.inDateQuantity === 0);
  const expiring = (inventory?.data ?? []).filter((r) => r.expiringSoon.length > 0);

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Pharmacy</Text>
        <Text style={s.muted}>Updated {relativeAge(fetchedAt)}</Text>
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
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
        ListHeaderComponent={
          <>
            <View style={s.stats}>
              <Stat label="Waiting" value={queue?.length ?? 0} tone={theme.color.warning} />
              <Stat label="Low stock" value={lowStock.length} tone={theme.color.danger} />
              <Stat label="Expiring" value={expiring.length} tone={theme.color.warning} />
            </View>

            {lowStock.length > 0 && (
              <>
                <Text style={[s.group, { color: theme.color.danger }]}>Needs reordering</Text>
                {lowStock.slice(0, 8).map((m) => (
                  <Card key={m.id}>
                    <View style={s.rowTop}>
                      <Text style={s.name}>
                        {m.name} <Text style={s.muted}>{m.strength}</Text>
                      </Text>
                      <StatusPill
                        label={m.inDateQuantity === 0 ? 'Out' : `${m.inDateQuantity} left`}
                        bg={m.inDateQuantity === 0 ? theme.color.dangerSoft : theme.color.warningSoft}
                        fg={m.inDateQuantity === 0 ? theme.color.danger : theme.color.warning}
                      />
                    </View>
                    <Text style={s.muted}>Reorder at {m.reorderLevel}</Text>
                  </Card>
                ))}
              </>
            )}

            {expiring.length > 0 && (
              <>
                <Text style={[s.group, { color: theme.color.warning }]}>Expiring soon</Text>
                {expiring.slice(0, 8).map((m) => (
                  <Card key={m.id}>
                    <Text style={s.name}>
                      {m.name} <Text style={s.muted}>{m.strength}</Text>
                    </Text>
                    {m.expiringSoon.slice(0, 2).map((b) => (
                      <Text key={b.id} style={s.muted}>
                        Batch {b.batchNumber} · {b.quantity} units · expires {date(b.expiresAt)}
                      </Text>
                    ))}
                  </Card>
                ))}
              </>
            )}

            <Text style={s.group}>Dispensing queue</Text>
          </>
        }
        ListEmptyComponent={
          <Card>
            <Text style={s.muted}>Nothing waiting to dispense.</Text>
          </Card>
        }
        renderItem={({ item }) => (
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
          </Card>
        )}
        ListFooterComponent={
          <Text style={s.footnote}>
            Dispensing happens at the counter, on the web app — it needs the stock and the batch
            number in front of you.
          </Text>
        }
      />
    </SafeAreaView>
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
  title: { fontSize: 22, fontWeight: '800', color: theme.color.text },
  muted: { fontSize: 13, color: theme.color.textMuted },
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
  group: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rxId: { fontSize: 13, fontWeight: '800', color: theme.color.textMuted, letterSpacing: 0.5 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  name: { fontSize: 17, fontWeight: '700', color: theme.color.text },
  allergyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.danger },
  warn: { fontSize: 12, color: theme.color.warning, fontWeight: '600', marginTop: 4 },
  footnote: {
    fontSize: 12,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(5),
    lineHeight: 17,
  },
});
