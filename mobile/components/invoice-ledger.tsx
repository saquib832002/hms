import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, relativeAge } from '@/lib/format';
import { useMoney } from '@/lib/use-money';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
  StatusPill,
} from '@/components/ui';
import type { Invoice, PaymentMethod } from '@/lib/types';

/**
 * Billing on a phone: look up an invoice, take a payment. Nothing else.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Aging reports, reconciliation and bulk invoice entry stay on the web app.
 * That is the "task parity, not feature parity" rule from CLAUDE.md, and it
 * survives opening mobile to every role — a clerk working through 200 overdue
 * accounts wants a desk, two panels and a keyboard.
 *
 * Taking a payment is the opposite: it happens at the counter, or beside a
 * patient who is leaving, and a phone is the right tool.
 *
 * MONEY IS NEVER A NUMBER HERE
 * ----------------------------
 * Amounts arrive as strings and are sent back as strings. `outstanding` is
 * computed by the server precisely so this screen never has to subtract two
 * currency values — `parseFloat` on a payment amount is how pennies go missing
 * across thousands of rows.
 */

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'CARD', 'BANK_TRANSFER', 'INSURANCE'];

/**
 * Shared by the billing tab and the pharmacy till.
 *
 * WHY ONE COMPONENT AND TWO ROUTES
 * --------------------------------
 * The pharmacy bills on its own account in SEPARATE mode, so its invoices live
 * behind `/pharmacy/invoices` under `@Roles(PHARMACIST, ADMIN)` rather than
 * widening `/billing` — see `pharmacy-till.controller.ts` for why that boundary
 * was worth keeping. The *screen* is the same screen though: three segments,
 * take a payment, issue a refund. Copying 300 lines to change one string is how
 * the two drift, and the payment and refund flows here were each fixed twice
 * from user reports. Once is enough.
 */
