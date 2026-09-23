import { useCallback, useState } from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { InvoiceLedger } from '@/components/invoice-ledger';
import { api } from '@/lib/api';
import { theme } from '@/lib/theme';
import { useMoney } from '@/lib/use-money';
import { useLiveData } from '@/lib/use-live-data';
import { shareDocument } from '@/lib/documents';
import type { LabStatement, LabStatements } from '@/lib/types';
import { PeriodPicker, periodQuery, resolvedPeriod, type Period } from '@/components/period-picker';
import { AppHeader, Button, Card, EmptyState, ErrorBanner, Screen } from '@/components/ui';

/**
 * The laboratory's own till.
 *
 * Separate from the pharmacy's and from billing's because in SEPARATE mode
 * these are three businesses: the server scopes the list by role, so all three
 * screens return disjoint sets even though they render identically. A
 * technician never sees a consultation charge, and billing never sees a test.
 *
 * Which is not only about ledgers — a billing clerk opening a lab invoice sees
 * `LAB · Tests (2 items)` and a total, never the test names, because a test
 * name is frequently the clinical question itself.
 *
 * No voiding here. Cancelling a charge belongs with cancelling the order, where
 * "was any of this actually done" can be answered — the charge is voided only
 * while no sample has been taken, and refused once money has been paid.
 *
 * THE SECOND VIEW, AND WHY IT IS NOT A SECOND TAB
 * -----------------------------------------------
 * A reference laboratory raises an invoice per referral and then sends **one
 * statement a month**, which is what the referring hospital actually pays. That
 * is the same ledger asked a different question, so it sits behind a toggle on
 * this screen exactly as it sits behind a tab on the web one — a separate
 * destination would make them look like two sets of books.
 *
 * `InvoiceLedger` is shared with the pharmacy and with billing, so the
 * statement view is composed *around* it rather than added inside it: a month
 * of referred work is a laboratory question and neither of the other two has
 * one. The toggle itself goes **through** the ledger, as its `toolbar` — the
 * first version rendered it as a sibling, which put two buttons above the
 * screen's own header with nothing around them. Composing beside a component
 * that draws its own chrome puts you outside that chrome, which reads fine in
 * the source and is obvious on a phone.
 */
type TillView = 'invoices' | 'statements';

export default function LabTillScreen() {
  /*
   * `?invoice=` opens that invoice's payment form on arrival.
   *
   * Accepting a referral hands straight over to it, exactly as dispensing does:
   * the charge was raised a second ago and somebody has to collect it. An
   * invoice that appears silently in a list is one nobody is sure was raised,
   * and the person who would have taken the money has already moved on.
   */
  const { invoice } = useLocalSearchParams<{ invoice?: string }>();
  const openInvoiceId = invoice ? Number(invoice) : null;

  /*
   * Arriving with `?invoice=` means somebody has just been handed a charge to
   * collect, so the toggle starts on the ledger regardless — dropping them on a
   * month's statements would bury the one row they were sent here for.
   */
  const [view, setView] = useState<TillView>('invoices');

  if (view === 'invoices') {
    return (
      <InvoiceLedger
        basePath="/lab"
        title="Lab invoices"
        emptyBody="Charges appear here as soon as a doctor requests a test. Tests with no price raise no charge — check the catalogue if you expected one."
        openInvoiceId={Number.isFinite(openInvoiceId) ? openInvoiceId : null}
        /*
         * Handed to the ledger rather than rendered beside it. Placed beside it
         * first, which put two buttons *above* the screen's own `AppHeader`,
         * floating over the title — reported from use, and the sort of thing
         * only a device shows you.
         */
        toolbar={<ViewToggle view={view} onChange={setView} />}
      />
    );
  }

  return <Statements onBack={() => setView('invoices')} />;
}

function ViewToggle({ view, onChange }: { view: TillView; onChange: (v: TillView) => void }) {
  return (
    <View style={s.toggle}>
      <Button
        label="Invoices"
        size="sm"
        variant={view === 'invoices' ? 'primary' : 'secondary'}
        onPress={() => onChange('invoices')}
      />
      <Button
        label="Statements"
        size="sm"
        variant={view === 'statements' ? 'primary' : 'secondary'}
        onPress={() => onChange('statements')}
      />
    </View>
  );
}

/**
 * A month of referred work, one row per hospital.
 *
 * NO TEST NAMES, AND THAT IS THE SHARPEST RULE ON THIS SCREEN. A count and the
 * money. This is the view somebody shares as a PDF to another company where a
 * finance clerk opens it, and a test name is frequently the clinical question
 * itself — the rule `labSummaryDescription` follows on an invoice line, applied
 * where it matters most.
 *
 * The period is a **range**, and the presets are the cadences referral
 * agreements actually use — weekly, ten-daily, fortnightly, monthly. Arbitrary
 * dates stay on the web: two date pickers on a small screen is where an
 * off-by-one boundary comes from, and a boundary error on a statement is money
 * billed twice or not at all.
 */
