import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';
import { AppHeader, Button, Card, ErrorBanner, Field, Screen, SectionTitle } from '@/components/ui';
import type { LabOrderDestination, LabPartner, LabPriority, LabTest } from '@/lib/types';
import { lapsedReason } from '@/lib/referral-billing';

/**
 * Requesting investigations from the ward or the clinic room.
 *
 * A doctor finishing a consultation on a ward should not have to walk back to a
 * desk to order a blood test — the same argument that put prescribing on the
 * phone, and it applies more strongly here because the commonest moment for
 * this is a ward round.
 *
 * WHAT THIS ASKS FOR THAT LOOKS OPTIONAL AND IS NOT
 * ------------------------------------------------
 * The clinical question. A laboratory that does not know why a test was
 * requested cannot comment usefully on the answer. It is also the one clinical
 * field that leaves the hospital when the test goes to a partner, which is said
 * at the moment that destination is chosen.
 */
export default function LabOrderScreen() {
  const { patientId, patientName } = useLocalSearchParams<{
    patientId: string;
    patientName?: string;
  }>();
  const id = Number(patientId);

  const { user } = useAuth();
  const [tests, setTests] = useState<LabTest[]>([]);
  /** Inline price entry, keyed by test id. */
  const [priceDraft, setPriceDraft] = useState<Record<number, string>>({});
  const [pricing, setPricing] = useState<number | null>(null);
  const [partners, setPartners] = useState<LabPartner[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<LabPriority>('ROUTINE');
  const [destination, setDestination] = useState<LabOrderDestination>('IN_HOUSE');
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const [clinicalDetails, setClinicalDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    /*
     * Both fail quietly, and the empty state below names the precondition. An
     * empty catalogue and an unbuilt feature render identically, and this
     * project has been caught by that three times.
     */
    try {
      const res = await api<{ data: LabTest[] }>('/lab-tests');
      setTests(res.data);
    } catch {
      setTests([]);
    }
    try {
      const res = await api<{ data: LabPartner[] }>('/lab-partners');
      setPartners(res.data);
    } catch {
      setPartners([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? tests.filter((t) => t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q))
    : tests;
  const selected = tests.filter((t) => chosen.includes(t.id));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<{
        id: number;
        referral?: { reference: string; lab: string } | null;
        unpricedTests?: string[];
        /** The order number — on the label, the worklist and the invoice line. */
        accession?: string | null;
      }>('/lab-orders', {
        method: 'POST',
        body: {
          patientId: id,
          testIds: chosen,
          priority,
          destination,
          partnerId: destination === 'PARTNER' ? partnerId ?? undefined : undefined,
          clinicalDetails: clinicalDetails.trim() || undefined,
        },
      });

      /*
       * The order number leads every one of these.
       *
       * The screen used to close with nothing but a partner reference or an
       * unpriced warning, so a doctor ordering an ordinary in-house test was
       * told nothing at all and reported the order number as not being
       * generated. It was generated at ordering; it was never shown. It is
       * what appears on the specimen label, the laboratory's worklist and the
       * invoice line, so it is the one thing worth reading here.
       */
      const orderLine = created.accession
        ? `Order ${created.accession}.`
        : 'Order raised.';

      if (created.referral) {
        Alert.alert(
          `Sent to ${created.referral.lab}`,
          `${orderLine}\n\nThe patient quotes ${created.referral.reference} at the laboratory. Their report comes back onto this request; you do not have to chase it separately.`,
        );
      } else if (created.unpricedTests?.length) {
        // Named now rather than found in a report a month later.
        Alert.alert(
          'Requested — some not charged for',
          `${orderLine}\n\nNobody has priced ${created.unpricedTests.join(', ')}. They will still be done.`,
        );
      } else {
        Alert.alert(
          'Requested',
          `${orderLine}\n\nIt is on the specimen label, the laboratory's worklist and the invoice line.`,
        );
      }

      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not raise the request');
    } finally {
      setBusy(false);
    }
  };

  const chosenPartner = partners.find((p) => p.id === partnerId) ?? null;

  /*
   * Will *this* hospital be raising the patient's invoice for this order?
   * Mirrors `hospitalCharges` on the server; it decides only what the screen
   * says, never what is charged.
   */
  /**
   * Price a test without leaving the sheet.
   *
   * The same `PATCH /lab-tests/:id` the catalogue screen uses — a shortcut to a
   * capability these roles already hold, not a new permission.
   */
  async function setPrice(testId: number) {
    setPricing(testId);
    setError(null);
    try {
      await api(`/lab-tests/${testId}`, {
        method: 'PATCH',
        body: { sellingPrice: (priceDraft[testId] ?? '').trim() },
      });
      const res = await api<{ data: LabTest[] }>('/lab-tests');
      setTests(res.data);
      setPriceDraft({ ...priceDraft, [testId]: '' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set that price');
    } finally {
      setPricing(null);
    }
  }

  const weCharge =
    destination === 'IN_HOUSE' ||
    (destination === 'PARTNER' && chosenPartner?.billing === 'ORIGIN_PAYS');

  /*
   * Tests we are about to order, will be billing for, and have no price for.
   *
   * Reported after the first real partner referral: the sheet said the patient
   * pays here and no invoice appeared. The order was right — nothing is raised
   * when every line is unpriced — but the only warning came *after* sending, by
   * which point the patient is walking out. A clinic that refers its bloods out
   * has every reason to have an unpriced catalogue, so this is the normal case
   * for the hospitals the feature is for.
   */
  const unpriced = weCharge ? selected.filter((t) => t.sellingPrice === null) : [];

  // Pricing is ADMIN and LAB_TECHNICIAN, as on the catalogue screen. A doctor
  // mid-consultation is told what is wrong and who fixes it.
  const canPrice = user?.role === 'ADMIN' || user?.role === 'LAB_TECHNICIAN';

  /*
   * What that laboratory charges, before the work is sent.
   *
   * Under ORIGIN_PAYS this hospital pays whatever their catalogue says, and
   * could not see the number at any point — not when choosing where to send,
   * not when pricing the patient, not afterwards. It arrived as a statement.
   */
  const [partnerPrices, setPartnerPrices] = useState<Record<string, string | null> | null>(null);

  useEffect(() => {
    if (destination !== 'PARTNER' || partnerId === null) {
      setPartnerPrices(null);
      return;
    }
    let live = true;
    void api<{ data: { code: string; sellingPrice: string | null }[] }>(
      `/lab-partners/${partnerId}/catalogue`,
    )
      .then((res) => {
        if (!live) return;
        setPartnerPrices(
          Object.fromEntries(res.data.map((t) => [t.code.trim().toUpperCase(), t.sellingPrice])),
        );
      })
      // A price we cannot read is not a reason to block an order — the screen
      // says unknown rather than pretending it is zero.
      .catch(() => live && setPartnerPrices({}));
    return () => {
      live = false;
    };
  }, [destination, partnerId]);

  /*
   * A lapsed partnership is not a valid destination. The server refuses it
   * regardless — it re-checks against the other lab on every order, because
   * their terms change without anybody here being told — and this only stops
   * the doctor reaching the refusal.
   */
  const valid =
    chosen.length > 0 &&
    (destination !== 'PARTNER' || (partnerId !== null && chosenPartner?.lapsed == null));

  return (
    <Screen>
      <AppHeader title="Request tests" subtitle={patientName ?? `Patient #${id}`} />

      {error && <ErrorBanner message={error} />}

      <ScrollView contentContainerStyle={s.body}>
        {tests.length === 0 ? (
          <Card>
            <Text style={s.emptyTitle}>No tests in the catalogue yet.</Text>
            <Text style={s.muted}>
              An administrator adds them on the web app under Lab Tests — code, name, price and
              reference ranges. Until then there is nothing to request.
            </Text>
          </Card>
        ) : (
          <Card>
            <Field
              label="Find a test"
              value={query}
              onChange={setQuery}
              placeholder="Name or code"
              autoCapitalize="none"
            />
            {matches.slice(0, 30).map((t) => {
              const picked = chosen.includes(t.id);
              return (
                <Pressable
                  key={t.id}
                  onPress={() =>
                    setChosen((prev) =>
                      picked ? prev.filter((x) => x !== t.id) : [...prev, t.id],
                    )
                  }
                  style={[s.testRow, picked && s.testRowOn]}
                >
                  <Text style={s.tick}>{picked ? '✓' : ''}</Text>
                  <Text style={s.code}>{t.code}</Text>
                  <Text style={s.testName}>{t.name}</Text>
                </Pressable>
              );
            })}
          </Card>
        )}

        {/* Preparation belongs with the decision to order, not on a form the
            patient reads later. The commonest cause of a wasted sample is
            nobody having said this. */}
        {selected.some((t) => t.preparation) && (
          <Card style={s.prep}>
            <Text style={s.overline}>Tell the patient</Text>
            {selected
              .filter((t) => t.preparation)
              .map((t) => (
                <Text key={t.id} style={s.muted}>
                  {t.name} — {t.preparation}
                </Text>
              ))}
          </Card>
        )}

        <Card>
          <SectionTitle>Priority</SectionTitle>
          <View style={s.chips}>
            {(['ROUTINE', 'URGENT', 'STAT'] as LabPriority[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => setPriority(p)}
                style={[s.chip, priority === p && s.chipOn]}
              >
                <Text style={[s.chipText, priority === p && s.chipTextOn]}>{p}</Text>
              </Pressable>
            ))}
          </View>
          {priority !== 'ROUTINE' && (
            // Honest about what it does. A control that looks like it summons
            // somebody and does not is worse than no control.
            <Text style={s.muted}>
              This moves the request to the top of the laboratory&rsquo;s worklist. It notifies
              nobody — if it cannot wait, telephone them as well.
            </Text>
          )}
        </Card>

        <Card>
          <SectionTitle>Clinical details</SectionTitle>
          <Field
            label=""
            value={clinicalDetails}
            onChange={setClinicalDetails}
            placeholder="?anaemia, 3 months"
            multiline
          />
          <Text style={s.muted}>
            The laboratory reads this. Without it they cannot comment usefully on the result.
          </Text>
        </Card>

        <Card>
          <SectionTitle>Where it will be done</SectionTitle>
          <View style={s.chips}>
            {(['IN_HOUSE', 'EXTERNAL', 'PARTNER'] as LabOrderDestination[]).map((d) => {
              const disabled = d === 'PARTNER' && partners.length === 0;
              return (
                <Pressable
                  key={d}
                  disabled={disabled}
                  onPress={() => setDestination(d)}
                  style={[s.chip, destination === d && s.chipOn, disabled && s.chipOff]}
                >
                  <Text style={[s.chipText, destination === d && s.chipTextOn]}>
                    {d === 'IN_HOUSE'
                      ? 'Our lab'
                      : d === 'EXTERNAL'
                        ? 'Elsewhere'
                        : /* Shown disabled rather than omitted: a missing option
                             is indistinguishable from a feature that does not
                             exist. */
                          partners.length === 0
                          ? 'Partner lab — none added'
                          : 'Partner lab'}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {destination === 'PARTNER' && (
            <>
              <View style={s.chips}>
                {partners.map((p) => (
                  <Pressable
                    key={p.id}
                    /*
                     * A partnership the other lab has since changed under us
                     * cannot be ordered through. Disabled here, before it is
                     * picked, because the doctor cannot fix it and meeting it
                     * as a refusal after choosing the tests is a dead end in
                     * front of a patient.
                     */
                    disabled={p.lapsed !== null}
                    onPress={() => setPartnerId(p.id)}
                    style={[
                      s.chip,
                      partnerId === p.id && s.chipOn,
                      p.lapsed !== null && s.chipDisabled,
                    ]}
                  >
                    <Text style={[s.chipText, partnerId === p.id && s.chipTextOn]}>{p.label}</Text>
                  </Pressable>
                ))}
              </View>

              {/*
                Who is charging, before the order is sent.

                It changes what the doctor tells the patient on the way out —
                "settle it at reception" or "take this to the lab and pay
                there" — and there is no second chance to say it once they have
                left the room.
              */}
              {chosenPartner && !chosenPartner.lapsed && (
                <Text
                  style={
                    chosenPartner.billing === 'PATIENT_PAYS' ? s.payerPatient : s.payerHospital
                  }
                >
                  {chosenPartner.billing === 'PATIENT_PAYS'
                    ? `We will not charge for this. The patient pays ${chosenPartner.label} at their counter.`
                    : `We charge the patient here. ${chosenPartner.label} invoices us.`}
                </Text>
              )}

              {chosenPartner?.lapsed && (
                <Text style={s.payerWarn}>
                  {lapsedReason(chosenPartner.lapsed, chosenPartner.label)}
                </Text>
              )}

              {/*
                Their price against ours, per test.

                Only under ORIGIN_PAYS: that is the arrangement where this
                hospital actually pays. The useful fact is not "they charge
                500" — it is whether what we charge the patient covers it, and
                a clinic otherwise finds out it is selling at a loss when the
                statement arrives.
              */}
              {chosenPartner &&
                !chosenPartner.lapsed &&
                chosenPartner.billing === 'ORIGIN_PAYS' &&
                selected.length > 0 && (
                  <View style={s.priceBox}>
                    <Text style={s.priceHeading}>What {chosenPartner.label} will charge us</Text>
                    {partnerPrices === null ? (
                      <Text style={s.muted}>Checking their price list…</Text>
                    ) : (
                      selected.map((t) => {
                        const theirs = partnerPrices[t.code.trim().toUpperCase()] ?? null;
                        return (
                          <Text key={t.id} style={s.muted}>
                            {t.name} — {theirs === null ? 'their price unknown' : `they charge ${theirs}`}
                            {' · '}
                            {t.sellingPrice === null
                              ? 'we have no price set'
                              : `we charge ${t.sellingPrice}`}
                          </Text>
                        );
                      })
                    )}
                  </View>
                )}

              <Text style={s.muted}>
                The tests, your clinical details and the patient&rsquo;s name and date of birth are
                sent to that laboratory. Nothing else — no diagnosis, notes, allergies or other
                results. Their report comes back onto this request.
              </Text>
            </>
          )}

          {/*
            Tests we are about to bill for and cannot.

            Before the order is sent, where it can still be fixed. The same
            information used to arrive only afterwards, on a confirmation the
            doctor has already stopped reading — which is how a referral came
            back billed by the laboratory and not billed to the patient.

            A missing price is fixed where it is found, exactly as on the
            dispensing sheet.
          */}
          {unpriced.length > 0 && (
            <View style={s.unpricedBox}>
              <Text style={s.unpricedHeading}>
                No invoice will be raised for {unpriced.map((t) => t.name).join(', ')}
              </Text>
              <Text style={s.muted}>
                Nobody here has priced {unpriced.length === 1 ? 'it' : 'them'}. The
                {unpriced.length === 1 ? ' test' : ' tests'} will still be done.
              </Text>

              {canPrice ? (
                unpriced.map((t) => (
                  <View key={t.id} style={s.priceRow}>
                    <Text style={s.priceName} numberOfLines={1}>
                      {t.name}
                    </Text>
                    <TextInput
                      style={s.priceInput}
                      value={priceDraft[t.id] ?? ''}
                      onChangeText={(v) => setPriceDraft({ ...priceDraft, [t.id]: v })}
                      /*
                       * Their price as the placeholder, never as the value.
                       * Prefilling it would set every referral to zero margin
                       * without anybody deciding to, and `unitPrice` is
                       * captured — so it would be invisible afterwards.
                       */
                      placeholder={
                        partnerPrices?.[t.code.trim().toUpperCase()]
                          ? `they charge ${partnerPrices[t.code.trim().toUpperCase()]}`
                          : '0.00'
                      }
                      placeholderTextColor={theme.color.textSubtle}
                      keyboardType="decimal-pad"
                    />
                    <Button
                      label="Set"
                      size="sm"
                      busy={pricing === t.id}
                      disabled={!(priceDraft[t.id] ?? '').trim()}
                      onPress={() => void setPrice(t.id)}
                    />
                  </View>
                ))
              ) : (
                <Text style={s.muted}>
                  An administrator or the laboratory can set a price under Test catalogue.
                </Text>
              )}
            </View>
          )}

          {destination === 'EXTERNAL' && (
            <Text style={s.muted}>
              It will not appear on our worklist, and the result has to be typed in when it arrives.
            </Text>
          )}
        </Card>

        <Button
          label={busy ? 'Requesting…' : destination === 'PARTNER' ? 'Request and send' : 'Request'}
          disabled={!valid || busy}
          onPress={() => void submit()}
        />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), gap: theme.space(2), paddingBottom: theme.space(10) },
  emptyTitle: { ...theme.font.bodyStrong, color: theme.color.text, marginBottom: theme.space(1) },
  muted: { ...theme.font.caption, color: theme.color.textMuted, lineHeight: 16 },
  overline: {
    ...theme.font.overline,
    color: theme.color.textSubtle,
    textTransform: 'uppercase',
    marginBottom: theme.space(0.5),
  },
  prep: { backgroundColor: theme.color.warningSoft, gap: theme.space(0.5) },
  testRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(1),
    paddingVertical: theme.space(1.5),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  testRowOn: { backgroundColor: theme.color.primarySoft },
  tick: { ...theme.font.caption, color: theme.color.primary, width: 14 },
  code: { ...theme.font.caption, color: theme.color.textMuted, width: 56 },
  testName: { ...theme.font.body, color: theme.color.text, flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(1), marginBottom: theme.space(1) },
  chip: {
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(1),
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  chipOn: { borderColor: theme.color.primary, backgroundColor: theme.color.primarySoft },
  chipDisabled: { opacity: 0.4 },
  priceBox: {
    marginTop: theme.space(2),
    padding: theme.space(2),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSunken,
    gap: theme.space(1),
  },
  priceHeading: { ...theme.font.caption, fontWeight: '700', color: theme.color.text },
  unpricedBox: {
    marginTop: theme.space(3),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.warning,
    gap: theme.space(2),
  },
  unpricedHeading: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space(2) },
  priceName: { ...theme.font.caption, color: theme.color.text, flex: 1 },
  priceInput: {
    ...theme.font.caption,
    width: 110,
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(1),
    backgroundColor: theme.color.surface,
  },
  payerPatient: {
    ...theme.font.caption,
    color: theme.color.primary,
    fontWeight: '700',
    marginTop: theme.space(2),
  },
  payerHospital: { ...theme.font.caption, color: theme.color.textMuted, marginTop: theme.space(2) },
  payerWarn: { ...theme.font.caption, color: theme.color.warning, marginTop: theme.space(2) },
  chipOff: { opacity: 0.4 },
  chipText: { ...theme.font.caption, color: theme.color.textMuted },
  chipTextOn: { color: theme.color.primary, fontWeight: '600' },
});
