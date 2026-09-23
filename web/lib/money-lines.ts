/**
 * Line arithmetic for anything that sells a medicine.
 *
 * WHY THIS IS A MODULE AND NOT THREE COPIES
 * -----------------------------------------
 * Prices carry four decimals (`Medicine.sellingPrice` is `Decimal(10,4)`),
 * money is held in integer minor units, and the rounding happens exactly once —
 * on the line total, half-up, because that is what a till does. Those three
 * rules were being retyped inline on every screen that shows a running total.
 *
 * That produced the bug this file was written for. The dispensing sheet
 * computed a correct total in **minor units**, called the variable
 * `totalMinor`, and then rendered it with `.toFixed(2)` — printing 3500.00 for
 * a £35.00 basket. A hundredfold overstatement, in front of a patient, on the
 * number they are about to be charged.
 *
 * Nothing catches that: the arithmetic is right, the types are right (a number
 * is a number), and the only thing wrong is which unit the value was in when
 * it reached the screen. Naming the unit in the type is not possible here
 * without a branded type, so the next best thing is that no screen does the
 * conversion itself.
 *
 * The server does the authoritative version of this in `pharmacy/pricing.ts`
 * and `billing/money.ts`; these are the client's preview of the same
 * calculation and must agree with it to the penny, or the receipt disagrees
 * with the invoice at the counter.
 */

/** Price precision. `Decimal(10,4)` — a tablet at 0.0725 is ordinary. */
const PRICE_SCALE = 10_000;

/**
 * One line's total, in integer minor units.
 *
 * Rounded once, here, rather than on the unit price. Rounding 0.0725 to 0.07
 * before multiplying by 30 is out by 3% on that line, forever, in the same
 * direction.
 *
 * `null` price means unpriced — nobody has set one — which contributes
 * nothing. Deliberately not zero: zero means the hospital gives it away, and
 * collapsing the two turns a forgotten price into a decision nobody made.
 */
export function lineTotalMinor(unitPrice: string | null, quantity: number): number {
  if (unitPrice === null) return 0;
  const price = Number(unitPrice);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.round((price * PRICE_SCALE * quantity) / 100);
}

/** Sum of lines, in integer minor units. */
export function basketTotalMinor(
  lines: { unitPrice: string | null; quantity: number }[],
): number {
  return lines.reduce((sum, l) => sum + lineTotalMinor(l.unitPrice, l.quantity), 0);
}

/**
 * Minor units to the string `useMoney()` expects.
 *
 * The one place the unit changes, so the conversion cannot be forgotten at a
 * render site — which is exactly how the 100× bug happened.
 */
export function minorToAmount(minor: number): string {
  return (minor / 100).toFixed(2);
}


/**
 * Tax preview for a screen that has not committed a sale yet.
 *
 * Mirrors `backend/src/billing/tax.ts` exactly, including deriving the tax by
 * subtraction in inclusive mode so `net + tax === gross` with no residue. It
 * is a *preview*: the server recomputes authoritatively when the sale is
 * recorded, and the two must agree to the penny or the running total on the
 * screen disagrees with the invoice the patient is handed.
 *
 * Duplicated rather than shared because the clients cannot import backend
 * code, and the alternative — asking the server for a quote on every
 * keystroke — would make the counter feel worse than the arithmetic it
 * replaces. `tax.spec.ts` and `money-lines.test.ts` assert the same cases on
 * each side.
 */
export function taxOnMinor(
  netOrGrossMinor: number,
  rateBasisPoints: number,
  pricesIncludeTax: boolean,
): { netMinor: number; taxMinor: number; grossMinor: number } {
  const rate = Number.isFinite(rateBasisPoints) ? Math.max(0, Math.trunc(rateBasisPoints)) : 0;
  const amount = Number.isFinite(netOrGrossMinor) ? Math.trunc(netOrGrossMinor) : 0;

  if (rate === 0) return { netMinor: amount, taxMinor: 0, grossMinor: amount };

  if (!pricesIncludeTax) {
    const taxMinor = Math.round((amount * rate) / 10_000);
    return { netMinor: amount, taxMinor, grossMinor: amount + taxMinor };
  }

  const netMinor = Math.round((amount * 10_000) / (10_000 + rate));
  return { netMinor, taxMinor: amount - netMinor, grossMinor: amount };
}

