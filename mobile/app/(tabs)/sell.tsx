import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { useMoney } from '@/lib/use-money';
import { theme } from '@/lib/theme';
import { AppHeader, Button, Card, ErrorBanner, Field, Screen } from '@/components/ui';
import type { InventoryRow, SaleCharge } from '@/lib/types';

/**
 * The counter, on the phone.
 *
 * WHY THIS BELONGS ON A PHONE AT ALL
 * ----------------------------------
 * The obvious objection is that a till is a desk. It is — and the pharmacist
 * selling paracetamol is standing at the shelf with the box, which is exactly
 * the argument that put dispensing here. A small clinic's pharmacy is one
 * person and one counter, and making them walk to a terminal to record a
 * two-item sale is how sales stop being recorded.
 *
 * WHAT IS DIFFERENT FROM DISPENSING
 * ---------------------------------
 * Nothing here was checked by a doctor. There is no prescription, no allergy
 * check unless a patient is named, and no suggested quantity. That is stated on
 * the screen rather than left to be inferred from an absence of warnings — an
 * empty warning area looks identical whether nothing was found or nothing was
 * looked for.
 */
export default function CounterSaleScreen() {
  const money = useMoney();
  /*
   * Filling a prescription written at another hospital.
   *
   * Through this screen rather than the dispensing one because the prescription
   * belongs to the other hospital: there is no local row to key on, and
   * inventing a `Patient` for somebody not under this hospital's care would put
   * a stranger into the list reception searches. The pharmacist reads the
   * referral and finds the matching medicines in this catalogue.
   */
  const { referral: referralId } = useLocalSearchParams<{ referral?: string }>();
  const [stock, setStock] = useState<InventoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [basket, setBasket] = useState<Record<number, string>>({});
  const [buyerName, setBuyerName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: InventoryRow[] }>('/pharmacy/inventory');
      setStock(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue');
    }
  }, []);

  useLiveData(load);

  const byId = useMemo(() => new Map((stock ?? []).map((r) => [r.id, r])), [stock]);

  const lines = Object.entries(basket)
    .map(([id, qty]) => ({ row: byId.get(Number(id)), quantity: Number(qty) }))
    .filter((l): l is { row: InventoryRow; quantity: number } =>
      Boolean(l.row) && Number.isInteger(l.quantity) && l.quantity > 0,
    );

  /* Minor units, rounded once per line — see `pricing.ts` for why. */
  const totalMinor = lines.reduce(
    (sum, l) =>
      l.row.sellingPrice === null
        ? sum
        : sum + Math.round((Number(l.row.sellingPrice) * 10_000 * l.quantity) / 100),
    0,
  );
  const unpriced = lines.filter((l) => l.row.sellingPrice === null);

  const visible = (stock ?? []).filter((r) =>
    query.trim() ? r.name.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ charge: SaleCharge }>('/pharmacy/sales', {
        method: 'POST',
        body: {
          lines: lines.map((l) => ({ medicineId: l.row.id, quantity: l.quantity })),
          buyerName: buyerName.trim() || undefined,
          referralId: referralId ? Number(referralId) : undefined,
        },
      });
      Alert.alert(
        'Sold',
        [
          `${money(res.charge.total)} charged.`,
          res.charge.invoiceId
            ? `Invoice #${res.charge.invoiceId} — take payment on the Till tab.`
            : 'No invoice raised: nothing on this sale had a price.',
          res.charge.unpriced.length > 0
            ? `Not charged for: ${res.charge.unpriced.join(', ')}.`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      setBasket({});
      setBuyerName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that sale');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <AppHeader
        title="Counter sale"
        subtitle={
          referralId
            ? 'Filling a prescription from another hospital — allergies are not sent, ask the patient'
            : lines.length === 0
            ? 'No prescription — nothing here is doctor-checked'
            : `${lines.length} item${lines.length === 1 ? '' : 's'} · ${money((totalMinor / 100).toFixed(2))}`
        }
      />

      {error && <ErrorBanner message={error} />}

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Field
          label=""
          value={query}
          onChange={setQuery}
          placeholder="Search the catalogue…"
        />

        {stock === null ? (
          <Text style={s.muted}>Loading…</Text>
        ) : visible.length === 0 ? (
          <Text style={s.muted}>
            Nothing matches. Medicines are added on the Stock tab — an empty catalogue is why a
            new hospital&rsquo;s pharmacy has nothing to sell.
          </Text>
        ) : (
          visible.map((row) => (
            <Row
              key={row.id}
              row={row}
              value={basket[row.id] ?? ''}
              money={money}
              onPriced={() => void load()}
              onChange={(v) =>
                setBasket((b) => {
                  const next = { ...b };
                  if (!v || Number(v) <= 0) delete next[row.id];
                  else next[row.id] = v;
                  return next;
                })
              }
            />
          ))
        )}

        {lines.length > 0 && (
          <Card>
            <View style={s.totalRow}>
              <Text style={s.sectionTitle}>Total</Text>
              <Text style={s.total}>{money((totalMinor / 100).toFixed(2))}</Text>
            </View>

            {unpriced.length > 0 && (
              <Text style={s.warn}>
                {unpriced.map((l) => l.row.name).join(', ')} — no price set, so nothing will be
                charged for {unpriced.length === 1 ? 'it' : 'them'}.
              </Text>
            )}

            {/* For the receipt only. Not stored against anybody, not
                searchable, and deliberately not a patient record — a walk-in
                is not somebody under the hospital's care. */}
            <Field
              label="Buyer (optional)"
              value={buyerName}
              onChange={setBuyerName}
              placeholder="For the receipt only"
            />

            <Button label="Record sale" busy={busy} onPress={() => void submit()} />

            <Text style={s.muted}>
              Stock comes off the shortest-dated batches first. Payment is taken separately on the
              Till tab — medicine is never held back over an unpaid balance.
            </Text>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

function Row({
  row,
  value,
  onChange,
  money,
  onPriced,
}: {
  row: InventoryRow;
  value: string;
  onChange: (v: string) => void;
  money: (amount: string) => string;
  onPriced: () => void;
}) {
  const [pricing, setPricing] = useState(false);
  const [price, setPrice] = useState('');
  const [savingPrice, setSavingPrice] = useState(false);
  const out = row.inDateQuantity === 0;

  return (
    <Card style={s.row}>
      <View style={s.rowTop}>
        <Text style={s.name} numberOfLines={1}>
          {row.name} <Text style={s.muted}>{row.strength} {row.form}</Text>
        </Text>
        <Text style={out ? s.short : s.muted}>{row.inDateQuantity} in date</Text>
      </View>

      {/*
        Priced here, at the till.

        Null means nobody has priced it — distinct from zero, which means the
        hospital gives it away. The sale still goes through and simply is not
        charged for, which is the right model and had no repair path: the only
        fix was to leave the sale, open the stock screen, price it and start
        again, with somebody waiting. So in practice the medicine went out
        unpriced and the money was lost quietly.

        Same `PATCH /medicines/:id` as the catalogue editor, already open to
        PHARMACIST — a shortcut to a capability they held.
      */}
      {/*
        Always tappable, priced or not. A control that only appears when the
        price is missing is indistinguishable from a screen that has no such
        feature — reported as missing more than once — and a wrong price is
        found at the till exactly like an absent one.
      */}
      {row.sellingPrice !== null && !pricing ? (
        <Pressable onPress={() => { setPrice(String(row.sellingPrice)); setPricing(true); }}>
          <Text style={s.muted}>{money(Number(row.sellingPrice).toFixed(2))} each · tap to change</Text>
        </Pressable>
      ) : pricing ? (
        <View style={s.priceRow}>
          <TextInput
            autoFocus
            style={s.priceInput}
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            placeholder="0.0000"
            placeholderTextColor={theme.color.textSubtle}
          />
          <Pressable
            disabled={savingPrice || !price.trim()}
            style={s.quick}
            onPress={async () => {
              setSavingPrice(true);
              try {
                await api(`/medicines/${row.id}`, {
                  method: 'PATCH',
                  body: { sellingPrice: price.trim() },
                });
                setPricing(false);
                onPriced();
              } catch (e) {
                Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.');
              } finally {
                setSavingPrice(false);
              }
            }}
          >
            <Text style={s.quickText}>{savingPrice ? '…' : 'Save'}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable onPress={() => setPricing(true)}>
          <Text style={s.warn}>Not priced — tap to set a price</Text>
        </Pressable>
      )}

      {!out && (
        <View style={s.qtyRow}>
          <Field
            label="Quantity"
            value={value}
            onChange={onChange}
            keyboardType="number-pad"
            placeholder="0"
          />
          {[1, 2, 10].map((n) => (
            <Pressable key={n} onPress={() => onChange(String(n))} style={s.quick}>
              <Text style={s.quickText}>{n}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), gap: theme.space(2), paddingBottom: theme.space(8) },
  muted: { ...theme.font.caption, color: theme.color.textSubtle, lineHeight: 16 },
  sectionTitle: { ...theme.font.caption, color: theme.color.textMuted, textTransform: 'uppercase' },
  warn: { ...theme.font.caption, color: theme.color.warning, lineHeight: 16 },
  short: { ...theme.font.caption, color: theme.color.danger },

  row: { gap: theme.space(1) },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  name: { ...theme.font.heading, color: theme.color.text, flexShrink: 1 },

  qtyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.space(1) },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  priceInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: theme.color.text,
    textAlign: 'right',
  },
  quick: {
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    marginBottom: theme.space(2),
  },
  quickText: { ...theme.font.caption, color: theme.color.text, fontWeight: '700' },

  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  total: { ...theme.font.title, color: theme.color.text },
});
