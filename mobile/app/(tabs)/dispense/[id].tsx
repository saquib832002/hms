import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, titleCase } from '@/lib/format';
import { Button, Card, ErrorBanner, Field, Screen } from '@/components/ui';
import { AllergyBanner } from '@/components/allergy-banner';
import { useMoney } from '@/lib/use-money';
import type { DispenseItem, DispensePreparation } from '@/lib/types';

/**
 * Hand medicine over, and record what was handed over.
 *
 * WHY THIS IS ON A PHONE
 * ----------------------
 * Dispensing was web-only, on the reasoning that it is "checked against stock at
 * a counter". That is where it happens and it is also where somebody is holding
 * a phone: the pharmacist is at the shelf with the box, not sitting at a
 * terminal. The mobile queue listed prescriptions and could do nothing with
 * them, which is a worse screen than none — it showed work and refused it.
 *
 * WHAT THE SERVER DECIDES, NOT THIS SCREEN
 * ----------------------------------------
 * The allergy check, the suggested quantity, whether an override is required,
 * and whether there is enough stock are all computed by `prepareDispense` and
 * re-checked on submit. This screen renders that answer and collects a number.
 * Duplicating any of it here would be two implementations of a safety rule, and
 * the phone's would be the one nobody tests.
 */
export default function DispenseScreen() {
  const money = useMoney();
  const { id } = useLocalSearchParams<{ id: string }>();
  const prescriptionId = Number(id);

  const [prep, setPrep] = useState<DispensePreparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await api<DispensePreparation>(`/pharmacy/prescriptions/${prescriptionId}`);
      setPrep(p);
      /*
       * Pre-filled with the server's suggestion where it has one.
       *
       * It suggests a figure only when frequency and duration are both
       * unambiguous, and says nothing when they are not — a blank box is the
       * honest answer to "three times a day as needed". Inventing a number
       * there would be a guess a pharmacist might not check.
       */
      setQuantities(
        Object.fromEntries(
          p.items.map((i) => [i.id, i.suggestedQuantity != null ? String(i.suggestedQuantity) : '']),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this prescription');
    }
  }, [prescriptionId]);

  useLiveData(load);

  const submit = async () => {
    const lines = (prep?.items ?? [])
      .map((i) => ({ prescriptionItemId: i.id, quantity: Number(quantities[i.id] ?? '') }))
      .filter((l) => Number.isInteger(l.quantity) && l.quantity > 0);

    if (lines.length === 0) {
      return setError('Enter a quantity for at least one item.');
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api<unknown>(`/pharmacy/prescriptions/${prescriptionId}/dispense`, {
        method: 'POST',
        body: {
          lines,
          overrideReason: overrideReason.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      });
      const charge = (result as {
        charge?: { invoiceId: number | null; total: string; unpriced: string[] };
      }).charge;

      /*
       * Straight to taking the money.
       *
       * The medicine has already gone — this is a shortcut to the next task,
       * never a gate on the last one. Held back when something was left
       * unpriced: that notice is the one thing the pharmacist can still act on
       * with the patient present, and a payment form on top of it buries it.
       */
      if (charge?.invoiceId && charge.unpriced.length === 0) {
        router.replace({ pathname: '/till', params: { invoice: String(charge.invoiceId) } });
        return;
      }
      Alert.alert(
        'Dispensed',
        charge
          ? [
              `${lines.length} item${lines.length === 1 ? '' : 's'} recorded.`,
              `Charged ${money(charge.total)}.`,
              // Named, not counted. The pharmacist can still fix a missing
              // price while the patient is standing in front of them.
              charge.unpriced.length > 0
                ? `Not charged for: ${charge.unpriced.join(', ')} — no price set.`
                : null,
            ]
              .filter(Boolean)
              .join('\n')
          : `${lines.length} item${lines.length === 1 ? '' : 's'} recorded.`,
      );
      router.back();
    } catch (e) {
      /*
       * Insufficient stock, a blocking allergy with no reason given, an already
       * dispensed prescription — all arrive here with the server's own wording,
       * which states the arithmetic or names the conflict.
       */
      setError(e instanceof Error ? e.message : 'Could not record this dispense');
    } finally {
      setBusy(false);
    }
  };

  /*
   * The running total, before the pharmacist commits to it.
   *
   * Integer minor units, and the multiply happens at the unit price's four
   * decimals — the same rule `pricing.ts` applies on the server. Rounding twice
   * in two different places is how a receipt ends up a penny away from the
   * invoice, at a counter, with somebody holding cash.
   */
  const chosen = (prep?.items ?? [])
    .map((item) => ({ item, qty: Number(quantities[item.id] ?? 0) }))
    .filter(({ qty }) => Number.isFinite(qty) && qty > 0);

  const totalMinor = chosen.reduce(
    (sum, { item, qty }) =>
      item.unitPrice === null
        ? sum
        : sum + Math.round((Number(item.unitPrice) * 10_000 * qty) / 100),
    0,
  );
  const unpricedChosen = chosen.filter(({ item }) => item.unitPrice === null);

  const blocking = (prep?.allergyConflicts ?? []).filter((c) => c.level === 'BLOCKING');
  const warnings = (prep?.allergyConflicts ?? []).filter((c) => c.level === 'WARNING');
  const overrideMissing = !!prep?.requiresOverride && overrideReason.trim().length < 8;
  const alreadyDone = prep?.status === 'DISPENSED';
  const cancelled = prep?.status === 'CANCELLED';

  /*
   * Whether the pharmacist may close this prescription themselves.
   *
   * Mirrors `canBeSettledByHand` on the server, which is the authority: at
   * least one line has no fixed total, and none is known to still owe
   * anything. Computed here only so the button does not appear where the server
   * would refuse it — a control that exists to fail is worse than none.
   */
  const canSettle =
    !alreadyDone &&
    !cancelled &&
    (prep?.items ?? []).some((i) => i.completion === 'unknown') &&
    !(prep?.items ?? []).some((i) => i.completion === 'outstanding');

  const [settling, setSettling] = useState(false);

  async function markComplete() {
    setSettling(true);
    try {
      await api(`/pharmacy/prescriptions/${id}/complete`, { method: 'POST', body: {} });
      router.back();
    } catch (e) {
      // The server names what is still outstanding — more useful than a guess.
      setError(e instanceof Error ? e.message : 'Could not mark that fully dispensed');
    } finally {
      setSettling(false);
    }
  }

  return (
    <Screen>
      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      >
        {!prep ? (
          <Text style={s.muted}>Loading…</Text>
        ) : (
          <>
            <Card>
              <Text style={s.name}>{prep.patient.fullName}</Text>
              <Text style={s.muted}>
                Prescription #{prep.id} · issued {date(prep.issuedAt)}
                {prep.doctor ? ` · ${prep.doctor.fullName}` : ''}
              </Text>
              <Text style={s.muted}>{titleCase(prep.status.replace(/_/g, ' '))}</Text>
            </Card>

            <AllergyBanner allergies={prep.patient.allergies} />

            {/*
              A blocking conflict is the reason this screen exists on the
              pharmacy side at all. The prescriber was warned; the pharmacist is
              the second check, and this is where the medicine actually changes
              hands.
            */}
            {blocking.map((c, i) => (
              <View key={`b${i}`} style={[s.alert, s.alertBlocking]}>
                <Text style={s.alertTitle}>⛔ {c.medicineName}</Text>
                <Text style={s.alertBody}>{c.message}</Text>
              </View>
            ))}
            {warnings.map((c, i) => (
              <View key={`w${i}`} style={[s.alert, s.alertWarn]}>
                <Text style={s.alertTitleWarn}>⚠ {c.medicineName}</Text>
                <Text style={s.alertBodyWarn}>{c.message}</Text>
              </View>
            ))}

            {prep.uncataloguedItems.length > 0 && (
              /*
               * Flagged, never treated as safe. An item whose free text does not
               * match the catalogue cannot be allergy-checked or counted against
               * stock — silence here would read as "no conflict found", which is
               * a different and much more dangerous statement.
               */
              <View style={[s.alert, s.alertWarn]}>
                <Text style={s.alertTitleWarn}>Not in the catalogue</Text>
                <Text style={s.alertBodyWarn}>
                  {prep.uncataloguedItems.join(', ')} — no allergy check and no stock count.
                  Map them on the web app, or verify by hand.
                </Text>
              </View>
            )}

            {prep.items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                value={quantities[item.id] ?? ''}
                onChange={(v) => setQuantities((q) => ({ ...q, [item.id]: v }))}
                disabled={alreadyDone || cancelled}
                money={money}
                onPriced={() => void load()}
              />
            ))}

            {prep.requiresOverride && (
              <Card>
                <Text style={s.sectionTitle}>Override reason</Text>
                <Text style={s.muted}>
                  Required because of the blocking conflict above. Free text on purpose — this is
                  read by a human reviewing the dispense later, and a list of canned reasons gets
                  picked past without thought.
                </Text>
                <Field
                  label=""
                  value={overrideReason}
                  onChange={setOverrideReason}
                  placeholder="Why this is safe to hand over"
                  multiline
                />
              </Card>
            )}

            {chosen.length > 0 && (
              <Card>
                <View style={s.totalRow}>
                  <Text style={s.sectionTitle}>Total to charge</Text>
                  <Text style={s.total}>{money((totalMinor / 100).toFixed(2))}</Text>
                </View>
                {unpricedChosen.length > 0 && (
                  <Text style={s.unpriced}>
                    {unpricedChosen.map(({ item }) => item.medicineName).join(', ')} —{' '}
                    {unpricedChosen.length === 1 ? 'has' : 'have'} no price, so nothing is charged.
                    Set one on the Stock tab.
                  </Text>
                )}
              </Card>
            )}

            <Card>
              <Text style={s.sectionTitle}>Notes</Text>
              <Field
                label=""
                value={notes}
                onChange={setNotes}
                placeholder="Optional — counselling given, batch substituted…"
                multiline
              />
            </Card>

            {cancelled ? (
              <Text style={s.muted}>
                This prescription was cancelled by the prescriber and cannot be dispensed.
              </Text>
            ) : alreadyDone ? (
              <Text style={s.muted}>Already dispensed in full.</Text>
            ) : (
              <>
                <Button
                  label="Record dispense"
                  busy={busy}
                  disabled={overrideMissing}
                  onPress={() => void submit()}
                />

                {/*
                  Closing an open-ended course.

                  Some courses have no computable total — as directed, until
                  review, an inhaler. The server will not call those finished on
                  its own, correctly, because guessing is how a patient goes home
                  with the wrong count. Until now that refusal led nowhere and
                  the prescription sat at "partially dispensed" permanently.

                  Offered only when nothing is known to be outstanding: with a
                  line still owing, closing it would record a half-filled course
                  as complete, which is the worse error.
                */}
                {canSettle && (
                  <Button
                    label="Mark fully dispensed"
                    variant="secondary"
                    busy={settling}
                    onPress={() => void markComplete()}
                    style={{ marginTop: theme.space(2) }}
                  />
                )}
              </>
            )}

            {overrideMissing && (
              <Text style={s.muted}>An override reason of at least 8 characters is required.</Text>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function ItemCard({
  item,
  value,
  onChange,
  disabled,
  money,
  onPriced,
}: {
  item: DispenseItem;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  money: (amount: string) => string;
  onPriced: () => void;
}) {
  const [pricing, setPricing] = useState(false);
  const [price, setPrice] = useState('');
  const [savingPrice, setSavingPrice] = useState(false);
  const short = item.medicine !== null && item.inDateStock < Number(value || 0);

  return (
    <Card style={s.item}>
      <Text style={s.itemName}>
        {item.medicineName}
        {item.medicine?.isControlled ? ' · controlled' : ''}
      </Text>
      <Text style={s.muted}>
        {item.dosage} · {item.frequency} · {item.duration}
      </Text>

      <Text style={s.muted}>
        {item.medicine
          ? `${item.inDateStock} in date${item.outstandingQuantity != null ? ` · ${item.outstandingQuantity} outstanding` : ''}`
          : 'Not matched to the catalogue — stock unknown'}
      </Text>

      {/*
        Not "0.00" when unpriced. Zero would read as free, which is a
        different fact with a different fix.

        And priceable right here. Sending the pharmacist to the stock screen
        mid-dispense, with a patient at the counter, meant in practice that
        the medicine went out unpriced and the hospital lost the money
        quietly. Same `PATCH /medicines/:id` the catalogue screen uses, and
        already open to PHARMACIST — a shortcut to an existing capability,
        not a new permission.
      */}
      {/* Always tappable when there is a catalogue row to price. */}
      {item.unitPrice !== null && !pricing ? (
        <Pressable
          onPress={() => {
            if (!item.medicine) return;
            setPrice(String(item.unitPrice));
            setPricing(true);
          }}
        >
          <Text style={s.muted}>
            {money(Number(item.unitPrice).toFixed(2))} each{item.medicine ? ' · tap to change' : ''}
          </Text>
        </Pressable>
      ) : !item.medicine ? (
        /* No catalogue row to put a price on. Mapping is the fix, and the
           line above already says the item is unmatched. */
        <Text style={s.short}>No price set — this will not be charged for</Text>
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
          <Button
            label={savingPrice ? '…' : 'Save'}
            size="sm"
            variant="primary"
            disabled={savingPrice || !price.trim()}
            onPress={async () => {
              setSavingPrice(true);
              try {
                await api(`/medicines/${item.medicine!.id}`, {
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
          />
        </View>
      ) : (
        <Pressable onPress={() => setPricing(true)}>
          <Text style={s.short}>No price set — tap to set a price</Text>
        </Pressable>
      )}

      {/* Expiring batches named, because a pharmacist picking off the shelf
          needs to know which box to reach for, not just that stock exists. */}
      {item.batches.length > 0 && (
        <Text style={s.batches} numberOfLines={2}>
          {item.batches
            .map((b) => `${b.batchNumber} ×${b.quantity}${b.expired ? ' (expired)' : ''}`)
            .join(' · ')}
        </Text>
      )}

      {!disabled && (
        <Field
          label="Quantity handed over"
          value={value}
          onChange={onChange}
          keyboardType="number-pad"
          placeholder={
            item.quantityPrescribed != null
              ? String(Math.max(0, item.quantityPrescribed - item.quantityDispensed))
              : item.suggestedQuantity != null
                ? String(item.suggestedQuantity)
                : 'Units'
          }
        />
      )}

      {short && (
        <Text style={s.short}>
          More than the {item.inDateStock} in date. The server will refuse this.
        </Text>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), gap: theme.space(3), paddingBottom: theme.space(8) },
  muted: { ...theme.font.caption, color: theme.color.textSubtle, lineHeight: 16 },
  name: { ...theme.font.title, color: theme.color.text },
  sectionTitle: { ...theme.font.caption, color: theme.color.textMuted, textTransform: 'uppercase' },

  item: { gap: theme.space(1) },
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
  itemName: { ...theme.font.heading, color: theme.color.text },
  batches: { ...theme.font.caption, color: theme.color.textMuted },
  short: { ...theme.font.caption, color: theme.color.danger },

  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  total: { ...theme.font.title, color: theme.color.text },
  unpriced: { ...theme.font.caption, color: theme.color.warning, marginTop: theme.space(1), lineHeight: 16 },

  alert: { borderRadius: theme.radius.sm, padding: theme.space(3) },
  alertBlocking: { backgroundColor: theme.color.dangerSoft },
  alertWarn: { backgroundColor: theme.color.warningSoft },
  alertTitle: { ...theme.font.heading, color: theme.color.danger },
  alertBody: { ...theme.font.small, color: theme.color.danger, lineHeight: 18 },
  alertTitleWarn: { ...theme.font.heading, color: theme.color.warning },
  alertBodyWarn: { ...theme.font.small, color: theme.color.warning, lineHeight: 18 },
});
