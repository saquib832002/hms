'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { TaxRate } from '@/lib/types';
import type { DrugClass, Medicine } from '@/lib/types';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { titleCase } from '@/lib/format';

/**
 * Add a medicine to the catalogue, or correct one.
 *
 * WHY THIS EXISTS, AND WHY ITS ABSENCE WAS WORSE THAN IT LOOKED
 * ------------------------------------------------------------
 * `POST /medicines` and `PATCH /medicines/:id` were written, tested, and called
 * by nothing — they sat in `KNOWN_GAPS` for six phases. The consequence only
 * becomes obvious on a real deployment: a hospital that did not run the demo
 * seed has an empty catalogue, so "Receive stock" offers an empty dropdown and
 * the entire pharmacy is unusable. Nothing in the app said why.
 *
 * DRUG CLASS IS THE FIELD THAT MATTERS
 * ------------------------------------
 * It is what the allergy check runs against. `OTHER` is the safe default in one
 * narrow sense — it never produces a false conflict — but it never produces a
 * true one either, so a whole catalogue left on `OTHER` gives allergy checks
 * that run, report nothing, and look healthy. That is worse than no check at
 * all, because it is trusted. The form says so rather than leaving it to be
 * discovered.
 */

const DRUG_CLASSES: DrugClass[] = [
  'PENICILLIN',
  'CEPHALOSPORIN',
  'SULFONAMIDE',
  'MACROLIDE',
  'TETRACYCLINE',
  'QUINOLONE',
  'NSAID',
  'OPIOID',
  'STATIN',
  'ACE_INHIBITOR',
  'BETA_BLOCKER',
  'CALCIUM_CHANNEL_BLOCKER',
  'DIURETIC',
  'ANTICOAGULANT',
  'ANTIDIABETIC',
  'CORTICOSTEROID',
  'ANTIHISTAMINE',
  'BRONCHODILATOR',
  'OTHER',
];

