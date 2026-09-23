'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { InventoryRow, SaleCharge } from '@/lib/types';
import { useMoney } from '@/lib/use-money';
import { basketWithTax, lineTotalMinor, minorToAmount, taxRowsFor } from '@/lib/money-lines';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  TableSkeleton,
} from '@/components/ui/primitives';
import { PriceInline } from '@/components/price-inline';

/**
 * The counter. Somebody walks in and buys medicine.
 *
 * WHY THIS IS SEPARATE FROM DISPENSING
 * ------------------------------------
 * Dispensing fills something a doctor wrote: the medicines, the quantities and
 * the allergy check all come from the prescription, and the pharmacist's job is
 * to check and hand over. A counter sale starts from nothing — the catalogue is
 * the only input, and there is no prescriber standing behind the decision.
 *
 * Mixing them into one screen with half the fields greyed out would make both
 * worse, and would blur the one distinction that matters clinically: on this
 * screen, **nothing has been checked by a doctor**.
 *
 * WHAT THIS SCREEN WILL NOT DO
 * ----------------------------
 * It does not require a patient. Most counter trade is anonymous, and creating
 * a patient record for somebody buying paracetamol would put a stranger into
 * the list reception searches, indistinguishable from someone under the
 * hospital's care.
 *
 * Where a patient *is* named, the server checks their allergies and returns
 * warnings — which are shown and do not block. A person buying something for
 * themselves is entitled to do so; refusing on a record they cannot see would
 * be the software overruling them with no way to argue.
 */
