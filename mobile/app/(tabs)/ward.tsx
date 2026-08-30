import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { useOutbox } from '@/lib/outbox-context';
import { theme } from '@/lib/theme';
import { relativeAge, time } from '@/lib/format';
import { AppHeader, Card, ErrorBanner, Screen, StatusPill } from '@/components/ui';
import type { BedRow, Ward, WardBoard } from '@/lib/types';

/**
 * The nurse's landing screen: every bed, who is in it, what is outstanding.
 *
 * Sorted by urgency, not by bed number. A nurse opening this at the start of a
 * shift is asking "what needs doing", and a ward laid out A-01 to A-12 buries
 * the overdue patient in the middle of the list.
 */
export default function WardScreen() {
  const [wards, setWards] = useState<Ward[]>([]);
  const [wardId, setWardId] = useState<number | null>(null);
  const [board, setBoard] = useState<WardBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
  const { pending } = useOutbox();

  useEffect(() => {
    api<Ward[]>('/wards')
      .then((w) => {
        setWards(w);
        setWardId((prev) => prev ?? w[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load wards'));
  }, []);

  const load = useCallback(async () => {
    if (!wardId) return;
    setError(null);
    try {
      setBoard(await api<WardBoard>(`/wards/${wardId}/board`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the ward board');
    }
  }, [wardId]);

  // Refetches on focus and every 15s. Admissions, transfers and discharges
  // happen while a nurse is looking at another screen.
  useLiveData(load);

  const rows = [...(board?.beds ?? [])].sort(byUrgency);

  return (
    <Screen>
      <AppHeader
        title={board?.ward.name ?? 'Ward'}
        subtitle={board ? `${board.stats.occupied} of ${board.stats.beds} beds occupied` : undefined}
      />
      <View style={s.pickerBar}>
        <View style={s.wardTabs}>
          {wards.map((w) => (
            <Pressable
              key={w.id}
              onPress={() => setWardId(w.id)}
              style={[s.wardTab, w.id === wardId && s.wardTabActive]}
            >
              <Text style={[s.wardTabText, w.id === wardId && s.wardTabTextActive]}>
                {w.name.split('—')[0].trim()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {pending > 0 && (
        <View style={s.syncBar}>
          <Text style={s.syncText}>{pending} record{pending === 1 ? '' : 's'} waiting to sync</Text>
        </View>
      )}

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.bed.id)}
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
          board ? (
            <View style={s.stats}>
              <Stat label="Occupied" value={board.stats.occupied} />
              <Stat label="Free" value={board.stats.available} tone={theme.color.success} />
              <Stat
                label="Obs due"
                value={board.stats.observationsOverdue}
                tone={theme.color.danger}
              />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <BedCard
            row={item}
            onRecord={() =>
              item.admission &&
              router.push({
                pathname: '/(tabs)/vitals',
                params: {
                  patientId: String(item.admission.patient.id),
                  patientName: item.admission.patient.fullName,
                },
              })
            }
          />
        )}
      />
    </Screen>
  );
}

/** Observations overdue first, then occupied, then empty beds. */
function byUrgency(a: BedRow, b: BedRow): number {
  const rank = (r: BedRow) =>
    r.admission?.observationOverdue ? 0 : r.admission ? 1 : r.bed.isActive ? 2 : 3;
  const diff = rank(a) - rank(b);
  return diff !== 0 ? diff : a.bed.label.localeCompare(b.bed.label);
}

function BedCard({ row, onRecord }: { row: BedRow; onRecord: () => void }) {
  const { bed, admission } = row;

  if (!admission) {
    return (
      <Card style={{ opacity: 0.65 }}>
        <View style={s.rowTop}>
          <Text style={s.bedLabel}>{bed.label}</Text>
          <StatusPill
            label={bed.isActive ? 'Free' : 'Out of service'}
            bg="#eef0f2"
            fg={theme.color.textMuted}
          />
        </View>
      </Card>
    );
  }

  const overdue = admission.observationOverdue;

  return (
    <Pressable onPress={onRecord} accessibilityRole="button">
      {({ pressed }) => (
        <Card
          style={{
            opacity: pressed ? 0.75 : 1,
            borderLeftWidth: overdue ? 4 : 1,
            borderLeftColor: overdue ? theme.color.danger : theme.color.border,
          }}
        >
          <View style={s.rowTop}>
            <Text style={s.bedLabel}>{bed.label}</Text>
            {overdue ? (
              <StatusPill label="Obs due" bg={theme.color.dangerSoft} fg={theme.color.danger} />
            ) : (
              <StatusPill label="Stable" bg={theme.color.successSoft} fg={theme.color.success} />
            )}
          </View>

          <View style={s.nameLine}>
            <Text style={s.name}>{admission.patient.fullName}</Text>
            {admission.patient.hasAllergies && <View style={s.allergyDot} />}
          </View>
          <Text style={s.meta}>
            {admission.patient.age}y · {admission.patient.gender.toLowerCase()}
            {admission.reason ? ` · ${admission.reason}` : ''}
          </Text>

          <Text style={[s.meta, overdue && s.metaAlert]}>
            {admission.lastVital
              ? `Last obs ${relativeAge(new Date(admission.lastVital.recordedAt))}${
                  admission.lastVital.systolic
                    ? ` · ${admission.lastVital.systolic}/${admission.lastVital.diastolic}`
                    : ''
                }`
              : 'No observations recorded'}
          </Text>

          {admission.nextDose && (
            <Text style={s.meta}>
              Next dose {time(admission.nextDose.dueAt)} · {admission.nextDose.medicineName}
            </Text>
          )}
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
  pickerBar: { paddingHorizontal: theme.space(4), paddingTop: theme.space(4) },
  wardTabs: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(2) },
  wardTab: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
    borderRadius: 999,
    backgroundColor: theme.color.bg,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  wardTabActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primary },
  wardTabText: { ...theme.font.small, color: theme.color.textMuted },
  wardTabTextActive: { color: theme.color.primary, fontWeight: '700' },
  syncBar: { backgroundColor: theme.color.warningSoft, paddingVertical: 5 },
  syncText: { color: theme.color.warning, ...theme.font.caption, textAlign: 'center' },
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
  statValue: { ...theme.font.title, color: theme.color.text },
  statLabel: { ...theme.font.caption, color: theme.color.textMuted, textTransform: 'uppercase' },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space(2),
  },
  bedLabel: { ...theme.font.small, color: theme.color.textMuted, letterSpacing: 0.5 , flexShrink: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  name: { ...theme.font.heading, color: theme.color.text },
  allergyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.danger },
  meta: { ...theme.font.small, color: theme.color.textMuted, marginTop: 2 },
  metaAlert: { color: theme.color.danger, fontWeight: '600' },
});