/** Net, tax and gross across a basket, summed from lines rounded once each. */
export function basketWithTax(
  lines: { unitPrice: string | null; quantity: number; taxRateBasisPoints?: number }[],
  pricesIncludeTax: boolean,
): { netMinor: number; taxMinor: number; grossMinor: number } {
  return lines.reduce(
    (acc, l) => {
      const t = taxOnMinor(
        lineTotalMinor(l.unitPrice, l.quantity),
        l.taxRateBasisPoints ?? 0,
        pricesIncludeTax,
      );
      return {
        netMinor: acc.netMinor + t.netMinor,
        taxMinor: acc.taxMinor + t.taxMinor,
        grossMinor: acc.grossMinor + t.grossMinor,
      };
    },
    { netMinor: 0, taxMinor: 0, grossMinor: 0 },
  );
}


/**
 * The tax rows to print, one per named component, across a whole basket.
 *
 * Mirrors what the server produces for the invoice, so the running total at
 * the till groups the same way the receipt does. A pharmacist reading "Tax
 * 12.00" on screen and CGST 6.00 / SGST 6.00 on the printed bill has a
 * discrepancy to explain to whoever is standing there.
 *
 * Components are apportioned from each line's tax rather than computed
 * independently — see `apportionMinor`. A flat rate contributes one row under
 * its own name.
 */
export function taxRowsFor(
  lines: {
    unitPrice: string | null;
    quantity: number;
    taxRateBasisPoints?: number;
    taxRateName?: string | null;
    taxComponents?: { name: string; rateBasisPoints: number }[];
  }[],
  pricesIncludeTax: boolean,
): { name: string; rateBasisPoints: number; minor: number }[] {
  const rows = new Map<string, { name: string; rateBasisPoints: number; minor: number }>();

  const add = (name: string, rateBasisPoints: number, minor: number) => {
    if (minor === 0) return;
    const key = `${name}|${rateBasisPoints}`;
    const at = rows.get(key) ?? { name, rateBasisPoints, minor: 0 };
    at.minor += minor;
    rows.set(key, at);
  };

  for (const l of lines) {
    const { taxMinor } = taxOnMinor(
      lineTotalMinor(l.unitPrice, l.quantity),
      l.taxRateBasisPoints ?? 0,
      pricesIncludeTax,
    );
    if (taxMinor === 0) continue;

    const parts = l.taxComponents ?? [];
    if (parts.length === 0) {
      add(l.taxRateName ?? 'Tax', l.taxRateBasisPoints ?? 0, taxMinor);
      continue;
    }
    for (const p of apportionMinor(taxMinor, parts)) {
      add(p.name, p.rateBasisPoints, p.amountMinor);
    }
  }

  return [...rows.values()].sort(
    (a, b) => b.rateBasisPoints - a.rateBasisPoints || a.name.localeCompare(b.name),
  );
}

/**
 * Split a line's tax across its components so the parts sum to it exactly.
 *
 * The same largest-remainder method as `apportionTax` on the server. Computing
 * each part independently and rounding leaves them disagreeing with the tax
 * they came from — 12% of 1.05 split 6/6 gives 0.54 + 0.54 against 1.05 — and
 * a screen that cannot add up its own rows is one nobody trusts.
 */
export function apportionMinor(
  totalMinor: number,
  components: { name: string; rateBasisPoints: number }[],
): { name: string; rateBasisPoints: number; amountMinor: number }[] {
  const totalRate = components.reduce((s, c) => s + Math.max(0, c.rateBasisPoints), 0);
  if (components.length === 0 || totalMinor === 0 || totalRate <= 0) {
    return components.map((c) => ({ ...c, amountMinor: 0 }));
  }

  const exact = components.map((c) => (totalMinor * Math.max(0, c.rateBasisPoints)) / totalRate);
  const amounts = exact.map((v) => Math.floor(v));
  let remaining = totalMinor - amounts.reduce((s, v) => s + v, 0);

  for (const { i } of exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i)) {
    if (remaining <= 0) break;
    amounts[i] += 1;
    remaining -= 1;
  }

  return components.map((c, i) => ({ ...c, amountMinor: amounts[i] }));
}