export function InvoiceLedger({
  basePath,
  title,
  emptyBody,
  /**
   * Open this invoice's payment form as soon as the list loads.
   *
   * Dispensing hands straight over to it: the pharmacist has just given the
   * patient their medicine and is about to take the money from the person in
   * front of them, so making them find the row they created ten seconds ago
   * is navigation for nothing.
   */
  openInvoiceId,
  /**
   * A caller's own control, rendered **inside** the screen chrome.
   *
   * The laboratory till has a second view — a month's statements — and the
   * toggle for it was first placed beside `<InvoiceLedger>` in the screen that
   * composes them. That put it *above* the `AppHeader` this component renders,
   * so two buttons floated over the title with nothing around them. Reported
   * from use, and obvious the moment it is on a phone.
   *
   * A slot rather than the toggle itself: billing and the pharmacy have no
   * second view, and giving this component knowledge of one laboratory feature
   * is how a shared screen accumulates three callers' worth of special cases.
   * It lands under the header and above the segments, which is where a view
   * switch belongs — wider than the filter, narrower than the screen.
   */
  toolbar,
}: {
  basePath: '/billing' | '/pharmacy' | '/lab';
  title: string;
  emptyBody: string;
  openInvoiceId?: number | null;
  toolbar?: React.ReactNode;
}) {
  const money = useMoney();
  /*
   * The whole list is held, and the filter is applied for display.
   *
   * This tab used to fetch and then immediately discard every settled invoice,
   * which was right while its only job was "money still to collect" — and
   * became a bug the moment refunds existed. A paid invoice is exactly the one
   * you refund, and there was no way to reach it from a phone at all: the
   * refund button was on a card that could never render.
   */
  const [all, setAll] = useState<Invoice[] | null>(null);
  const [filter, setFilter] = useState<'outstanding' | 'paid' | 'closed'>('outstanding');

  /*
   * Three lists, and the third is not optional.
   *
   * Both of the first two exclude voided invoices, which meant a charge that
   * had been refunded and cancelled vanished from the phone entirely — the web
   * app still listed it as "Voided", so the two clients disagreed about whether
   * it existed. An invoice is never deleted precisely so the trail survives;
   * hiding it on one client throws that away for whoever is holding a phone.
   */
  const matches = (i: Invoice, f: typeof filter) =>
    f === 'closed' ? !!i.voidedAt : f === 'outstanding' ? !i.settled && !i.voidedAt : i.settled && !i.voidedAt;

  const invoices = all === null ? null : all.filter((i) => matches(i, filter));

  /* Counts on the tabs, so an empty list reads as "none" and not as "broken". */
  const counts =
    all === null
      ? null
      : {
          outstanding: all.filter((i) => matches(i, 'outstanding')).length,
          paid: all.filter((i) => matches(i, 'paid')).length,
          closed: all.filter((i) => matches(i, 'closed')).length,
        };

  /*
   * The figure the list is about, stated once at the top.
   *
   * A list of amounts with no total is a list somebody adds up by hand — and
   * "how much is still owed" is the entire reason for opening the outstanding
   * tab. Summed in minor units from the canonical two-decimal strings, never as
   * floats.
   */
  const total =
    invoices === null || filter === 'closed'
      ? null
      : sumMoney(invoices.map((i) => (filter === 'outstanding' ? i.outstanding : i.amountPaid)));
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [payingId, setPayingId] = useState<number | null>(openInvoiceId ?? null);

  const load = useCallback(async () => {
    setError(null);
    try {
      /*
       * Filtered here rather than in a query parameter: the API's `status`
       * filter takes a single InvoiceStatus, and "unsettled" spans PENDING,
       * PARTIALLY_PAID and OVERDUE. `settled` is already computed server-side,
       * so this reads the server's answer rather than deriving its own from
       * amounts — which would mean money arithmetic on the client.
       */
      /*
       * Every route spelled out rather than built from `basePath`. Three tills
       * now, and the repetition is the price of the guarantee.
       *
       * A path assembled from a variable is invisible to
       * `endpoint-coverage.spec.ts`, which matches on the literal passed to
       * `api()`. That test exists because an endpoint with no caller is an
       * unfinished feature, and hiding a caller from it is the same harm as not
       * writing one. The extractor now reads both branches of a ternary; this
       * keeps the literals where a human grepping for a route finds them too.
       */
      const res = await api<{ data: Invoice[] }>(
        basePath === '/pharmacy'
          ? '/pharmacy/invoices'
          : basePath === '/lab'
            ? '/lab/invoices'
            : '/billing/invoices',
      );
      setAll(res.data);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load invoices');
    }
  }, [basePath]);

  // Refetches on focus and every 15s. Another clerk taking a payment at the
  // counter should not leave this list showing an amount already settled.
  useLiveData(load);

  return (
    <Screen>
      <AppHeader
        title={title}
        subtitle={
          total === null
            ? `${filter === 'closed' ? 'Cancelled' : 'Updated'} · ${relativeAge(fetchedAt)}`
            : `${money(total)} ${filter === 'outstanding' ? 'still owed' : 'collected'} · ${relativeAge(fetchedAt)}`
        }
      />

      {/* Under the header, above the segments — see `toolbar` above. */}
      {toolbar}

      {error && <ErrorBanner message={error} />}

      {/*
        Why this screen opened by itself.
        ---------------------------------
        Arriving here is a handover from the act that raised the charge — a
        dispense, or accepting a referral. The payment form opens on its own,
        and without a line saying why, that reads as the app having jumped
        somewhere at random. Reported as "it silently generates the invoice,
        people may not know we need to take the money".

        Shown only on arrival, and cleared as soon as the form is closed, so it
        never becomes furniture on a screen somebody left open.
      */}
      {openInvoiceId !== null && openInvoiceId !== undefined && payingId === openInvoiceId && (
        <View style={s.prompt}>
          <Text style={s.promptText}>Charge raised — take the payment now.</Text>
        </View>
      )}

      {/* Three lists, three questions: what is still owed, what has been
          collected — where a refund starts — and what was cancelled, which the
          web app has always shown and the phone was silently dropping. */}
      <View style={s.tabs}>
        <Button
          label={`Outstanding${counts ? ` (${counts.outstanding})` : ''}`}
          variant={filter === 'outstanding' ? 'primary' : 'secondary'}
          size="sm"
          style={s.tab}
          onPress={() => setFilter('outstanding')}
        />
        <Button
          label={`Paid${counts ? ` (${counts.paid})` : ''}`}
          variant={filter === 'paid' ? 'primary' : 'secondary'}
          size="sm"
          style={s.tab}
          onPress={() => setFilter('paid')}
        />
        <Button
          label={`Closed${counts ? ` (${counts.closed})` : ''}`}
          variant={filter === 'closed' ? 'primary' : 'secondary'}
          size="sm"
          style={s.tab}
          onPress={() => setFilter('closed')}
        />
      </View>

      <FlatList
        data={invoices ?? []}
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
          invoices === null ? null : filter === 'outstanding' ? (
            <EmptyState glyph="✓" title="Nothing outstanding" body="Every invoice is settled." />
          ) : filter === 'paid' ? (
            <EmptyState glyph="¤" title="Nothing paid yet" body={emptyBody} />
          ) : (
            <EmptyState
              glyph="⊘"
              title="Nothing cancelled"
              body="Invoices refunded and cancelled in full appear here."
            />
          )
        }
        renderItem={({ item }) => (
          <InvoiceCard
            invoice={item}
            basePath={basePath}
            money={money}
            expanded={payingId === item.id}
            onToggle={() => setPayingId(payingId === item.id ? null : item.id)}
            onPaid={(updated) => {
              setAll((prev) => (prev ?? []).map((i) => (i.id === updated.id ? updated : i)));
              setPayingId(null);
            }}
          />
        )}
      />
    </Screen>
  );
}