export function MedicineSheet({
  open,
  /** Null to add; a medicine to correct one. */
  medicine,
  onClose,
  onSaved,
}: {
  open: boolean;
  medicine: Medicine | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [form, setForm] = useState('');
  const [strength, setStrength] = useState('');
  const [drugClass, setDrugClass] = useState<DrugClass>('OTHER');
  const [isControlled, setIsControlled] = useState(false);
  const [reorderLevel, setReorderLevel] = useState('20');
  const [sellingPrice, setSellingPrice] = useState('');
  /*
   * Which tax rate this medicine carries. Empty string means "the hospital's
   * default" — deliberately not zero. A catalogue nobody has been through yet
   * must not silently become untaxed the day tax is switched on.
   */
  const [taxRateId, setTaxRateId] = useState<string>('');
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(medicine?.name ?? '');
    setForm(medicine?.form ?? '');
    setStrength(medicine?.strength ?? '');
    setDrugClass(medicine?.drugClass ?? 'OTHER');
    setIsControlled(medicine?.isControlled ?? false);
    // Empty string, not '0'. A cleared box means "not priced"; a zero means
    // the hospital gives it away, and the two must not be the same keystroke.
    setSellingPrice(medicine?.sellingPrice ?? '');
    setTaxRateId(medicine?.taxRateId ? String(medicine.taxRateId) : '');

    /*
     * Both fail quietly to "no tax". A hospital that charges none never sees
     * this control at all, which is the point of gating on `taxEnabled`
     * rather than on whether the rate list happens to be empty.
     */
    api<{ data: TaxRate[] }>('/tax-rates')
      .then((r) => setRates(r.data))
      .catch(() => setRates([]));
    api<{ taxEnabled: boolean }>('/admin/clinic-settings')
      .then((c) => setTaxEnabled(c.taxEnabled))
      .catch(() => setTaxEnabled(false));
  }, [open, medicine]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        form: form.trim(),
        strength: strength.trim(),
        drugClass,
        isControlled,
        reorderLevel: Number(reorderLevel),
        /**
         * Sent as a string, and `null` when cleared.
         *
         * `undefined` would leave the existing price alone, which makes
         * clearing the field impossible — a medicine wrongly priced could never
         * be un-priced. `null` is the explicit "nobody has priced this".
         */
        sellingPrice: sellingPrice.trim() === '' ? null : sellingPrice.trim(),
        /*
         * `null` means "use the hospital's default rate", not "untaxed". To
         * make something genuinely untaxed, point it at a 0% rate — which is
         * why rates are named: "Exempt" and "Zero-rated" differ on a statutory
         * invoice and are identical to the arithmetic.
         */
        taxRateId: taxRateId === '' ? null : Number(taxRateId),
      };
      if (medicine) {
        await api(`/medicines/${medicine.id}`, { method: 'PATCH', body });
      } else {
        await api('/medicines', { method: 'POST', body });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that medicine');
    } finally {
      setBusy(false);
    }
  }

  const valid = name.trim() && form.trim() && strength.trim() && Number(reorderLevel) >= 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={medicine ? `Edit ${medicine.name}` : 'Add a medicine'}
      footer={
        <>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : medicine ? 'Save changes' : 'Add to catalogue'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Field label="Name" required hint="As it appears on the box — Amoxicillin, not Amoxil.">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Form" required hint="Tablet, capsule, syrup, injection.">
          <Input value={form} onChange={(e) => setForm(e.target.value)} placeholder="Tablet" />
        </Field>
        <Field label="Strength" required hint="500mg, 5mg/ml.">
          <Input
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
            placeholder="500mg"
          />
        </Field>
      </div>

      <Field
        label="Drug class"
        required
        hint="What the allergy check compares against. Leaving this on Other means a patient's penicillin allergy will not be caught for this medicine."
      >
        <Select value={drugClass} onChange={(e) => setDrugClass(e.target.value as DrugClass)}>
          {DRUG_CLASSES.map((c) => (
            <option key={c} value={c}>
              {titleCase(c.replace(/_/g, ' '))}
            </option>
          ))}
        </Select>
      </Field>

      {/* Stated at the moment of choosing, not in a help page. A catalogue left
          on OTHER produces allergy checks that run, find nothing, and look
          healthy — which is worse than no check, because it gets trusted. */}
      {drugClass === 'OTHER' && (
        <p className="-mt-1 mb-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-xs text-[#6b5314]">
          Allergy checking cannot match this medicine to anything. Set a real class unless it
          genuinely has none.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Reorder level"
          required
          hint="Below this, it shows as low stock on the inventory screen."
        >
          <Input
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
            inputMode="numeric"
          />
        </Field>

        <Field
          label="Selling price"
          hint="Per unit — one tablet, one capsule, one ml. Up to four decimal places."
        >
          <Input
            value={sellingPrice}
            onChange={(e) => setSellingPrice(e.target.value)}
            inputMode="decimal"
            placeholder="0.3500"
          />
        </Field>

        {/*
          Only when the hospital charges tax. A clinic that does not never sees
          a control it would have to think about and then ignore.
        */}
        {taxEnabled && (
          <Field
            label="Tax rate"
            hint="Leave on the default unless this item is taxed differently."
          >
            <select
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
              value={taxRateId}
              onChange={(e) => setTaxRateId(e.target.value)}
            >
              <option value="">
                Hospital default
                {rates.find((r) => r.isDefault)
                  ? ` — ${rates.find((r) => r.isDefault)!.name}`
                  : ' (none set)'}
              </option>
              {rates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.label})
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {/* The same distinction the consultation fee makes, said out loud at the
          moment it is being decided. A blank price is not a free medicine: it
          is dispensed, handed over, and charged nothing — and nobody finds out
          until a month of stock has gone unbilled. */}
      {sellingPrice.trim() === '' && (
        <p className="-mt-1 mb-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-xs text-[#6b5314]">
          Leaving this blank means this medicine is dispensed without being charged for. Enter 0 if
          it is genuinely free.
        </p>
      )}

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={isControlled}
          onChange={(e) => setIsControlled(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-medium">Controlled drug</span>
          <span className="mt-0.5 block text-xs text-text-muted">
            Flagged on the dispensing screen so it is handled and recorded accordingly.
          </span>
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Sheet>
  );
}
