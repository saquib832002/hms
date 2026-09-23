import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date } from '@/lib/format';
import { useMoney } from '@/lib/use-money';
import type { PartnerLabStatements } from '@/lib/types';
import { PeriodPicker, periodQuery, type Period } from '@/components/period-picker';
import { AppHeader, Button, Card, EmptyState, ErrorBanner, Screen } from '@/components/ui';

/**
 * What this hospital owes the laboratories it sends work to.
 *
 * WHY THIS IS ON THE PHONE
 * ------------------------
 * The web version is where somebody reconciles a statement at a desk. This one
 * answers a different question, and it is the one an owner actually asks:
 * *how much do we owe them right now*, standing in front of the person from
 * the laboratory, or on the telephone to them.
 *
 * Marking a bill settled is one tap and is reversible, which puts it on the
 * same line as a doctor's consultation fee and the clinic's currency — the
 * three mobile admin writes that exist because they block somebody else's work
 * or answer somebody standing there. Nothing here creates a record that cannot
 * be undone.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not accounts payable, and no money moves through it. The laboratory's own
 * invoice is the record; this is their notice of it, written into our scope
 * when they accepted the work.
 */
interface Charge {
  id: number;
  partnerName: string;
  reference: string;
  sourceAccession: string | null;
  amount: string;
  testCount: number;
  incurredAt: string;
  settledAt: string | null;
  settledBy: string | null;
  settledNote: string | null;
}

interface Payload {
  data: Charge[];
  outstandingCount: number;
  outstandingTotal: string;
}

type Tab = 'outstanding' | 'settled' | 'all' | 'statements';

