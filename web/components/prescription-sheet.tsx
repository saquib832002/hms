'use client';

import { openDocument } from '@/lib/documents';
import { estimateQuantity } from '@/lib/course-quantity';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type {
  Allergy,
  Medicine,
  Patient,
  PharmacyPartner,
  Prescription,
  PrescribingShortcut,
  PrescriptionDestination,
} from '@/lib/types';
import { dateTime, titleCase } from '@/lib/format';
import {
  Button,
  Field,
  Input,
  SectionLabel,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { AllergyBanner } from '@/components/allergy-banner';

export interface Item {
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  /** Units to hand over. Blank means open-ended — see the field's own note. */
  quantity: string;
  /**
   * Has the prescriber typed in the quantity box themselves?
   *
   * Until they do, the box follows the dosage, frequency and duration as they
   * are typed. Once they do, it stops moving: a doctor who means something
   * other than the arithmetic — a spare inhaler, a split pack, the tablets the
   * patient already has at home — must not have a number reappear over the top
   * of theirs because they went back and fixed a typo in the duration.
   *
   * Optional so callers constructing `Item` literals do not have to think about
   * it; absent means untouched, which is the right default for a fresh line.
   */
  quantityTouched?: boolean;
}

const EMPTY: Item = { medicineName: '', dosage: '', frequency: '', duration: '', quantity: '' };

/**
 * A side sheet, not a dialog — clinical forms need the room, and the patient
 * header stays pinned so the doctor cannot lose track of who they are
 * prescribing for.
 */
export function PrescriptionSheet({
  open,
  onClose,
  patientId,
  patientName,
  onSaved,
  initialItems,
}: {
  open: boolean;
  onClose: () => void;
  patientId: number;
  patientName: string;
  onSaved: () => void;
  /**
   * Lines carried over from a prescription that was just cancelled.
   *
   * A doctor withdrawing one almost always means "that was nearly right" — a
   * wrong dose, a wrong duration. Making them retype the four correct lines to
   * fix one is how a correction gets skipped, and a wrong prescription left
   * standing because fixing it was tedious is the failure that matters.
   */
  initialItems?: Item[];
}) {
  const [items, setItems] = useState<Item[]>([{ ...EMPTY }]);
  const [notes, setNotes] = useState('');
  const [allergies, setAllergies] = useState<Allergy[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  /*
   * Where this prescription is meant to be filled.
   *
   * Defaults to the hospital's own pharmacy, so the common case is one tap with
   * nothing to think about and sending it elsewhere is a deliberate act. A
   * clinic with no pharmacy never sees the choice — every prescription is
   * external and there is nothing to decide.
   */
  const [destination, setDestination] = useState<PrescriptionDestination>('IN_HOUSE');
  const [partnerId, setPartnerId] = useState('');
  const [partners, setPartners] = useState<PharmacyPartner[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /**
   * The issued prescription, plus the referral if it was sent to a partner.
   *
   * Widened here rather than on `Prescription` itself: the referral is
   * something the *create* call returns once, not a field the prescription
   * carries afterwards. Putting it on the shared type would imply every read
   * of a prescription tells you where it went, which it does not.
   */
  const [issued, setIssued] = useState<
    (Prescription & { referral?: { reference: string; pharmacy: string } | null }) | null
  >(null);
  /*
   * The doctor's own shortcuts, and the catalogue.
   *
   * Both fetched once when the sheet opens rather than per keystroke: the
   * catalogue is a few hundred rows at most, and a request on every character
   * would make the field feel worse than the typing it replaces.
   */
  const [shortcuts, setShortcuts] = useState<PrescribingShortcut[]>([]);
  const [presets, setPresets] = useState<{ frequencies: string[]; durations: string[] }>({
    frequencies: [],
    durations: [],
  });
  const [catalogue, setCatalogue] = useState<Medicine[]>([]);
  /**
   * This patient's earlier prescriptions, newest first, for reference while
   * writing. `null` until loaded; `[]` means genuinely none.
   */
  const [history, setHistory] = useState<Prescription[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Which row's medicine field is open, so only one dropdown shows at a time. */
  const [openRow, setOpenRow] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      setItems([{ ...EMPTY }]);
      setNotes('');
      setError(null);
      setIssued(null);
      setDestination('IN_HOUSE');
      setPartnerId('');
      return;
    }
    // Pre-fill before anything else, so a rewrite opens on the old lines
    // rather than blank fields that fill in a moment later.
    setItems(initialItems?.length ? initialItems.map((i) => ({ ...i })) : [{ ...EMPTY }]);

    api<Patient>(`/patients/${patientId}`)
      .then((p) => setAllergies(p.allergies))
      .catch(() => setAllergies(undefined));

    /*
     * What this patient was prescribed before, shown while writing.
     *
     * A repeat is written *because* of what came before — the dose that
     * worked, the one that did not, the course that needs another month. A
     * doctor who has to close the sheet, read the history tab, remember four
     * lines and reopen is a doctor who will retype them from memory, and
     * memory is where dosing errors come from.
     *
     * It is the same data the Prescriptions tab shows, so it grants nothing
     * new — the server decides what a doctor may read, and this is a read they
     * already had. What changes is that it is in front of them at the moment
     * of the decision.
     *
     * Fails quietly: history is context, not a precondition, and refusing to
     * let somebody prescribe because a convenience request failed would be the
     * wrong trade in a consultation.
     */
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => setHistory(r.data))
      .catch(() => setHistory([]));

    // Empty for a hospital with no partners, which is the normal case — the
    // choice then collapses to "our pharmacy" or "the patient takes it away".
    api<{ data: PharmacyPartner[] }>('/pharmacy-partners')
      .then((r) => setPartners(r.data))
      .catch(() => setPartners([]));

    /*
     * Both fail quietly. Shortcuts and type-ahead make prescribing faster; if
     * either request fails the fields still work exactly as they did before,
     * and blocking a consultation because a convenience did not load would be
     * a poor trade.
     */
    api<{ shortcuts: PrescribingShortcut[]; frequencies: string[]; durations: string[] }>(
      '/me/prescribing',
    )
      .then((r) => {
        setShortcuts(r.shortcuts);
        setPresets({ frequencies: r.frequencies, durations: r.durations });
      })
      .catch(() => undefined);

    api<{ data: Medicine[] }>('/medicines')
      .then((r) => setCatalogue(r.data))
      .catch(() => setCatalogue([]));
  }, [open, patientId, initialItems]);

  /**
   * Edit one field, and keep the quantity in step with the three it derives
   * from.
   *
   * The quantity used to be a link the prescriber clicked — "Use 14 for this
   * course" — which is a step nobody should have to take for arithmetic the
   * form can do. It fills in as they type instead.
   *
   * Two rules make that safe rather than merely convenient:
   *
   *  - It stops the moment the prescriber types in the box. Their number is a
   *    decision; recomputing over it would silently overwrite it when they went
   *    back to fix an unrelated typo.
   *  - It only ever writes a number the arithmetic is sure of. Where the dosage
   *    is a strength, or the course is open-ended, the box is left empty and the
   *    field says which part could not be read — see `course-quantity.ts` for
   *    why an approximate answer would be worse than none.
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

  /**
   * Client-side allergy hint, shown as the doctor types.
   *
   * Substring matching only — it catches "Penicillin V" against a penicillin
   * allergy and misses "Amoxicillin", which is a penicillin sharing no
   * substring. The server runs the same check and returns authoritative
   * warnings on save. Neither blocks the prescription in Phase 1; making an
   * unreliable check look authoritative would be worse than not having it.
   */
  /**
   * Fill the first empty row, or add one.
   *
   * Not "replace whatever is focused": a doctor part-way through typing row two
   * would lose it. Filling the first blank row and otherwise appending is what
   * somebody tapping a chip expects.
   */
  function applyShortcut(sc: PrescribingShortcut) {
    const units = estimateQuantity(sc.dosage, sc.frequency, sc.duration).units;
    const line: Item = {
      medicineName: sc.medicineName,
      dosage: sc.dosage,
      frequency: sc.frequency,
      duration: sc.duration,
      /*
       * Computed from the shortcut's own three fields, exactly as if they had
       * been typed. A shortcut records what this doctor writes often, and the
       * quantity follows from it — leaving the box blank here would make the
       * one-tap path the only one that still needs the number entered by hand.
       */
      quantity: units === null ? '' : String(units),
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
  }

  const localWarnings = (medicineName: string) => {
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
    setSubmitting(true);
    setError(null);
    try {
      const created = await api<Prescription & { referral?: { reference: string; pharmacy: string } | null }>(
        '/prescriptions',
        {
          method: 'POST',
          body: {
            patientId,
            /*
             * `quantity` is a string in the form and an optional integer on the
             * wire — blank means the prescriber left the course open-ended, and
             * must be omitted rather than sent as 0. Zero would read on the
             * counter as "nothing to dispense", which is the opposite.
             */
            items: items.map(({ quantity, quantityTouched: _touched, ...rest }) => ({
              ...rest,
              ...(quantity.trim() ? { quantityPrescribed: Number(quantity) } : {}),
            })),
            notes: notes || undefined,
            destination,
            partnerId: destination === 'PARTNER' ? Number(partnerId) : undefined,
          },
        },
      );
      setIssued(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the prescription');
    } finally {
      setSubmitting(false);
    }
  }

  if (issued) {
    return (
      <Sheet
        open={open}
        onClose={() => {
          setIssued(null);
          onSaved();
        }}
        title="Prescription issued"
        footer={
          <>
            <Button variant="primary" onClick={() => void openDocument('prescriptions', issued.id)}>
              Print
            </Button>
            <Button
              onClick={() => {
                setIssued(null);
                onSaved();
              }}
            >
              Done
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Prescription <span className="font-mono">#{issued.id}</span> issued for{' '}
          <strong>{patientName}</strong>.
        </p>

        {/* The reference is the whole point of a partner send: it is what the
            patient reads out at the other counter. Shown prominently because
            they have to write it down or be told it. */}
        {issued.referral && (
          <div className="mt-3 rounded-md border border-primary bg-primary-soft px-3 py-2.5">
            <p className="text-sm text-text">
              Sent to <strong>{issued.referral.pharmacy}</strong>. The patient quotes:
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tracking-widest text-primary">
              {issued.referral.reference}
            </p>
          </div>
        )}

        {issued.allergyWarnings && issued.allergyWarnings.length > 0 && (
          <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
            <strong>Allergy warnings recorded.</strong>
            <ul className="mt-1 list-inside list-disc text-xs">
              {issued.allergyWarnings.map((w, i) => (
                <li key={i}>
                  {w.matchedMedicine} matches a recorded {titleCase(w.severity)} allergy to{' '}
                  {w.substance}
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className="mt-3 space-y-1">
          {issued.items.map((i) => (
            <li key={i.id} className="font-mono text-xs">
              {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New prescription"
      footer={
        <>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting
              ? 'Issuing…'
              : destination === 'PARTNER'
                ? 'Issue and send'
                : 'Issue prescription'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {/* States the consequence rather than saying "Submit". */}
          <span className="text-xxs leading-tight text-text-muted">
            Cannot be edited
            <br />
            once dispensed
          </span>
        </>
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{patientName}</div>
        <div className="font-mono text-xs text-text-muted">#{patientId}</div>
      </div>

      <div className="mt-2.5">
        <AllergyBanner allergies={allergies} />
      </div>

      {/*
        One tap for a line this doctor writes constantly.
        ------------------------------------------------
        Prescribing is repetitive to a degree that makes free text an odd
        default — the same clinician writes the same handful of lines most days.
        These are their own past prescriptions, ranked by how often they write
        them, so a repeat costs one tap instead of four fields.

        Nothing here suggests a medicine the doctor has not used. That is a
        property, not a shortfall: recall is a different thing from advice, and
        proposing a treatment is clinical decision support — regulated, and in
        need of validation rather than a plausible ranking.
      */}
      {shortcuts.length > 0 && (
        <>
          <SectionLabel>You prescribe these often</SectionLabel>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {shortcuts.slice(0, 8).map((sc, n) => (
              <button
                key={n}
                onClick={() => applyShortcut(sc)}
                className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs hover:border-primary hover:bg-primary-soft"
              >
                <span className="font-medium">{sc.medicineName}</span>{' '}
                <span className="text-text-muted">
                  {sc.dosage} · {sc.frequency} · {sc.duration}
                </span>
                <span className="ml-1 text-text-subtle">×{sc.timesPrescribed}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/*
        This patient's earlier prescriptions.
        -------------------------------------
        Distinct from the shortcuts above, which are what *this doctor* writes
        most often across everybody. This is what *this patient* was actually
        given, which is the thing a repeat is a response to.

        Collapsed by default so the common case — a fresh prescription during a
        consultation — is not pushed down the sheet, and expanded in one click
        when the question is "what were they on?". "Use these" copies the lines
        in rather than making somebody retype a dose they can see, which is
        where transcription errors come from.
      */}
      {history !== null && history.length > 0 && (
        <div className="mb-3 rounded-md border border-border bg-bg">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
          >
            <span className="font-medium text-text">Previous prescriptions</span>
            <span className="text-xs text-text-subtle">{history.length}</span>
            <span className="ml-auto text-xs text-primary">
              {historyOpen ? 'Hide' : 'Show'}
            </span>
          </button>

          {historyOpen && (
            <div className="scroll-thin max-h-56 overflow-y-auto border-t border-border">
              {history.slice(0, 10).map((p) => (
                <div key={p.id} className="border-b border-border px-3 py-2 last:border-b-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-text-muted">{dateTime(p.issuedAt)}</span>
                    {/* A cancelled prescription is shown, not hidden: "we
                        stopped that one" is exactly the context a doctor
                        needs, and its absence would read as never prescribed. */}
                    {p.status === 'CANCELLED' && (
                      <span className="text-xxs uppercase text-danger">cancelled</span>
                    )}
                    {p.dispensedAt && (
                      <span className="text-xxs uppercase text-text-subtle">dispensed</span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setItems(
                          p.items.map((i) => ({
                            medicineName: i.medicineName,
                            dosage: i.dosage,
                            frequency: i.frequency,
                            duration: i.duration,
                            /*
                             * A quantity somebody actually ordered last time is
                             * a decision, so it is treated as hand-entered and
                             * the arithmetic leaves it alone. Where the old
                             * prescription carried none, the box is open and
                             * fills itself from the copied fields.
                             */
                            quantity: i.quantityPrescribed
                              ? String(i.quantityPrescribed)
                              : String(
                                  estimateQuantity(i.dosage, i.frequency, i.duration).units ?? '',
                                ),
                            quantityTouched: i.quantityPrescribed != null,
                          })),
                        )
                      }
                      className="ml-auto text-xs text-primary hover:underline"
                    >
                      Use these
                    </button>
                  </div>
                  <ul className="mt-0.5">
                    {p.items.map((i) => (
                      <li key={i.id} className="font-mono text-xs text-text">
                        {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <SectionLabel>Medicines</SectionLabel>

      {items.map((item, i) => {
        const warnings = localWarnings(item.medicineName);
        return (
          <div key={i} className="mb-2.5 rounded-sm border border-border bg-[#fcfcfd] p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xxs font-semibold uppercase tracking-wider text-text-subtle">
                Medicine {i + 1}
              </span>
              {items.length > 1 && (
                <button
                  onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-xs text-danger hover:underline"
                >
                  Remove
                </button>
              )}
            </div>

            <Field label="Medicine" required>
              <div className="relative">
                <Input
                  value={item.medicineName}
                  onChange={(e) => {
                    setItem(i, 'medicineName', e.target.value);
                    setOpenRow(i);
                  }}
                  onFocus={() => setOpenRow(i)}
                  /* Blur is delayed so a click on a suggestion lands before the
                     list unmounts — the classic combobox bug where selecting an
                     option does nothing. */
                  onBlur={() => setTimeout(() => setOpenRow((r) => (r === i ? null : r)), 150)}
                  className={warnings.length ? 'border-danger' : ''}
                  autoComplete="off"
                  placeholder="Type two letters"
                />
                {openRow === i && (
                  <MedicineSuggestions
                    query={item.medicineName}
                    catalogue={catalogue}
                    onPick={(m) => {
                      setItem(i, 'medicineName', m.name);
                      // Strength comes from the catalogue entry, so the dosage
                      // field starts from the real product rather than blank.
                      if (!item.dosage.trim()) setItem(i, 'dosage', m.strength);
                      setOpenRow(null);
                    }}
                  />
                )}
              </div>
            </Field>

            {warnings.length > 0 && (
              <div className="mb-2.5 rounded-sm border border-[#ecdca6] bg-warning-soft px-2.5 py-2 text-xs text-[#6b5314]">
                <strong>⚠ Possible allergy conflict.</strong> This patient has a recorded{' '}
                {warnings.map((w) => `${titleCase(w.severity)} allergy to ${w.substance}`).join(', ')}
                . Verify before issuing.
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Dosage" required>
                <Input value={item.dosage} onChange={(e) => setItem(i, 'dosage', e.target.value)} placeholder="5 mg" />
              </Field>
              <Field label="Frequency" required>
                <Input
                  value={item.frequency}
                  onChange={(e) => setItem(i, 'frequency', e.target.value)}
                  placeholder="Once daily"
                />
                {/* This doctor's own shorthand, not a fixed list. "TDS" here is
                    "TID" elsewhere and "1-1-1" elsewhere again — a hard-coded
                    set would be wrong somewhere and noise everywhere else. */}
                <Chips
                  values={presets.frequencies}
                  onPick={(v) => setItem(i, 'frequency', v)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Duration" required>
                <Input
                  value={item.duration}
                  onChange={(e) => setItem(i, 'duration', e.target.value)}
                  placeholder="30 days"
                />
                <Chips values={presets.durations} onPick={(v) => setItem(i, 'duration', v)} />
              </Field>

              {/*
                The number the pharmacy dispenses against, and the reason this
                field exists at all.

                Before it, nothing recorded how much the doctor was ordering —
                the system inferred it from the frequency and duration text and
                used that inference to decide whether the prescription had been
                fully dispensed. An unrecognised duration meant the inference
                failed, and the prescription stayed "partially dispensed"
                permanently, with the medicine already in the patient's hand.
              */}
              <QuantityField
                item={item}
                onChange={(v) => setItem(i, 'quantity', v)}
                onRecalculate={() =>
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
                  )
                }
              />
            </div>
          </div>
        );
      })}

      <Button className="w-full" onClick={() => setItems((prev) => [...prev, { ...EMPTY }])}>
        + Add medicine
      </Button>

      {/*
        Where it goes. A routing note, not an authorisation.
        ---------------------------------------------------
        Marking it external does not stop this hospital's pharmacy dispensing
        it if the patient turns up — people change their minds, and the
        pharmacist can open it either way. What it changes is whose queue it
        appears in, so a prescription being filled elsewhere stops reading as
        work nobody is doing.
      */}
      <SectionLabel>Where it will be filled</SectionLabel>
      <Select
        value={destination}
        onChange={(e) => setDestination(e.target.value as PrescriptionDestination)}
      >
        <option value="IN_HOUSE">Our pharmacy</option>
        <option value="EXTERNAL">Patient takes it away</option>
        {partners.length > 0 ? (
          <option value="PARTNER">Send to a partner pharmacy</option>
        ) : (
          /*
           * Shown disabled rather than omitted, because a missing option is
           * indistinguishable from a feature that does not exist. Reported
           * from use: an administrator switched on "accept prescriptions from
           * other hospitals" at the receiving end, then looked here and saw
           * two options, with nothing to say the setup was half done.
           *
           * Sending needs both sides — they agree to receive, *and* this
           * hospital adds them. This says which half is missing.
           */
          <option value="PARTNER" disabled>
            Send to a partner pharmacy — none added yet
          </option>
        )}
      </Select>

      {partners.length === 0 && (
        <p className="mt-1.5 text-xs text-text-subtle">
          Sending to another hospital&rsquo;s pharmacy needs them to accept external prescriptions
          <em> and</em> an administrator here to add them under{' '}
          <strong>Partner pharmacies</strong>, using the code that pharmacy gives you.
        </p>
      )}

      {destination === 'PARTNER' && (
        <>
          <Select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className="mt-1.5">
            <option value="">Choose a pharmacy…</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
          {/* Said at the moment of choosing, because this is the point at which
              patient data leaves the hospital. Only the medicines, the
              prescriber and the patient's name and date of birth are sent —
              no diagnosis, no notes, no allergies. */}
          <p className="mt-1.5 text-xs text-text-subtle">
            The medicines, your name and the patient&rsquo;s name and date of birth are sent to
            that pharmacy. Nothing else — no diagnosis, notes or allergies. They cannot run an
            allergy check, and are told so.
          </p>
        </>
      )}

      {destination === 'EXTERNAL' && (
        <p className="mt-1.5 text-xs text-text-subtle">
          Print it for the patient. It will not appear in our dispensing queue — but our pharmacy
          can still fill it if they come back.
        </p>
      )}

      <SectionLabel>Instructions</SectionLabel>
      <Textarea
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional instructions for the patient…"
      />

      {error && (
        <div role="alert" className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]">
          {error}
        </div>
      )}
    </Sheet>
  );
}

/**
 * The number the pharmacy dispenses against.
 *
 * WHY THE FIELD EXISTS
 * --------------------
 * Before it, nothing recorded how much the doctor was ordering. The system
 * inferred a total from the frequency and duration text and used that inference
 * to decide whether a prescription had been fully dispensed — so an unfamiliar
 * duration meant the inference failed, and the prescription read "partially
 * dispensed" permanently with the medicine already in the patient's hand.
 *
 * WHY IT FILLS ITSELF IN, AND WHERE IT STOPS
 * ------------------------------------------
 * It is arithmetic the form can do, and asking a prescriber to click a link to
 * perform a multiplication is a step for nothing. But the same property that
 * makes a prefill useful makes it dangerous: it will be trusted and skimmed
 * rather than checked. So it appears only where the sum is certain, and where
 * it is not, the field says which part it could not read instead of guessing.
 *
 * The reason is shown rather than swallowed because an empty box and a
 * considered refusal look identical, and only one of them tells the prescriber
 * what to do next.
 */
function QuantityField({
  item,
  onChange,
  onRecalculate,
}: {
  item: Item;
  onChange: (v: string) => void;
  onRecalculate: () => void;
}) {
  const estimate = estimateQuantity(item.dosage, item.frequency, item.duration);
  // Nothing has been typed yet, so a note about what cannot be computed would
  // just be noise on a blank row.
  const started = Boolean(item.dosage.trim() || item.frequency.trim() || item.duration.trim());
  const auto = !item.quantityTouched && estimate.units !== null;

  return (
    <Field
      label="Quantity"
      hint="Units to hand over. Leave blank for an as-needed or ongoing course — the pharmacist closes those."
    >
      <Input
        type="number"
        min={1}
        max={1000}
        value={item.quantity}
        onChange={(e) => onChange(e.target.value)}
        placeholder="open"
      />

      {auto && (
        /* Shows the working, so the number is checkable at a glance rather than
           being a figure that simply appeared. */
        <p className="mt-1 text-xxs text-text-subtle">
          Calculated from the dosage, frequency and duration. Type over it to change it.
        </p>
      )}

      {item.quantityTouched && estimate.units !== null && String(estimate.units) !== item.quantity && (
        <button
          type="button"
          onClick={onRecalculate}
          className="mt-1 text-xxs text-primary hover:underline"
        >
          Recalculate ({estimate.units})
        </button>
      )}

      {!item.quantityTouched && estimate.units === null && started && (
        <p className="mt-1 text-xxs text-text-subtle">{estimate.reason}</p>
      )}
    </Field>
  );
}

/**
 * Type-ahead over the catalogue.
 *
 * Filtered in the browser against a list already in memory, so it responds on
 * the keystroke rather than on a round trip. A few hundred medicines is nothing
 * to filter; a request per character is the thing that makes an autocomplete
 * feel worse than typing.
 *
 * Two characters before anything appears: one letter matches most of the
 * catalogue, which is a dropdown nobody reads.
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
     * wants Amoxicillin above Co-amoxiclav, and pure `includes` ordering buries
     * the obvious answer under the alphabet.
     */
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, 8);

  if (matches.length === 0) {
    return (
      <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-subtle shadow-lg">
        {/* Not an error. Free text is still valid — the catalogue is for speed
            and stock checking, not a whitelist of what may be prescribed. */}
        Nothing in the catalogue matches. You can still type it in full.
      </div>
    );
  }

  return (
    <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
      {matches.map((m) => (
        <button
          key={m.id}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(m)}
          className="flex w-full items-baseline justify-between border-b border-[#f0f2f4] px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-primary-soft"
        >
          <span>
            <span className="font-medium">{m.name}</span>{' '}
            <span className="font-mono text-xs text-text-muted">{m.strength}</span>
          </span>
          <span className="text-xxs text-text-subtle">{m.form}</span>
        </button>
      ))}
    </div>
  );
}

/** Tap-to-fill values, hidden entirely when there are none to offer. */
function Chips({ values, onPick }: { values: string[]; onPick: (v: string) => void }) {
  if (values.length === 0) return null;
  return (
    <div className="-mt-1.5 mb-2.5 flex flex-wrap gap-1">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className="rounded-full border border-border px-2 py-0.5 text-xxs text-text-muted hover:border-primary hover:text-primary"
        >
          {v}
        </button>
      ))}
    </div>
  );
}