function InvoiceCard({
  invoice,
  basePath,
  money,
  expanded,
  onToggle,
  onPaid,
}: {
  invoice: Invoice;
  basePath: '/billing' | '/pharmacy' | '/lab';
  money: (amount: string) => string;
  expanded: boolean;
  onToggle: () => void;
  onPaid: (updated: Invoice) => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refunding, setRefunding] = useState(false);
  /*
   * Cancelling the charge is what closes the loop. Refunding alone leaves the
   * charge standing, so the balance reappears and the invoice becomes payable
   * again — pay, refund, outstanding, pay, with no state that ends. Left as a
   * choice because a returned deposit against a charge that still stands is a
   * real case, just a much rarer one.
   */
  const [cancelCharge, setCancelCharge] = useState(true);

  const overdue = invoice.daysOverdue > 0;

  /**
   * Give money back.
   *
   * Capped server-side at what the invoice currently holds — refunding twice
   * against one payment is the obvious route to paying somebody the same money
   * twice, and the arithmetic is what stops it.
   *
   * The method is fixed to CASH here rather than asked for: a refund handed
   * over at the desk on a phone is cash by definition. A card reversal is done
   * on the web, where the original payment can be picked.
   */
  const refund = async () => {
    const value = refundAmount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) {
      return setError('Enter an amount like 250 or 250.00.');
    }

    setRefunding(true);
    setError(null);
    try {
      const updated = await api<Invoice>(
        basePath === '/pharmacy'
          ? `/pharmacy/invoices/${invoice.id}/refunds`
          : basePath === '/lab'
            ? `/lab/invoices/${invoice.id}/refunds`
            : `/billing/invoices/${invoice.id}/refunds`,
        {
        method: 'POST',
        body: {
          amount: value,
          method: 'CASH',
          reason: refundReason.trim(),
          cancelCharge,
        },
      });
      Alert.alert('Refund issued', `${money(value)} returned on invoice #${invoice.id}.`);
      setRefundAmount('');
      setRefundReason('');
      onPaid(updated);
    } catch (e) {
      // "More than is held" and "nothing to refund" both arrive with the
      // arithmetic spelled out.
      setError(e instanceof Error ? e.message : 'Could not issue this refund');
    } finally {
      setRefunding(false);
    }
  };

  const submit = async () => {
    const value = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) {
      return setError('Enter an amount like 250 or 250.00.');
    }

    setSaving(true);
    setError(null);
    try {
      /*
       * Sent as a string, and the server rejects an overpayment rather than
       * absorbing it. A credit balance needs refunds and credit notes to be
       * real, and neither exists — swallowing the excess would lose the
       * patient's money silently.
       */
      const updated = await api<Invoice>(
        basePath === '/pharmacy'
          ? `/pharmacy/invoices/${invoice.id}/payments`
          : basePath === '/lab'
            ? `/lab/invoices/${invoice.id}/payments`
            : `/billing/invoices/${invoice.id}/payments`,
        {
        method: 'POST',
        body: { amount: value, method },
      });
      Alert.alert('Payment recorded', `${money(value)} against invoice #${invoice.id}.`);
      onPaid(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record this payment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.name} numberOfLines={1}>
          {invoice.patient?.fullName ?? invoice.payer ?? 'No patient'}
        </Text>
        <StatusPill
          label={overdue ? `${invoice.daysOverdue}d overdue` : invoice.status.replace('_', ' ')}
          bg={overdue ? theme.color.dangerSoft : theme.color.primarySoft}
          fg={overdue ? theme.color.danger : theme.color.primary}
        />
      </View>

      {/*
        The doctor's order number, on the card.

        It is inside each lab line's description too, and the lines are a tap
        *in* — so a till showing forty rows gave no way to tell which order any
        of them was for without opening every one.
      */}
      {invoice.labAccessions && invoice.labAccessions.length > 0 && (
        <Text style={s.orderRef}>Order {invoice.labAccessions.join(', ')}</Text>
      )}

      <Text style={s.muted}>
        #{invoice.id} · issued {date(invoice.issuedAt)}
        {invoice.dueDate ? ` · due ${date(invoice.dueDate)}` : ''}
      </Text>

      <View style={s.amounts}>
        <Text style={s.outstanding}>{money(invoice.outstanding)}</Text>
        <Text style={s.muted}>
          of {money(invoice.totalAmount)} · {money(invoice.amountPaid)} paid
        </Text>
      </View>

      {/* A settled invoice has nothing to collect, so offering "Take payment"
          on it invites a rejection from the server. The only remaining action
          is giving money back. */}
      <Button
        label={expanded ? 'Close' : invoice.settled ? 'Refund' : 'Take payment'}
        variant={expanded ? 'secondary' : invoice.settled ? 'danger' : 'primary'}
        onPress={onToggle}
      />

      {expanded && (
        <View style={s.payBox}>
          {error && <ErrorBanner message={error} />}

          {/* Only when there is something left to collect. */}
          {!invoice.settled && (
            <>
              <Field
                label="Amount"
                value={amount}
                onChange={setAmount}
                placeholder={invoice.outstanding}
                keyboardType="decimal-pad"
              />
              <Button
                label={`Pay full ${money(invoice.outstanding)}`}
                variant="secondary"
                onPress={() => setAmount(invoice.outstanding)}
              />

              <Text style={s.label}>Method</Text>
              <View style={s.wrap}>
                {PAYMENT_METHODS.map((m) => (
                  <Button
                    key={m}
                    label={m.replace('_', ' ')}
                    variant={method === m ? 'primary' : 'secondary'}
                    onPress={() => setMethod(m)}
                  />
                ))}
              </View>

              <Button label="Record payment" busy={saving} onPress={() => void submit()} />
            </>
          )}

          {/*
            Refunding, offered only when the invoice is actually holding money.
            Not "has payments" — a fully refunded invoice has payments and holds
            nothing, and offering to refund it again invites paying somebody the
            same money twice.
          */}
          {invoice.amountPaid !== '0.00' && (
            <>
              <View style={s.divider} />
              <Text style={s.label}>Refund</Text>
              <Text style={s.muted}>
                Money going back. The charge stands and the invoice returns to unpaid — both the
                payment and the refund stay on the record.
              </Text>
              <Field
                label={`Amount — holding ${money(invoice.amountPaid)}`}
                value={refundAmount}
                onChange={setRefundAmount}
                placeholder={invoice.amountPaid}
                keyboardType="decimal-pad"
              />
              <Field
                label="Reason"
                value={refundReason}
                onChange={setRefundReason}
                placeholder="Why the money is going back"
                multiline
              />
              <Button
                label={cancelCharge ? 'Cancel the charge too' : 'Leave the charge standing'}
                variant={cancelCharge ? 'primary' : 'secondary'}
                size="sm"
                onPress={() => setCancelCharge(!cancelCharge)}
              />
              <Text style={s.muted}>
                {cancelCharge
                  ? 'The invoice is reduced by this amount, so no balance reappears.'
                  : 'The patient still owes this amount — only for a returned deposit.'}
              </Text>

              <Button
                label="Issue refund"
                variant="danger"
                busy={refunding}
                disabled={refundReason.trim().length < 8 || refundAmount.trim().length === 0}
                onPress={() => void refund()}
              />
            </>
          )}
        </View>
      )}

      {/* Listed beside the payment figures, never subtracted into them. */}
      {invoice.refunds.length > 0 && (
        <Text style={s.refundNote}>
          {money(refundTotal(invoice))} refunded
        </Text>
      )}
    </Card>
  );
}