function Statements({ onBack }: { onBack: () => void }) {
  const money = useMoney();
  const [payload, setPayload] = useState<LabStatements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  /**
   * The lines behind one hospital's month, read before it is sent.
   *
   * Fetched on demand rather than with the summary: a laboratory with thirty
   * partners would otherwise pull every referral of the month to draw thirty
   * cards. It also answers the question the summary cannot — *is this right* —
   * and sending a statement nobody checked is worse than sending none.
   */
  const [detail, setDetail] = useState<LabStatement | null>(null);
  const [detailFor, setDetailFor] = useState<number | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPayload(await api<LabStatements>(`/lab/statements${periodQuery(period)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load statements');
    }
  }, [period]);

  useLiveData(load);

  async function toggleLines(sourceTenantId: number, forPeriod: Period | null) {
    if (detailFor === sourceTenantId) {
      setDetailFor(null);
      setDetail(null);
      return;
    }
    setDetailFor(sourceTenantId);
    setDetail(null);
    try {
      setDetail(
        /*
         * Both branches written out, because `endpoint-coverage.spec.ts` reads
         * the literal at the call site and two adjacent interpolations collapse
         * into `/lab/statements/` with no parameter — the route then reads as
         * having no caller and as being one nothing declares. The same reason
         * `documents.ts` carries one literal per document.
         */
        forPeriod
          ? await api<LabStatement>(
              `/lab/statements/${sourceTenantId}?from=${encodeURIComponent(
                forPeriod.from,
              )}&to=${encodeURIComponent(forPeriod.to)}`,
            )
          : await api<LabStatement>(`/lab/statements/${sourceTenantId}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that statement');
      setDetailFor(null);
    }
  }

  async function send(sourceTenantId: number, forPeriod: Period) {
    setBusy(sourceTenantId);
    setError(null);
    try {
      await shareDocument('lab-statements', sourceTenantId, forPeriod);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not produce that statement');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      <AppHeader
        title="Statements"
        subtitle={
          payload === null
            ? 'Loading…'
            : `${payload.label} · ${money(payload.outstanding)} outstanding of ${money(
                payload.total,
              )}`
        }
      />

      {/*
        The same control, not a second copy of it. Written out by hand here
        first, which is how the two halves of one toggle come to sit a few
        pixels apart and highlight differently — `ViewToggle` is one component
        for the same reason `matchReferralItems` is one function.
      */}
      <ViewToggle view="statements" onChange={(next) => next === 'invoices' && onBack()} />

      {/*
        A period, not a month. The presets are the cadences referral agreements
        are actually written on; the label above is the server's own words for
        whichever was picked.
      */}
      <PeriodPicker value={period} onChange={setPeriod} />

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={payload?.data ?? []}
        keyExtractor={(row) => String(row.sourceTenantId)}
        contentContainerStyle={s.list}
        ListEmptyComponent={
          payload === null ? null : (
            <EmptyState
              glyph="⇆"
              title={`Nothing referred in ${payload.label}`}
              body="A statement appears for every hospital that sent us work we agreed to invoice them for. Work a patient paid for at this counter is not on one — they settled it themselves."
            />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <View style={s.row}>
              <View style={s.grow}>
                <Text style={s.name}>{item.hospital}</Text>
                {/* A count of tests, never their names — this page gets sent. */}
                <Text style={s.muted}>
                  {item.referrals} {item.referrals === 1 ? 'referral' : 'referrals'} ·{' '}
                  {item.tests} {item.tests === 1 ? 'test' : 'tests'}
                </Text>
              </View>
              <View>
                <Text style={s.amount}>{money(item.total)}</Text>
                {item.settled ? (
                  <Text style={s.settled}>settled</Text>
                ) : (
                  <Text style={s.due}>{money(item.outstanding)} due</Text>
                )}
              </View>
            </View>

            <View style={s.actions}>
              <Button
                label={detailFor === item.sourceTenantId ? 'Hide lines' : 'Check lines'}
                variant="ghost"
                size="sm"
                onPress={() => void toggleLines(item.sourceTenantId, resolvedPeriod(payload!))}
              />
              <Button
                label="Send statement"
                variant="secondary"
                busy={busy === item.sourceTenantId}
                onPress={() => void send(item.sourceTenantId, resolvedPeriod(payload!))}
              />
            </View>

            {detailFor === item.sourceTenantId && (
              <View style={s.lines}>
                {!detail ? (
                  <Text style={s.muted}>Reading the period…</Text>
                ) : (
                  detail.lines.map((l) => (
                    <View key={l.invoiceId} style={s.line}>
                      {/* Theirs first: it is the only number the recipient can
                          match to anything of their own. */}
                      <Text style={s.lineRef}>{l.sourceAccession ?? '—'}</Text>
                      <Text style={s.muted}>
                        {l.tests} {l.tests === 1 ? 'test' : 'tests'}
                      </Text>
                      <Text style={s.lineAmount}>{money(l.amount)}</Text>
                    </View>
                  ))
                )}
              </View>
            )}
          </Card>
        )}
        ListFooterComponent={
          payload && payload.data.length > 0 ? (
            <Text style={s.footnote}>
              Sending does not notify them through this system. They see each charge as a notice
              when we accept the work; this is the month gathered into one document, and each side
              records its own settlement.
            </Text>
          ) : null
        }
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  toggle: {
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
  amount: { ...theme.font.body, fontWeight: '700', color: theme.color.text, textAlign: 'right' },
  settled: { ...theme.font.caption, color: theme.color.success, textAlign: 'right' },
  due: { ...theme.font.caption, color: theme.color.warning, textAlign: 'right' },
  footnote: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: theme.space(2) },
  actions: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(2) },
  lines: {
    marginTop: theme.space(2),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    paddingTop: theme.space(1.5),
    gap: theme.space(1),
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.space(2) },
  lineRef: {
    ...theme.font.caption,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    color: theme.color.text,
    flex: 1,
  },
  lineAmount: { ...theme.font.caption, fontWeight: '700', color: theme.color.text },
});
