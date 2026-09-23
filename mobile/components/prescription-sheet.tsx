import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { shareDocument } from '@/lib/documents';
import { api, ApiError } from '@/lib/api';
import { theme } from '@/lib/theme';
import { date, titleCase } from '@/lib/format';
import { Button, Card, ErrorBanner } from './ui';
import { AllergyBanner } from './allergy-banner';
import type {
  Allergy,
  Medicine,
  PharmacyPartner,
  Prescription,
  PrescribingHistory,
  PrescribingShortcut,
  PrescriptionDestination,
} from '@/lib/types';
import { estimateQuantity } from '@/lib/course-quantity';

export interface Item {
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  /** Units to hand over. Blank means open-ended — the pharmacist closes it. */
  quantity: string;
  /**
   * Has the prescriber typed in the quantity box themselves?
   *
   * Until they do, it follows the dosage, frequency and duration as they type.
   * Once they do, it stops moving — a doctor who means something other than the
   * arithmetic must not have a number reappear over the top of theirs because
   * they went back and fixed a typo in the duration.
   */
  quantityTouched?: boolean;
}

const EMPTY: Item = { medicineName: '', dosage: '', frequency: '', duration: '', quantity: '' };

/**
 * Issue a prescription from the phone.
 *
 * This is the one genuinely creative act the mobile app allows, and it is here
 * because it is a real between-rounds task — a doctor finishing a consultation
 * on a ward should not have to walk back to a desk to prescribe.
 *
 * A full-screen modal rather than a bottom sheet: prescribing is not a glance,
 * and the patient header has to stay visible throughout. Getting the wrong
 * patient is the mistake this layout is guarding against.
 */
