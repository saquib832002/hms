import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { useMoney } from '@/lib/use-money';
import { theme } from '@/lib/theme';
import { date, relativeAge, time } from '@/lib/format';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
} from '@/components/ui';
import type { PaymentListItem } from '@/lib/types';

/**
 * Money that has come in, most recent first.
 *
 * WHY THIS EXISTS SEPARATELY FROM INVOICES
 * ----------------------------------------
 * The Invoices tab is organised around a patient's balance. This one is
 * organised around transactions, which is the shape of two different questions:
 * "did that card payment go through" and "we need to reverse the one taken this
 * morning". Answering either from the invoice list means knowing which patient
 * it was first, which is exactly what somebody chasing a payment does not have.
 *
 * REFUNDING FROM HERE IS THE BETTER PATH
 * --------------------------------------
 * A refund started from a payment carries that payment's id, so the reversal is
 * recorded against the thing it reverses. That matters most where it is easiest
 * to get wrong: an invoice settled by three payments, one of which needs
 * returning to the card it came from. Starting from the invoice, the server
 * knows the amount and not the origin.
 */
export default function PaymentsScreen() {
  const money = useMoney();
  const [payments, setPayments] = useState<PaymentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [refunding, setRefunding] = useState<PaymentListItem | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: PaymentListItem[] }>('/billing/payments');
      setPayments(res.data);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payments');
    }
  }, []);

  useLiveData(load);

  /*
   * Net for the day, from signed amounts — a refund subtracts.
   *
   * Gross taken and gross refunded are both in the list; the header is the
   * figure that matters when the drawer is counted. Summed from `signedAmount`
   * so nothing here has to know which rows point which way.
   */
  const today = payments?.filter((p) => isToday(p.receivedAt)) ?? [];
  const netToday = sumMoney(today.map((p) => p.signedAmount));
  const refundedToday = today.filter((p) => p.kind === 'REFUND').length;

  return (
    <Screen>
      <AppHeader
        title="Payments"
        subtitle={
          `${money(netToday)} net today` +
          (refundedToday > 0 ? ` · ${refundedToday} refunded` : '') +
          ` · ${relativeAge(fetchedAt)}`
        }
      />

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={payments ?? []}
        // A payment and a refund can share an id — the key has to carry both.
        keyExtractor={(item) => `${item.kind}-${item.id}`}
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
          payments === null ? null : (
            <EmptyState glyph="¤" title="No payments yet" body="Money taken will appear here." />
          )
        }
        renderItem={({ item }) => (
          <Card style={s.card}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>
                  {item.patient?.fullName ?? 'No patient'}
                </Text>
                <Text style={s.muted}>
                  Invoice #{item.invoiceId} · {titleise(item.method)}
                  {item.reference ? ` · ${item.reference}` : ''}
                  {/* The transaction it reverses — the reference an accountant
                      looks for when a refund appears out of context. */}
                  {item.reversesPaymentId ? ` · reverses #${item.reversesPaymentId}` : ''}
                </Text>
                {item.reason ? (
                  <Text style={s.reason} numberOfLines={2}>
                    {item.reason}
                  </Text>
                ) : null}
                <Text style={s.muted}>
                  {/* Time alone for today's — the date adds nothing when you
                      are reconciling the till you are standing at. */}
                  {isToday(item.receivedAt)
                    ? time(item.receivedAt)
                    : `${date(item.receivedAt)} ${time(item.receivedAt)}`}
                  {item.receivedBy ? ` · ${item.receivedBy}` : ''}
                </Text>
              </View>
              {/* Signed, because the direction is the point. A refund that
                  reads like a payment is a ledger that cannot be balanced. */}
              <Text style={[s.amount, item.kind === 'REFUND' ? s.amountOut : null]}>
                {item.kind === 'REFUND' ? '−' : ''}
                {money(item.amount)}
              </Text>
            </View>

            {/*
              Only a payment can be reversed, and only one that still has
              something left to give back.
              -------------------------------------------------------------
              This offered "Refund this payment" on a payment that had already
              been refunded in full. The server refuses the second attempt, so
              nothing could go wrong with the money — but a button whose only
              possible outcome is an error is a bug in its own right, and it
              invites somebody to try twice and wonder which one counted.
            */}
            {item.kind === 'PAYMENT' &&
              (item.fullyRefunded ? (
                <Text style={s.reversed}>Fully refunded</Text>
              ) : (
                <>
                  {item.refundedAmount !== '0.00' && (
                    <Text style={s.reversed}>{money(item.refundedAmount)} already refunded</Text>
                  )}
                  <Button
                    label="Refund this payment"
                    variant="secondary"
                    size="sm"
                    onPress={() => setRefunding(item)}
                  />
                </>
              ))}
          </Card>
        )}
      />

      {refunding && (
        <RefundSheet
          payment={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => {
            setRefunding(null);
            void load();
          }}
        />
      )}
    </Screen>
  );
}