/** Summed in minor units, from canonical two-decimal strings. */
function refundTotal(invoice: Invoice): string {
  return sumMoney(invoice.refunds.map((r) => r.amount));
}

/**
 * Adds canonical money strings without ever making one a float.
 *
 * Every amount from the server is `fromMinor` output — exactly two decimals, no
 * separators — so removing the point gives integer minor units directly.
 * `Number('12.30') + Number('0.10')` is the arithmetic this exists to avoid.
 */
function sumMoney(amounts: string[]): string {
  const minor = amounts.reduce((sum, a) => sum + Number(a.replace('.', '')), 0);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

const s = StyleSheet.create({
  prompt: {
    marginHorizontal: theme.space(4),
    marginTop: theme.space(3),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.primary,
  },
  promptText: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  tabs: {
    flexDirection: 'row',
    gap: theme.space(2),
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
  },
  tab: { flex: 1 },
  list: { padding: theme.space(4), gap: theme.space(3) },
  card: { gap: theme.space(2) },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space(2) },
  name: { ...theme.font.heading, color: theme.color.text, flex: 1, flexShrink: 1 },
  orderRef: {
    ...theme.font.caption,
    fontFamily: 'monospace',
    color: theme.color.text,
    fontWeight: '700',
  },
  muted: { ...theme.font.small, color: theme.color.textSubtle },
  amounts: { gap: 2, marginTop: theme.space(1) },
  outstanding: { ...theme.font.display, color: theme.color.text },
  divider: { height: 1, backgroundColor: theme.color.border, marginVertical: theme.space(2) },
  refundNote: { ...theme.font.caption, color: theme.color.danger, marginTop: theme.space(1) },
  payBox: {
    gap: theme.space(3),
    marginTop: theme.space(2),
    paddingTop: theme.space(4),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  label: { ...theme.font.caption, color: theme.color.textMuted },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2) },
});
