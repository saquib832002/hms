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

export default function InvoicesScreen() {
  const money = useMoney();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [payingId, setPayingId] = useState<number | null>(null);

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
      const res = await api<{ data: Invoice[] }>('/billing/invoices');
      setInvoices(res.data.filter((i) => !i.settled && !i.voidedAt));
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load invoices');
    }
  }, []);

  // Refetches on focus and every 15s. Another clerk taking a payment at the
  // counter should not leave this list showing an amount already settled.
  useLiveData(load);

  return (
    <Screen>
      <AppHeader title="Invoices" subtitle={`Unsettled · updated ${relativeAge(fetchedAt)}`} />

      {error && <ErrorBanner message={error} />}

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
          invoices === null ? null : (
            <EmptyState glyph="✓" title="Nothing outstanding" body="Every invoice is settled." />
          )
        }
        renderItem={({ item }) => (
          <InvoiceCard
            invoice={item}
            money={money}
            expanded={payingId === item.id}
            onToggle={() => setPayingId(payingId === item.id ? null : item.id)}
            onPaid={(updated) => {
              setInvoices((prev) => (prev ?? []).map((i) => (i.id === updated.id ? updated : i)));
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
  money,
  expanded,
  onToggle,
  onPaid,
}: {
  invoice: Invoice;
  money: (amount: string) => string;
  expanded: boolean;
  onToggle: () => void;
  onPaid: (updated: Invoice) => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overdue = invoice.daysOverdue > 0;

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
      const updated = await api<Invoice>(`/billing/invoices/${invoice.id}/payments`, {
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
          {invoice.patient?.fullName ?? 'No patient'}
        </Text>
        <StatusPill
          label={overdue ? `${invoice.daysOverdue}d overdue` : invoice.status.replace('_', ' ')}
          bg={overdue ? theme.color.dangerSoft : theme.color.primarySoft}
          fg={overdue ? theme.color.danger : theme.color.primary}
        />
      </View>

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

      <Button
        label={expanded ? 'Close' : 'Take payment'}
        variant={expanded ? 'secondary' : 'primary'}
        onPress={onToggle}
      />

      {expanded && (
        <View style={s.payBox}>
          {error && <ErrorBanner message={error} />}

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
        </View>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  list: { padding: theme.space(4), gap: theme.space(3) },
  card: { gap: theme.space(2) },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space(2) },
  name: { ...theme.font.heading, color: theme.color.text, flex: 1, flexShrink: 1 },
  muted: { ...theme.font.small, color: theme.color.textSubtle },
  amounts: { gap: 2, marginTop: theme.space(1) },
  outstanding: { ...theme.font.display, color: theme.color.text },
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
