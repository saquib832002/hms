import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { theme } from '@/lib/theme';
import { relativeAge } from '@/lib/format';
import { Card, ErrorBanner } from '@/components/ui';
import type { AdminDashboard } from '@/lib/types';
import { useMoney } from '@/lib/use-money';

/**
 * Administrator overview — read-only aggregates.
 *
 * Nothing on this screen identifies a patient, and there is nowhere to tap
 * through to one. That is not an oversight: `CLAUDE.md` puts ADMIN outside
 * clinical access, and a phone that could reach a patient record from a
 * management summary would quietly undo that.
 *
 * No write actions either. Creating staff accounts and voiding invoices are
 * decisions that deserve a desk, a keyboard and a moment's thought.
 */
export default function OverviewScreen() {
  const fmt = useMoney();
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDashboard(await api<AdminDashboard>('/admin/dashboard'));
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the overview');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Overview</Text>
        <Text style={s.muted}>Updated {relativeAge(fetchedAt)}</Text>
      </View>

      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
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
      >
        {dashboard && (
          <>
            <Text style={s.group}>Today</Text>
            <View style={s.row}>
              <Metric label="Appointments" value={dashboard.appointments.today} />
              <Metric label="Completed" value={dashboard.appointments.completedToday} tone={theme.color.success} />
            </View>

            <Text style={s.group}>Occupancy</Text>
            <Card>
              <Text
                style={[
                  s.big,
                  dashboard.occupancy.percent > 90 ? { color: theme.color.danger } : null,
                ]}
              >
                {dashboard.occupancy.percent}%
              </Text>
              <Text style={s.muted}>
                {dashboard.occupancy.occupied} of {dashboard.occupancy.beds} beds ·{' '}
                {dashboard.occupancy.available} free
              </Text>
            </Card>

            <Text style={s.group}>Finance</Text>
            <Card>
              <Text style={s.muted}>Outstanding</Text>
              {/* The hospital's own currency, not a hard-coded £. */}
              <Text style={s.big}>{fmt(dashboard.finance.outstanding)}</Text>
              <Text style={s.muted}>
                {dashboard.finance.openInvoices} open ·{' '}
                {fmt(dashboard.finance.collectedLastSevenDays)} collected in 7 days
              </Text>
            </Card>

            <Text style={s.group}>Staff and access</Text>
            <View style={s.row}>
              <Metric label="Active" value={dashboard.staff.active} />
              <Metric
                label="Locked out"
                value={dashboard.staff.lockedOut}
                tone={dashboard.staff.lockedOut > 0 ? theme.color.warning : undefined}
              />
              <Metric
                label="Denied 24h"
                value={dashboard.security.deniedRequestsLastDay}
                tone={dashboard.security.deniedRequestsLastDay > 20 ? theme.color.danger : undefined}
              />
            </View>

            <Text style={s.footnote}>
              Aggregates only. Staff management, invoices and the audit log are on the web app.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <View style={s.metric}>
      <Text style={[s.metricValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
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
  body: { padding: theme.space(3) },
  group: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
  row: { flexDirection: 'row', gap: theme.space(2) },
  metric: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingVertical: theme.space(3),
    alignItems: 'center',
  },
  metricValue: { fontSize: 22, fontWeight: '800', color: theme.color.text },
  metricLabel: { fontSize: 11, color: theme.color.textMuted, textTransform: 'uppercase' },
  big: { fontSize: 30, fontWeight: '800', color: theme.color.text, letterSpacing: -0.5 },
  footnote: {
    fontSize: 12,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(5),
    lineHeight: 17,
  },
});