export default function LabChargesScreen() {
  const money = useMoney();
  const [tab, setTab] = useState<Tab>('outstanding');
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * The same charges, grouped into the month the laboratory bills as one.
   *
   * A reference laboratory raises an invoice per referral and then posts one
   * statement a month. What arrives is that piece of paper; what this screen
   * held was forty separate notices, so checking one against the other meant
   * adding a column of figures up by eye — which is how a hospital comes to pay
   * a statement it never actually reconciled.
   *
   * The presets are the cadences referral agreements are actually written on.
   * Arbitrary dates stay on the web: two date pickers on a small screen is
   * where an off-by-one boundary comes from, and a boundary error here is a
   * month marked settled that the statement never covered.
   */
  const [statements, setStatements] = useState<PartnerLabStatements | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === 'statements') {
        setStatements(
          await api<PartnerLabStatements>(`/lab-partners/statements${periodQuery(period)}`),
        );
        return;
      }
      setPayload(await api<Payload>(`/lab-partners/charges?status=${tab}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load partner lab bills');
    }
  }, [tab, period]);

  useLiveData(load);

  /**
   * Mark a whole month dealt with, in one tap.
   *
   * Ticking forty rows on a phone realistically ends at thirty-nine — a month
   * reading as part-settled when the transfer covered all of it. Every row is
   * still written individually underneath, so the per-row Undo keeps working.
   *
   * Still not a payment: no money moves between two companies here and no
   * `Payment` row is written, because takings are counted from that table.
   */
  async function settleMonth(s: PartnerLabStatements['data'][number], settled: boolean) {
    setBusyId(s.partnerTenantId);
    setError(null);
    try {
      await api(`/lab-partners/statements/${s.partnerTenantId}/settle`, {
        method: 'POST',
        body: { from: statements?.from, to: statements?.to, settled },
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update that month');
    } finally {
      setBusyId(null);
    }
  }

  function confirmSettleMonth(s: PartnerLabStatements['data'][number]) {
    Alert.alert(
      `Mark ${statements?.label ?? 'this month'} settled?`,
      `${s.partnerName} — ${s.referrals} ${
        s.referrals === 1 ? 'referral' : 'referrals'
      }, ${money(s.outstanding)} outstanding.\n\nThis records that the month has been dealt with — no money moves here, and you can undo it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark settled', onPress: () => void settleMonth(s, true) },
      ],
    );
  }

  async function settle(c: Charge, settled: boolean) {
    setBusyId(c.id);
    setError(null);
    try {
      await api(`/lab-partners/charges/${c.id}/settle`, {
        method: 'POST',
        body: { settled },
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update that bill');
    } finally {
      setBusyId(null);
    }
  }

  function confirmSettle(c: Charge) {
    Alert.alert(
      `Mark ${money(c.amount)} settled?`,
      `${c.partnerName}, reference ${c.reference}.\n\nThis records that it has been dealt with — no money moves here, and you can undo it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark settled', onPress: () => void settle(c, true) },
      ],
    );
  }

  return (
    <Screen>
      <AppHeader
        title="Partner lab bills"
        subtitle={
          tab === 'statements'
            ? statements === null
              ? 'Loading…'
              : `${statements.label} · ${money(statements.outstanding)} outstanding of ${money(
                  statements.total,
                )}`
            : payload === null
              ? 'Loading…'
              : /*
                 * The total is always over the outstanding rows, whichever tab is
                 * showing. A figure that changes meaning when you switch tab is
                 * worse than none, and this is the one number people open the
                 * screen for.
                 */
                `${money(payload.outstandingTotal)} outstanding · ${payload.outstandingCount} ${
                  payload.outstandingCount === 1 ? 'bill' : 'bills'
                }`
        }
      />

      {/*
        Segmented rather than filtered to the open items. Fifth time in this
        codebase: "did we ever pay them for that" is asked precisely once an
        outstanding-only list would have dropped the row.
      */}
      <View style={s.tabs}>
        {(['outstanding', 'settled', 'all', 'statements'] as Tab[]).map((t) => (
          <Button
            key={t}
            /* "By month" rather than "Statements": what the hospital is holding
               is the laboratory's statement, and this is our own records
               arranged to be checked against it. */
            label={t === 'statements' ? 'By month' : t[0].toUpperCase() + t.slice(1)}
            size="sm"
            variant={tab === t ? 'primary' : 'secondary'}
            onPress={() => {
              setTab(t);
              setPayload(null);
              setStatements(null);
            }}
          />
        ))}
      </View>

      {error && <ErrorBanner message={error} />}

      {/*
        A month per partner, so the statement that arrived can be held against
        our own records rather than taken on trust. Two independently-kept sets
        of rows agreeing is the whole value of the notice.
      */}
      {tab === 'statements' && <PeriodPicker value={period} onChange={setPeriod} />}

      {tab === 'statements' && (
        <FlatList
          data={statements?.data ?? []}
          keyExtractor={(row) => String(row.partnerTenantId)}
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
            statements === null ? null : (
              <EmptyState
                glyph="⇆"
                title={`Nothing billed to us in ${statements.label}`}
                body="A month appears once a partner laboratory has accepted work we agreed to pay for. Tests a patient paid for at the laboratory's own counter are not on one."
              />
            )
          }
          renderItem={({ item }) => (
            <Card>
              <View style={s.row}>
                <View style={s.grow}>
                  <Text style={s.name}>{item.partnerName}</Text>
                  <Text style={s.muted}>
                    {item.referrals} {item.referrals === 1 ? 'referral' : 'referrals'} ·{' '}
                    {item.tests} {item.tests === 1 ? 'test' : 'tests'} ·{' '}
                    {statements?.label ?? ''}
                  </Text>
                </View>
                <Text style={s.amount}>{money(item.total)}</Text>
              </View>

              {item.settled ? (
                <View style={s.settledRow}>
                  <Text style={s.settled}>Whole month marked settled</Text>
                  <Button
                    label="Undo"
                    variant="ghost"
                    size="sm"
                    busy={busyId === item.partnerTenantId}
                    onPress={() => void settleMonth(item, false)}
                  />
                </View>
              ) : (
                <Button
                  label={`Mark ${money(item.outstanding)} settled`}
                  variant="secondary"
                  busy={busyId === item.partnerTenantId}
                  onPress={() => confirmSettleMonth(item)}
                />
              )}
            </Card>
          )}
          ListFooterComponent={
            statements && statements.data.length > 0 ? (
              <Text style={s.footnote}>
                No money moves through this screen. The laboratory&rsquo;s own invoices are the
                record; marking a month settled notes that it has been dealt with, and can be
                undone.
              </Text>
            ) : null
          }
        />
      )}

      {tab !== 'statements' && (
      <FlatList
        data={payload?.data ?? []}
        keyExtractor={(c) => String(c.id)}
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
          payload === null ? null : (
            <EmptyState
              glyph="⇆"
              title={tab === 'outstanding' ? 'Nothing outstanding' : 'Nothing here'}
              body={
                tab === 'outstanding'
                  ? 'A bill appears when a partner laboratory accepts work we agreed to pay for.'
                  : 'Bills you have marked settled will show here.'
              }
            />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <View style={s.row}>
              <View style={s.grow}>
                <Text style={s.name}>{item.partnerName}</Text>
                {/*
                  Our own order number first — it is what makes this row
                  auditable rather than just a figure, because "what is this
                  charge for" is then answered from our records instead of by
                  ringing the laboratory. The six-character reference is what
                  both sides say out loud on the telephone.
                */}
                <Text style={s.muted}>
                  {item.sourceAccession ? `${item.sourceAccession} · ` : ''}
                  {item.reference} · {item.testCount}{' '}
                  {item.testCount === 1 ? 'test' : 'tests'} · {date(item.incurredAt)}
                </Text>
              </View>
              <Text style={s.amount}>{money(item.amount)}</Text>
            </View>

            {item.settledAt ? (
              <View style={s.settledRow}>
                <Text style={s.settled}>
                  Settled {date(item.settledAt)}
                  {item.settledBy ? ` by ${item.settledBy}` : ''}
                  {item.settledNote ? ` — ${item.settledNote}` : ''}
                </Text>
                <Button
                  label="Undo"
                  variant="ghost"
                  size="sm"
                  busy={busyId === item.id}
                  onPress={() => void settle(item, false)}
                />
              </View>
            ) : (
              <Button
                label="Mark settled"
                variant="secondary"
                busy={busyId === item.id}
                onPress={() => confirmSettle(item)}
              />
            )}
          </Card>
        )}
        ListFooterComponent={
          payload && payload.data.length > 0 ? (
            <Text style={s.footnote}>
              No money moves through this screen. The laboratory&rsquo;s own invoice is the record;
              marking a bill settled notes that it has been dealt with, and can be undone.
            </Text>
          ) : null
        }
      />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: theme.space(2),
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
  },
  list: { padding: theme.space(4), gap: theme.space(3) },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space(2) },
  grow: { flex: 1 },
  name: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  amount: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  settledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    marginTop: theme.space(2),
  },
  settled: { ...theme.font.caption, color: theme.color.textMuted, flex: 1 },
  footnote: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: theme.space(2) },
});
