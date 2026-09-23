'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Input } from '@/components/ui/primitives';

/**
 * Set a medicine's selling price without leaving the screen you are on.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `Medicine.sellingPrice` being null means nobody has priced it — deliberately
 * distinct from zero, which means the hospital gives it away. The medicine is
 * still dispensed and still leaves stock; it is simply not charged for.
 *
 * That model is right and it had no repair path at the counter. A pharmacist
 * met "Not priced" mid-sale and the only fix was to abandon what they were
 * doing, open Inventory, price the medicine and start again — with a patient
 * standing in front of them. In practice the medicine went out unpriced and
 * the loss surfaced a month later in a report.
 *
 * WHY IT IS ONE COMPONENT
 * -----------------------
 * It belongs on every screen where an unpriced medicine can be discovered:
 * dispensing a prescription, and the counter sale. Two copies of a form that
 * writes a price is two chances for them to validate differently, and the
 * second one is always the one that accepts something the server rejects.
 *
 * NOT A NEW PERMISSION
 * --------------------
 * The same `PATCH /medicines/:id` the catalogue editor calls, already open to
 * PHARMACIST. This is a shortcut to a capability they held, reached from the
 * moment they need it.
 */
export function PriceInline({
  medicineId,
  medicineName,
  onPriced,
  label = 'Not priced — set price',
  /**
   * The price as it stands, or null when nobody has set one.
   *
   * Passing it makes the control an *editor* rather than a one-shot filler:
   * the cell is clickable whether or not a price exists.
   *
   * That is not a flourish. While a priced medicine showed a plain number and
   * an unpriced one showed a link, "there is no way to set the price here" and
   * "this one happens to be priced already" looked identical from across the
   * screen — and the second was repeatedly reported as the first. A control
   * that is sometimes absent is a control nobody trusts is there.
   *
   * It is also useful in its own right: a wrong price is found at the till,
   * with a patient waiting, exactly like a missing one.
   */
  currentPrice = null,
}: {
  medicineId: number;
  medicineName: string;
  onPriced: () => void;
  label?: string;
  currentPrice?: string | null;
}) {
  const [open, setOpen] = useState(false);
  // Seeded with what is there, so correcting 2.50 to 2.55 is two keystrokes
  // rather than retyping a number you can already see.
  const [value, setValue] = useState(currentPrice ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setFailed(null);
    try {
      await api(`/medicines/${medicineId}`, {
        method: 'PATCH',
        body: { sellingPrice: value.trim() },
      });
      setOpen(false);
      setValue('');
      onPriced();
    } catch (e) {
      // The server owns the format rule (up to four decimals) and says so
      // better than a guess here would.
      setFailed(e instanceof ApiError ? e.message : 'Could not save that price');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(currentPrice ?? '');
          setOpen(true);
        }}
        className={
          currentPrice === null
            ? 'text-warning underline-offset-2 hover:underline'
            : // A priced medicine reads as the number it is; the affordance is
              // the dotted underline, not a colour that would make every row
              // look like it needed attention.
              'border-b border-dotted border-text-subtle text-text underline-offset-2 hover:border-primary hover:text-primary'
        }
        title={currentPrice === null ? undefined : `Change the price of ${medicineName}`}
      >
        {currentPrice === null ? label : currentPrice}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves, Escape backs out. A pharmacist doing this mid-sale
            // has one hand on the keyboard and a patient waiting.
            if (e.key === 'Enter' && value.trim()) void save();
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="0.0000"
          className="w-24 text-right font-mono"
          aria-label={`Selling price for ${medicineName}`}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !value.trim()}
          onClick={() => void save()}
        >
          {busy ? '…' : 'Save'}
        </Button>
      </div>
      {failed && <span className="text-danger">{failed}</span>}
      {/* Says what it applies to. This is a catalogue edit reached from one
          sale, and it sets the price for every future one. */}
      <span className="text-text-subtle">
        {currentPrice === null
          ? 'Price per unit, for all future sales'
          : 'Changes the price for all future sales. Past sales keep what they were charged.'}
      </span>
    </div>
  );
}