/* ─────────────────────────────── refund ─────────────────────────────── */

function RefundSheet({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentListItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const money = useMoney();
  /*
   * Defaults to what is left, not to the original amount. A payment refunded
   * in part would otherwise pre-fill more than the invoice can give back, and
   * the first thing the user sees is a rejection.
   */
  const [amount, setAmount] = useState(
    payment.refundedAmount === '0.00'
      ? payment.amount
      : subtractMoney(payment.amount, payment.refundedAmount),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Cancelling the charge is what stops the balance reappearing. See below. */
  const [cancelCharge, setCancelCharge] = useState(true);

  const submit = async () => {
    const value = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) {
      return setError('Enter an amount like 250 or 250.00.');
    }

    setBusy(true);
    setError(null);
    try {
      await api(`/billing/invoices/${payment.invoiceId}/refunds`, {
        method: 'POST',
        body: {
          amount: value,
          /*
           * Back the way it came. Starting from a payment is the one place the
           * original method is actually known, so it is used rather than asked
           * for — a card refund that goes back to the card is the whole point
           * of refunding from here.
           */
          method: payment.method,
          paymentId: payment.id,
          reason: reason.trim(),
          cancelCharge,
        },
      });
      Alert.alert('Refund issued', `${money(value)} returned on invoice #${payment.invoiceId}.`);
      onDone();
    } catch (e) {
      /*
       * The server caps a refund at what the *invoice* currently holds, not at
       * this payment's amount — an invoice settled by three payments and
       * already partly refunded has less left than any one payment suggests.
       * Its message states the arithmetic.
       */
      setError(e instanceof Error ? e.message : 'Could not issue this refund');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.modalTitle}>Refund {money(payment.amount)}</Text>
            <Text style={s.muted}>
              {payment.patient?.fullName ?? 'No patient'} · invoice #{payment.invoiceId} ·{' '}
              {titleise(payment.method)}
            </Text>

            <Text style={s.note}>
              The charge itself stands — the invoice goes back to unpaid, and both the payment and
              the refund stay on the record.
            </Text>

            <Field
              label="Amount"
              value={amount}
              onChange={setAmount}
              keyboardType="decimal-pad"
              placeholder={payment.amount}
            />
            <Field
              label="Reason"
              value={reason}
              onChange={setReason}
              placeholder="Why the money is going back"
              multiline
            />

            <Button
              label={cancelCharge ? '✓ Cancel the charge too' : 'Leave the charge standing'}
              variant={cancelCharge ? 'primary' : 'secondary'}
              size="sm"
              onPress={() => setCancelCharge(!cancelCharge)}
            />
            <Text style={s.note}>
              {cancelCharge
                ? 'The invoice is reduced by this amount, so no balance reappears. Refunding and cancelling in full closes the invoice.'
                : 'The charge stands and the patient still owes this amount — only for a returned deposit.'}
            </Text>

            {error && <Text style={s.error}>{error}</Text>}

            <View style={{ gap: theme.space(2), marginTop: theme.space(3) }}>
              <Button
                label="Issue refund"
                variant="danger"
                busy={busy}
                disabled={reason.trim().length < 8}
                onPress={() => void submit()}
              />
              <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/** Difference of two canonical money strings, in minor units. */
function subtractMoney(a: string, b: string): string {
  const minor = Number(a.replace('.', '')) - Number(b.replace('.', ''));
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Summed in minor units from canonical two-decimal strings — never as floats. */
function sumMoney(amounts: string[]): string {
  const minor = amounts.reduce((sum, a) => sum + Number(a.replace('.', '')), 0);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function titleise(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

const s = StyleSheet.create({
  list: { padding: theme.space(4), gap: theme.space(3) },
  card: { gap: theme.space(2) },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space(2) },
  name: { ...theme.font.heading, color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: 2 },
  amount: {
    ...theme.font.title,
    color: theme.color.success,
    fontVariant: ['tabular-nums'],
  },
  amountOut: { color: theme.color.danger },
  reason: { ...theme.font.caption, color: theme.color.textMuted, fontStyle: 'italic', marginTop: 2 },
  reversed: { ...theme.font.caption, color: theme.color.danger, marginTop: theme.space(1) },

  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,26,20,0.45)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(4),
    paddingBottom: theme.space(6),
    maxHeight: '85%',
  },
  modalTitle: { ...theme.font.title, color: theme.color.text },
  note: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    lineHeight: 16,
    marginTop: theme.space(2),
    marginBottom: theme.space(2),
  },
  error: { ...theme.font.small, color: theme.color.danger, marginTop: theme.space(2) },
});