export function PrescriptionSheet({
  visible,
  initialItems,
  patientId,
  patientName,
  allergies,
  onClose,
  onIssued,
}: {
  visible: boolean;
  /**
   * Lines carried over from a prescription that was just cancelled.
   *
   * A doctor withdrawing one almost always means "that was nearly right" — a
   * wrong dose, a wrong duration. Retyping four correct lines to fix one is how
   * a correction gets skipped, and a wrong prescription left standing because
   * fixing it was tedious is the failure that matters.
   */
  initialItems?: Item[];
  patientId: number;
  patientName: string;
  allergies?: Allergy[];
  onClose: () => void;
  onIssued: () => void;
}) {
  const [items, setItems] = useState<Item[]>([{ ...EMPTY }]);
  const [notes, setNotes] = useState('');

  /*
   * Where the prescription is meant to be filled.
   *
   * Defaults to this hospital's own pharmacy, so the ordinary case costs
   * nothing and sending it elsewhere is deliberate. A routing note, never an
   * authorisation — the pharmacy here can still fill an external one if the
   * patient turns up.
   */
  const [destination, setDestination] = useState<PrescriptionDestination>('IN_HOUSE');
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const [partners, setPartners] = useState<PharmacyPartner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<
    (Prescription & { referral?: { reference: string; pharmacy: string } | null }) | null
  >(null);
  /** Producing the PDF. Its own state so the button can say it is working. */
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  /*
   * The doctor's own shortcuts and the catalogue, both fetched once when the
   * sheet opens. A request per keystroke would make the field feel worse than
   * the typing it is meant to replace, and a phone is where that shows.
   */
  const [history, setHistory] = useState<PrescribingHistory | null>(null);
  const [catalogue, setCatalogue] = useState<Medicine[]>([]);
  /**
   * This patient's earlier prescriptions. Named apart from `history`, which
   * holds the doctor's own prescribing shortcuts — two different meanings of
   * "history" in one component is how the wrong one gets rendered.
   */
  const [pastRx, setPastRx] = useState<Prescription[] | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  /** Which row's medicine field is being typed into. One list at a time. */
  const [openRow, setOpenRow] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) {
      setItems([{ ...EMPTY }]);
      setNotes('');
      setError(null);
      setIssued(null);
      setOpenRow(null);
      setDestination('IN_HOUSE');
      setPartnerId(null);
      return;
    }

    // Quiet failure like the two below: a hospital with no partners simply
    // never sees the third option.
    api<{ data: PharmacyPartner[] }>('/pharmacy-partners')
      .then((r) => setPartners(r.data))
      .catch(() => setPartners([]));

    /*
     * Both fail quietly. These make prescribing faster; if either request fails
     * the fields work exactly as they did before, and blocking a consultation
     * because a convenience did not load would be a poor trade.
     */
    // Pre-fill first, so a rewrite opens on the old lines rather than blank
    // fields that populate a moment later.
    setItems(initialItems?.length ? initialItems.map((i) => ({ ...i })) : [{ ...EMPTY }]);

    api<PrescribingHistory>('/me/prescribing')
      .then(setHistory)
      .catch(() => undefined);

    /*
     * What *this patient* was prescribed before — distinct from the shortcuts
     * above, which are what this doctor writes most often across everybody.
     *
     * A repeat is a response to what came before: the dose that worked, the
     * course that needs another month. Without it in front of them a doctor
     * retypes from memory, and memory is where dosing errors come from.
     *
     * Grants nothing new — it is the same read the patient screen already
     * has — and fails quietly, because history is context rather than a
     * precondition for prescribing.
     */
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => setPastRx(r.data))
      .catch(() => setPastRx([]));
    api<{ data: Medicine[] }>('/medicines')
      .then((r) => setCatalogue(r.data))
      .catch(() => setCatalogue([]));
  }, [visible, initialItems]);

  /**
   * Fill the first empty row, or add one.
   *
   * Not "replace the focused row" — a doctor part-way through typing row two
   * would lose it. Filling the first blank and otherwise appending is what
   * tapping a chip looks like it should do.
   */
  const applyShortcut = (sc: PrescribingShortcut) => {
    const line: Item = {
      medicineName: sc.medicineName,
      dosage: sc.dosage,
      frequency: sc.frequency,
      duration: sc.duration,
      /*
       * Computed from the shortcut's own three fields, exactly as if they had
       * been typed. Leaving it blank here would make the one-tap path the only
       * one that still needed the number entered by hand.
       */
      quantity: String(estimateQuantity(sc.dosage, sc.frequency, sc.duration).units ?? ''),
    };
    setItems((prev) => {
      const blank = prev.findIndex(
        (it) => !it.medicineName.trim() && !it.dosage.trim() && !it.frequency.trim(),
      );
      if (blank === -1) return [...prev, line];
      const next = [...prev];
      next[blank] = line;
      return next;
    });
    setOpenRow(null);
  };

  /**
   * Edit one field, and keep the quantity in step with the three it derives
   * from.
   *
   * Identical rules to the web sheet, from the same shared arithmetic: the box
   * fills itself in as the prescriber types, stops the moment they type in it,
   * and stays empty wherever the sum is not certain. See `course-quantity.ts`
   * for why an approximate answer would be worse than none.
   */
  const setItem = (i: number, k: keyof Item, v: string) =>
    setItems((prev) =>
      prev.map((it, idx) => {
        if (idx !== i) return it;
        if (k === 'quantity') return { ...it, quantity: v, quantityTouched: true };

        const next = { ...it, [k]: v };
        if (it.quantityTouched) return next;
        if (k !== 'dosage' && k !== 'frequency' && k !== 'duration') return next;

        const units = estimateQuantity(next.dosage, next.frequency, next.duration).units;
        // Cleared rather than left stale when the sum stops working: a quantity
        // that no longer follows from the fields above it is the number most
        // likely to be dispensed against and least likely to be reread.
        return { ...next, quantity: units === null ? '' : String(units) };
      }),
    );

  /** Hand the quantity back to the arithmetic after it was typed over. */
  const recalculate = (i: number) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? {
              ...it,
              quantityTouched: false,
              quantity: String(
                estimateQuantity(it.dosage, it.frequency, it.duration).units ?? '',
              ),
            }
          : it,
      ),
    );

  /**
   * Substring match only — catches "Penicillin V" against a penicillin
   * allergy, misses "Amoxicillin" which is a penicillin sharing no substring.
   * The server runs the same check and returns authoritative warnings. Neither
   * blocks in Phase 2; an unreliable check presented as authoritative would be
   * worse than none, and the reliable version needs the Phase 4 drug catalogue.
   */
  const warningsFor = (medicineName: string) => {
    if (!allergies?.length || medicineName.trim().length < 3) return [];
    const med = medicineName.toLowerCase();
    return allergies.filter(
      (a) => med.includes(a.substance.toLowerCase()) || a.substance.toLowerCase().includes(med),
    );
  };

  const valid = items.every(
    (i) => i.medicineName.trim() && i.dosage.trim() && i.frequency.trim() && i.duration.trim(),
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await api<
        Prescription & { referral?: { reference: string; pharmacy: string } | null }
      >('/prescriptions', {
        method: 'POST',
        body: {
          patientId,
          /*
           * Blank quantity is omitted rather than sent as 0 — the prescriber
           * left the course open-ended, and zero would read at the counter as
           * "nothing to dispense", which is the opposite.
           */
          items: items.map(({ quantity, quantityTouched: _touched, ...rest }) => ({
            ...rest,
            ...(quantity.trim() ? { quantityPrescribed: Number(quantity) } : {}),
          })),
          notes: notes || undefined,
          destination,
          partnerId: destination === 'PARTNER' ? partnerId ?? undefined : undefined,
        },
      });
      setIssued(created);
      if (created.referral) {
        // The reference is the whole point of a partner send — the patient
        // reads it out at the other counter — so it gets an alert rather than
        // a line that can be scrolled past on a phone.
        Alert.alert(
          `Sent to ${created.referral.pharmacy}`,
          `The patient quotes this reference:\n\n${created.referral.reference}`,
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the prescription');
    } finally {
      setBusy(false);
    }
  }

  /*
   * `Modal` handled this with its `visible` prop. An overlay has to unmount
   * itself, or the patient screen sits permanently behind a full-screen cover.
   */
  if (!visible) return null;

  return (
    /*
     * An in-screen overlay, not a Modal.
     * ----------------------------------
     * `Modal` renders in its own native window above everything the navigator
     * draws, including the tab bar. Writing a prescription therefore removed
     * the whole tab bar and left one button on an otherwise bare screen — a
     * doctor mid-consultation could not reach their queue.
     *
     * An absolutely-filled View inside the screen covers the screen and nothing
     * else, so the bar stays where it is. The cost is that `onRequestClose`
     * (Android back) no longer fires, which is why Close is a real button
     * rather than an assumed gesture.
     */
    <View style={s.overlay} pointerEvents="auto">
      <KeyboardAvoidingView
        style={s.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.header}>
          <Text style={s.title}>{issued ? 'Prescription issued' : 'New prescription'}</Text>
          <Text style={s.close} onPress={onClose}>
            Close
          </Text>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={s.patient}>{patientName}</Text>
            <Text style={s.muted}>#{patientId}</Text>
          </Card>

          <AllergyBanner allergies={allergies} />

          {issued ? (
            <>
              <Card>
                <Text style={s.muted}>Reference</Text>
                <Text style={s.patient}>#{issued.id}</Text>
                {issued.items.map((i) => (
                  <Text key={i.id} style={s.itemLine}>
                    {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                  </Text>
                ))}
              </Card>

              {shareError && <ErrorBanner message={shareError} />}
              {issued.allergyWarnings && issued.allergyWarnings.length > 0 && (
                <View style={s.warn}>
                  <Text style={s.warnTitle}>Allergy warnings recorded</Text>
                  {issued.allergyWarnings.map((w, i) => (
                    <Text key={i} style={s.warnBody}>
                      {w.matchedMedicine} matches a {titleCase(w.severity)} allergy to {w.substance}
                    </Text>
                  ))}
                </View>
              )}

              <Text style={s.footnote}>
                Printing is on the web app — the patient copy comes from the front desk.
              </Text>
            </>
          ) : (
            <>
              {/*
                One tap for a line this doctor writes constantly.
                ------------------------------------------------
                Their own past prescriptions, ranked by how often they write
                them. Nothing here proposes a medicine they have not used —
                recall, not advice. Suggesting a treatment is clinical decision
                support, which is a regulated device and needs validation
                rather than a plausible ranking.
              */}
              {history && history.shortcuts.length > 0 && (
                <Card>
                  <Text style={s.itemIndex}>You prescribe these often</Text>
                  <View style={s.chips}>
                    {history.shortcuts.slice(0, 6).map((sc, n) => (
                      <Pressable key={n} style={s.shortcut} onPress={() => applyShortcut(sc)}>
                        <Text style={s.shortcutName}>{sc.medicineName}</Text>
                        <Text style={s.shortcutDetail}>
                          {sc.dosage} · {sc.frequency} · {sc.duration} ×{sc.timesPrescribed}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </Card>
              )}

              {/*
                What this patient was given before. Collapsed by default —
                the common case is a fresh prescription during a consultation,
                and a phone screen has no room to spare — and one tap away
                when the question is "what were they on?".

                "Use these" copies the lines in rather than making somebody
                retype a dose they can see, which is where transcription
                errors come from. A cancelled prescription is shown rather
                than hidden: "we stopped that one" is exactly the context
                being looked for, and omitting it reads as never prescribed.
              */}
              {pastRx !== null && pastRx.length > 0 && (
                <Card>
                  <Pressable onPress={() => setPastOpen((o) => !o)} style={s.pastHeader}>
                    <Text style={s.itemIndex}>Previous prescriptions ({pastRx.length})</Text>
                    <Text style={s.pastToggle}>{pastOpen ? 'Hide' : 'Show'}</Text>
                  </Pressable>

                  {pastOpen &&
                    pastRx.slice(0, 5).map((p) => (
                      <View key={p.id} style={s.pastRow}>
                        <View style={s.pastRowHead}>
                          <Text style={s.shortcutDetail}>
                            {date(p.issuedAt)}
                            {p.status === 'CANCELLED' ? ' · cancelled' : ''}
                            {p.dispensedAt ? ' · dispensed' : ''}
                          </Text>
                          <Pressable
                            onPress={() =>
                              setItems(
                                p.items.map((i) => ({
                                  medicineName: i.medicineName,
                                  dosage: i.dosage,
                                  frequency: i.frequency,
                                  duration: i.duration,
                                  /*
                                   * A quantity somebody actually ordered last
                                   * time is a decision, so it is treated as
                                   * hand-entered and the arithmetic leaves it
                                   * alone. Where the old prescription carried
                                   * none, it is computed from the copied
                                   * fields like any other line.
                                   */
                                  quantity: i.quantityPrescribed
                                    ? String(i.quantityPrescribed)
                                    : String(
                                        estimateQuantity(i.dosage, i.frequency, i.duration)
                                          .units ?? '',
                                      ),
                                  quantityTouched: i.quantityPrescribed != null,
                                })),
                              )
                            }
                          >
                            <Text style={s.pastToggle}>Use these</Text>
                          </Pressable>
                        </View>
                        {p.items.map((i) => (
                          <Text key={i.id} style={s.pastLine}>
                            {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                          </Text>
                        ))}
                      </View>
                    ))}
                </Card>
              )}

              {items.map((item, i) => {
                const warnings = warningsFor(item.medicineName);
                return (
                  <Card key={i}>
                    <View style={s.itemHeader}>
                      <Text style={s.itemIndex}>Medicine {i + 1}</Text>
                      {items.length > 1 && (
                        <Text
                          style={s.remove}
                          onPress={() => setItems((p) => p.filter((_, idx) => idx !== i))}
                        >
                          Remove
                        </Text>
                      )}
                    </View>

                    <TextInput
                      style={[s.input, warnings.length ? s.inputWarn : null]}
                      value={item.medicineName}
                      onChangeText={(v) => {
                        setItem(i, 'medicineName', v);
                        setOpenRow(i);
                      }}
                      onFocus={() => setOpenRow(i)}
                      placeholder="Medicine — type two letters"
                      placeholderTextColor={theme.color.textSubtle}
                      autoCapitalize="words"
                      autoCorrect={false}
                    />

                    {openRow === i && (
                      <MedicineSuggestions
                        query={item.medicineName}
                        catalogue={catalogue}
                        onPick={(m) => {
                          setItem(i, 'medicineName', m.name);
                          // Strength comes from the catalogue entry, so dosage
                          // starts from the real product rather than blank.
                          if (!item.dosage.trim()) setItem(i, 'dosage', m.strength);
                          setOpenRow(null);
                        }}
                      />
                    )}

                    {warnings.length > 0 && (
                      <View style={s.warn}>
                        <Text style={s.warnTitle}>⚠ Possible allergy conflict</Text>
                        <Text style={s.warnBody}>
                          Recorded{' '}
                          {warnings
                            .map((w) => `${titleCase(w.severity)} allergy to ${w.substance}`)
                            .join(', ')}
                          . Verify before issuing.
                        </Text>
                      </View>
                    )}

                    <TextInput
                      style={s.input}
                      value={item.dosage}
                      onChangeText={(v) => setItem(i, 'dosage', v)}
                      placeholder="Dosage (e.g. 5 mg)"
                      placeholderTextColor={theme.color.textSubtle}
                    />
                    <TextInput
                      style={s.input}
                      value={item.frequency}
                      onChangeText={(v) => setItem(i, 'frequency', v)}
                      placeholder="Frequency (e.g. Once daily)"
                      placeholderTextColor={theme.color.textSubtle}
                    />
                    {/* This doctor's own shorthand, not a fixed list. "TDS"
                        here is "TID" elsewhere and "1-1-1" elsewhere again. */}
                    <Chips
                      values={history?.frequencies ?? []}
                      onPick={(v) => setItem(i, 'frequency', v)}
                    />

                    <TextInput
                      style={s.input}
                      value={item.duration}
                      onChangeText={(v) => setItem(i, 'duration', v)}
                      placeholder="Duration (e.g. 30 days)"
                      placeholderTextColor={theme.color.textSubtle}
                    />
                    <Chips
                      values={history?.durations ?? []}
                      onPick={(v) => setItem(i, 'duration', v)}
                    />

                    {/*
                      The number the pharmacy dispenses against.

                      Before this field, nothing recorded how much was being
                      ordered: the server inferred a total from the frequency
                      and duration text and used that to decide whether the
                      prescription had been fully dispensed. An unrecognised
                      duration meant the inference failed, and the prescription
                      stayed "partially dispensed" permanently with the
                      medicine already in the patient's hand.

                      It fills itself in from the three fields above — typing a
                      multiplication on a phone keyboard is exactly the work a
                      form should be doing — and stops the moment the doctor
                      types in it. Where the sum is not certain it stays empty
                      and says which part it could not read, because a prefilled
                      number is trusted and skimmed rather than checked.
                    */}
                    <TextInput
                      style={s.input}
                      value={item.quantity}
                      onChangeText={(v) => setItem(i, 'quantity', v.replace(/[^0-9]/g, ''))}
                      placeholder="Quantity — blank for an ongoing course"
                      placeholderTextColor={theme.color.textSubtle}
                      keyboardType="number-pad"
                    />
                    <QuantityNote item={item} onRecalculate={() => recalculate(i)} />
                  </Card>
                );
              })}

              <Button
                label="+ Add medicine"
                variant="secondary"
                onPress={() => setItems((p) => [...p, { ...EMPTY }])}
                style={{ marginBottom: theme.space(3) }}
              />

              {/*
                Where it goes.

                The partner button used to be hidden when there were no
                partners, which reads as "this app cannot do that" rather than
                "nobody has set it up". An administrator switched the receiving
                side on and then found nothing had changed here, with nothing on
                screen to say which half was missing. Same fix as the web sheet.
              */}
              <Text style={s.sectionLabel}>Where it will be filled</Text>
              <View style={s.destRow}>
                <Button
                  label="Our pharmacy"
                  size="sm"
                  variant={destination === 'IN_HOUSE' ? 'primary' : 'secondary'}
                  onPress={() => setDestination('IN_HOUSE')}
                />
                <Button
                  label="Patient takes it"
                  size="sm"
                  variant={destination === 'EXTERNAL' ? 'primary' : 'secondary'}
                  onPress={() => setDestination('EXTERNAL')}
                />
                {partners.length > 0 && (
                  <Button
                    label="Partner"
                    size="sm"
                    variant={destination === 'PARTNER' ? 'primary' : 'secondary'}
                    onPress={() => setDestination('PARTNER')}
                  />
                )}
              </View>

              {partners.length === 0 && (
                <Text style={s.destHint}>
                  To send to another hospital&rsquo;s pharmacy, they switch on{' '}
                  <Text style={s.destHintStrong}>accept prescriptions from other hospitals</Text>{' '}
                  and an administrator here adds them under Partner pharmacies, on the web, using
                  the code that pharmacy gives you.
                </Text>
              )}

              {destination === 'PARTNER' && (
                <>
                  <View style={s.destRow}>
                    {partners.map((p) => (
                      <Button
                        key={p.id}
                        label={p.label}
                        size="sm"
                        variant={partnerId === p.id ? 'primary' : 'secondary'}
                        onPress={() => setPartnerId(p.id)}
                      />
                    ))}
                  </View>
                  {/* Said at the moment of choosing, because this is where
                      patient data leaves the hospital. */}
                  <Text style={s.destHint}>
                    Only the medicines, your name and the patient&rsquo;s name and date of birth
                    are sent. No diagnosis, notes or allergies — that pharmacy cannot run an
                    allergy check, and is told so.
                  </Text>
                </>
              )}

              {destination === 'EXTERNAL' && (
                <Text style={s.destHint}>
                  It will not appear in our dispensing queue. Our pharmacy can still fill it if
                  the patient comes back.
                </Text>
              )}

              <TextInput
                style={[s.input, s.notes]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Instructions for the patient (optional)"
                placeholderTextColor={theme.color.textSubtle}
                multiline
              />
            </>
          )}

          {error && <ErrorBanner message={error} />}
        </ScrollView>

        <View style={s.actions}>
          {issued ? (
            <View style={{ gap: 8 }}>
              {/*
                Handed over at the bedside, which is the case the phone is for.
                The share sheet covers printing, saving to Files and messaging
                it to the patient — all three of which the OS already does
                better than anything built here would.

                Downloaded with the Authorization header rather than opened as
                a URL: the access token is held in memory and is deliberately
                not a cookie, so a plain link comes back 401 and reads to the
                doctor as a missing prescription.
              */}
              <Button
                label={sharing ? 'Preparing…' : 'Share / print'}
                variant="secondary"
                disabled={sharing}
                onPress={async () => {
                  if (!issued) return;
                  setSharing(true);
                  try {
                    await shareDocument('prescriptions', issued.id);
                  } catch (e) {
                    setShareError(e instanceof Error ? e.message : 'Could not produce the PDF');
                  } finally {
                    setSharing(false);
                  }
                }}
              />
              <Button label="Done" onPress={onIssued} />
            </View>
          ) : (
            <>
              <Button
                label={busy ? 'Issuing…' : 'Issue prescription'}
                onPress={() => void submit()}
                disabled={!valid}
                busy={busy}
              />
              {/* States the consequence rather than saying "Submit". */}
              <Text style={s.consequence}>Cannot be edited once dispensed</Text>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  sectionLabel: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    textTransform: 'uppercase',
    marginBottom: theme.space(1),
  },
  destRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(1), marginBottom: theme.space(2) },
  destHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginBottom: theme.space(2),
  },
  /* Nested inside destHint, so it inherits size and colour and only adds
     weight — a full style here would reset the line height mid-sentence. */
  destHintStrong: { fontWeight: '600', color: theme.color.textMuted },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.color.bg,
    // Above the screen's own content, below the tab bar — which is drawn by the
    // navigator outside this view entirely.
    zIndex: 20,
    elevation: 20,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(1), marginBottom: theme.space(2) },
  chip: {
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(2),
    paddingVertical: 3,
  },
  chipText: { ...theme.font.caption, color: theme.color.textMuted },
  shortcut: {
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceSunken,
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(1),
  },
  shortcutName: { ...theme.font.caption, color: theme.color.text, fontWeight: '700' },
  shortcutDetail: { ...theme.font.caption, color: theme.color.textSubtle },
  pastHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pastToggle: { ...theme.font.caption, color: theme.color.primary, fontWeight: '600' },
  quantityNote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginTop: -theme.space(1),
    marginBottom: theme.space(1),
  },
  quantityAction: {
    ...theme.font.caption,
    color: theme.color.primary,
    fontWeight: '600',
    marginTop: -theme.space(1),
    marginBottom: theme.space(1),
  },
  pastRow: {
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    marginTop: theme.space(1.5),
    paddingTop: theme.space(1.5),
  },
  pastRowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /* Monospaced so a dose lines up between rows — the thing being compared is
     the number, and proportional digits make that harder than it needs to be. */
  pastLine: {
    ...theme.font.caption,
    color: theme.color.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  suggestions: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    marginBottom: theme.space(2),
    overflow: 'hidden',
  },
  suggestion: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(2),
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  suggestionName: { ...theme.font.body, color: theme.color.text },
  suggestionMeta: { ...theme.font.caption, color: theme.color.textSubtle },
  noMatch: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    marginBottom: theme.space(2),
  },
  root: { flex: 1, backgroundColor: theme.color.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(12),
    paddingBottom: theme.space(3),
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  title: { ...theme.font.title, color: theme.color.text },
  close: { ...theme.font.body, color: theme.color.primary },
  body: { padding: theme.space(3) },
  patient: { ...theme.font.heading, color: theme.color.text },
  muted: { ...theme.font.small, color: theme.color.textMuted },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: theme.space(2) },
  itemIndex: {
    ...theme.font.caption,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
  },
  remove: { ...theme.font.small, color: theme.color.danger },
  itemLine: { ...theme.font.body, color: theme.color.text, marginTop: 4 },
  input: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(3),
    minHeight: theme.touchTarget,
    ...theme.font.input,
    color: theme.color.text,
    marginBottom: theme.space(2),
  },
  inputWarn: { borderColor: theme.color.danger },
  notes: { minHeight: 90, textAlignVertical: 'top', paddingTop: theme.space(3) },
  warn: {
    backgroundColor: theme.color.warningSoft,
    borderWidth: 1,
    borderColor: 'rgba(255,182,39,0.45)',
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  warnTitle: { color: theme.color.warning, ...theme.font.small },
  warnBody: { color: theme.color.warning, ...theme.font.small, marginTop: 2, lineHeight: 18 },
  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(4),
  },
  actions: {
    padding: theme.space(3),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  consequence: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    textAlign: 'center',
    marginTop: theme.space(2),
  },
});

/**
 * Type-ahead over the catalogue.
 *
 * Filtered in memory against a list already fetched, so it responds on the
 * keystroke. Two characters before anything appears — one letter matches most
 * of a catalogue, which is a list nobody reads.
 */
function MedicineSuggestions({
  query,
  catalogue,
  onPick,
}: {
  query: string;
  catalogue: Medicine[];
  onPick: (m: Medicine) => void;
}) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;

  const matches = catalogue
    .filter((m) => m.name.toLowerCase().includes(q))
    /*
     * Names that *start* with what was typed come first. Someone typing "amo"
     * wants Amoxicillin above Co-amoxiclav, and plain `includes` ordering
     * buries the obvious answer under the alphabet.
     */
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, 6);

  if (matches.length === 0) {
    return (
      // Not an error. Free text remains valid — the catalogue is for speed and
      // stock checking, not a whitelist of what may be prescribed.
      <Text style={s.noMatch}>Nothing in the catalogue matches. You can still type it in full.</Text>
    );
  }

  return (
    <View style={s.suggestions}>
      {matches.map((m) => (
        <Pressable key={m.id} style={s.suggestion} onPress={() => onPick(m)}>
          <Text style={s.suggestionName}>
            {m.name} <Text style={s.suggestionMeta}>{m.strength}</Text>
          </Text>
          <Text style={s.suggestionMeta}>{m.form}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Tap-to-fill values, hidden entirely when there are none to offer. */
/**
 * What the quantity box is doing, in one line under it.
 *
 * Three states, and the third is the one that matters. When the number was
 * calculated it says so, because a figure that simply appears in a box invites
 * either blind trust or a puzzled recount. When it was typed over, it offers
 * the arithmetic back. And when no number could be produced it says which part
 * could not be read — an empty box and a considered refusal look identical, and
 * only one of them tells the prescriber what to do next.
 */
function QuantityNote({ item, onRecalculate }: { item: Item; onRecalculate: () => void }) {
  const estimate = estimateQuantity(item.dosage, item.frequency, item.duration);
  const started = Boolean(item.dosage.trim() || item.frequency.trim() || item.duration.trim());

  if (!started) return null;

  if (item.quantityTouched) {
    if (estimate.units === null || String(estimate.units) === item.quantity) return null;
    return (
      <Pressable onPress={onRecalculate}>
        <Text style={s.quantityAction}>Recalculate ({estimate.units})</Text>
      </Pressable>
    );
  }

  return (
    <Text style={s.quantityNote}>
      {estimate.units === null
        ? estimate.reason
        : 'Calculated from the dosage, frequency and duration. Type over it to change it.'}
    </Text>
  );
}

function Chips({ values, onPick }: { values: string[]; onPick: (v: string) => void }) {
  if (values.length === 0) return null;
  return (
    <View style={s.chips}>
      {values.map((v) => (
        <Pressable key={v} style={s.chip} onPress={() => onPick(v)}>
          <Text style={s.chipText}>{v}</Text>
        </Pressable>
      ))}
    </View>
  );
}