export default function CounterSalePage() {
  const money = useMoney();
  /*
   * Filling a prescription written at another hospital.
   *
   * It comes through this screen rather than the dispensing one because the
   * prescription belongs to the other hospital — there is no local row to key
   * on, and inventing a `Patient` for somebody not under this hospital's care
   * would put a stranger into the list reception searches.
   *
   * The pharmacist reads the referral's lines and finds the matching medicines
   * in *this* catalogue. Names differ between hospitals, so that mapping is a
   * human job, exactly as it already is for an uncatalogued item.
   */
  const referralId = useSearchParams().get('referral');
  const [stock, setStock] = useState<InventoryRow[] | null>(null);
  /*
   * Whether the catalogue prices already contain tax. Decides whether the
   * basket adds tax on top or carves it out — the same price gives different
   * totals under the two, so this cannot be assumed.
   */
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false);
  const [query, setQuery] = useState('');
  const [basket, setBasket] = useState<Record<number, number>>({});
  const [buyerName, setBuyerName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<SaleCharge | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: InventoryRow[]; pricesIncludeTax?: boolean }>(
        '/pharmacy/inventory',
      );
      setStock(res.data);
      setPricesIncludeTax(res.pricesIncludeTax ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byId = useMemo(() => new Map((stock ?? []).map((r) => [r.id, r])), [stock]);

  const lines = Object.entries(basket)
    .map(([id, qty]) => ({ row: byId.get(Number(id))!, quantity: qty }))
    .filter((l) => l.row && l.quantity > 0);

  /*
   * Totals in integer minor units, never by adding floats.
   *
   * The unit price carries four decimals, so the multiply happens at that
   * precision and the rounding happens once per line — the same rule the server
   * applies in `pricing.ts`. Two different roundings would produce a receipt
   * that disagrees with the invoice by a penny, at a counter, in front of
   * somebody holding cash.
   */
  const taxable = lines.map((l) => ({
    unitPrice: l.row.sellingPrice,
    quantity: l.quantity,
    taxRateBasisPoints: l.row.taxRateBasisPoints ?? 0,
    taxRateName: l.row.taxRateName ?? null,
    taxComponents: l.row.taxComponents ?? [],
  }));
  const totals = basketWithTax(taxable, pricesIncludeTax);
  /*
   * One row per named tax, exactly as the receipt will print them. Grouping
   * differently here from the invoice would leave the pharmacist explaining a
   * discrepancy to whoever is at the counter.
   */
  const taxRows = taxRowsFor(taxable, pricesIncludeTax);
  const totalMinor = totals.grossMinor;
  const unpriced = lines.filter((l) => l.row.sellingPrice === null);

  const visible = (stock ?? []).filter((r) =>
    query.trim() ? r.name.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  function setQty(id: number, qty: number) {
    setBasket((b) => {
      const next = { ...b };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ charge: SaleCharge }>('/pharmacy/sales', {
        method: 'POST',
        body: {
          lines: lines.map((l) => ({ medicineId: l.row.id, quantity: l.quantity })),
          buyerName: buyerName.trim() || undefined,
          notes: notes.trim() || undefined,
          referralId: referralId ? Number(referralId) : undefined,
        },
      });
      setReceipt(res.charge);
      setBasket({});
      setBuyerName('');
      setNotes('');
      await load();
    } catch (e) {
      // Insufficient stock, an inactive medicine, a stock race — the server
      // says which, and states the arithmetic when it is a shortfall.
      setError(e instanceof ApiError ? e.message : 'Could not record that sale');
    } finally {
      setBusy(false);
    }
  }

  if (error && !stock) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-text">Counter sale</h1>
        <p className="text-sm text-text-muted">
          {referralId
            ? 'Filling a prescription sent from another hospital. Allergies are not transmitted between hospitals — ask the patient.'
            : 'Sell medicine without a prescription. Nothing on this screen has been checked by a doctor.'}
        </p>
      </div>

      {receipt && (
        <div className="mb-4 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm">
          <p className="font-medium text-text">
            Sold — {money(receipt.total)}
            {receipt.invoiceId ? ` · invoice #${receipt.invoiceId}` : ''}
          </p>
          {receipt.invoiceId === null && (
            <p className="mt-1 text-xs text-warning">
              No invoice was raised: nothing on this sale had a price.
            </p>
          )}
          {receipt.unpriced.length > 0 && (
            <p className="mt-1 text-xs text-warning">
              Not charged for: {receipt.unpriced.join(', ')}.
            </p>
          )}
          {receipt.invoiceId && (
            <p className="mt-1 text-xs text-text-muted">
              Take payment on the <strong>Pharmacy invoices</strong> screen.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the catalogue…"
            className="mb-3"
          />

          {!stock ? (
            <TableSkeleton rows={8} />
          ) : visible.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              description="The catalogue is searched by name. Add medicines on the Inventory screen."
            />
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
                  <tr>
                    <th className="px-3 py-2">Medicine</th>
                    <th className="px-3 py-2 text-right">In date</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <span className="font-medium text-text">{r.name}</span>
                        <span className="ml-1.5 text-xs text-text-subtle">
                          {r.strength} {r.form}
                        </span>
                        {r.isControlled && (
                          <span className="ml-1.5 text-xxs uppercase text-warning">controlled</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono text-xs ${
                          r.inDateQuantity === 0 ? 'font-bold text-danger' : 'text-text-muted'
                        }`}
                      >
                        {r.inDateQuantity}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {/*
                          Always the editor, priced or not.
                          ---------------------------------
                          Unpriced is not 0.00 — it sells for nothing because
                          nobody set a price, which is a different problem from
                          being free. Either way the fix belongs here: sending
                          a pharmacist to Inventory mid-sale means, in practice,
                          the sale goes through unpriced and the money is found
                          missing a month later.

                          Rendering the control only when the price was null
                          made a priced row indistinguishable from a screen
                          with no such feature, which was reported as a missing
                          feature more than once.
                        */}
                        <PriceInline
                          medicineId={r.id}
                          medicineName={r.name}
                          label="not priced — set"
                          currentPrice={
                            r.sellingPrice === null
                              ? null
                              : money(Number(r.sellingPrice).toFixed(2))
                          }
                          onPriced={() => void load()}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          max={r.inDateQuantity}
                          value={basket[r.id] ?? ''}
                          onChange={(e) => setQty(r.id, Number(e.target.value))}
                          className="w-20 text-right"
                          disabled={r.inDateQuantity === 0}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-2 text-xs uppercase tracking-wide text-text-subtle">This sale</h2>

          {lines.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing selected yet.</p>
          ) : (
            <ul className="mb-3 space-y-1.5 text-sm">
              {lines.map((l) => (
                <li key={l.row.id} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-text">
                    {l.row.name} <span className="text-text-subtle">× {l.quantity}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs">
                    {l.row.sellingPrice === null ? (
                      <span className="text-warning">—</span>
                    ) : (
                      money(minorToAmount(lineTotalMinor(l.row.sellingPrice, l.quantity)))
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Net and tax, only when there is tax to show. */}
          {totals.taxMinor > 0 && (
            <div className="border-t border-border pt-2 text-xs text-text-muted">
              <div className="flex justify-between">
                <span>Net</span>
                <span className="font-mono">{money(minorToAmount(totals.netMinor))}</span>
              </div>
              {taxRows.map((t) => (
                <div key={`${t.name}-${t.rateBasisPoints}`} className="flex justify-between">
                  <span>
                    {t.name}
                    <span className="ml-1 text-text-subtle">
                      {(t.rateBasisPoints / 100).toString()}%
                    </span>
                  </span>
                  <span className="font-mono">{money(minorToAmount(t.minor))}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-baseline justify-between border-t border-border pt-2">
            <span className="text-sm text-text-muted">Total</span>
            <span className="font-mono text-lg font-semibold text-text">
              {money(minorToAmount(totalMinor))}
            </span>
          </div>

          {unpriced.length > 0 && (
            <p className="mt-2 text-xs text-warning">
              {unpriced.map((l) => l.row.name).join(', ')} — no price set, so nothing will be
              charged. Set {unpriced.length === 1 ? 'it' : 'them'} in the Price column if that is
              wrong.
            </p>
          )}

          <div className="mt-3 space-y-2">
            <Field
              label="Buyer"
              hint="For the receipt only. Not stored against anybody and not searchable."
            >
              <Input
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder="Optional"
              />
            </Field>

            <Field label="Notes">
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional"
              />
            </Field>
          </div>

          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          )}

          <Button
            variant="primary"
            className="mt-3 w-full"
            disabled={lines.length === 0 || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Recording…' : 'Record sale'}
          </Button>

          <p className="mt-2 text-xxs leading-relaxed text-text-subtle">
            Stock comes off the shortest-dated batches first. Payment is taken separately, on the
            Pharmacy invoices screen — the medicine is never held back over an unpaid balance.
          </p>
        </aside>
      </div>
    </div>
  );
}
