'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { DispensePreparation, SaleCharge } from '@/lib/types';
import { date, titleCase } from '@/lib/format';
import { Button, Field, Input, Textarea, SectionLabel, Skeleton } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { PriceInline } from '@/components/price-inline';
import { useMoney } from '@/lib/use-money';
import { basketWithTax, lineTotalMinor, minorToAmount, taxRowsFor } from '@/lib/money-lines';

/**
 * Dispensing.
 *
 * The screen is ordered the way the decision is made: who the patient is,
 * what they are allergic to, then what is being handed over. The allergy
 * check is above the medicines, not beside them, because a pharmacist
 * scanning downwards should meet the warning before the quantity box.
 */
export function DispenseSheet({
  prescriptionId,
  onClose,
  onDispensed,
}: {
  prescriptionId: number | null;
  onClose: () => void;
  onDispensed: () => void;
}) {
  const router = useRouter();
  const [prep, setPrep] = useState<DispensePreparation | null>(null);
  const money = useMoney();
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [override, setOverride] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  /** What the dispense was charged at, returned by the server. */
  const [charge, setCharge] = useState<SaleCharge | null>(null);
  /** Settling an open-ended course by hand. */
  const [settling, setSettling] = useState(false);
  const [settled, setSettled] = useState(false);

  /*
   * Whether the pharmacist may close this prescription themselves.
   *
   * Mirrors `canBeSettledByHand` on the server, which is the authority: at
   * least one line has no fixed total, and none is known to still owe
   * anything. Computed here only so the button does not appear where the
   * server would refuse it — a control that exists to fail is worse than none.
   */
  const canSettle =
    !settled &&
    (prep?.items ?? []).some((i) => i.completion === 'unknown') &&
    !(prep?.items ?? []).some((i) => i.completion === 'outstanding');

  async function markComplete() {
    if (!prescriptionId) return;
    setSettling(true);
    try {
      await api(`/pharmacy/prescriptions/${prescriptionId}/complete`, { method: 'POST', body: {} });
      setSettled(true);
      onDispensed();
    } catch (e) {
      // The server names what is still outstanding, which is more useful than
      // anything guessable here.
      setError(e instanceof ApiError ? e.message : 'Could not mark that fully dispensed');
    } finally {
      setSettling(false);
    }
  }

  /*
   * Re-read the prescription without resetting what the pharmacist has typed.
   *
   * Used after pricing a medicine inline: the quantities already entered are
   * the whole point of the screen, and clearing them to pick up one price
   * would be a worse trade than the missing price was.
   */
  const reload = useCallback(async () => {
    if (!prescriptionId) return;
    try {
      setPrep(await api<DispensePreparation>(`/pharmacy/prescriptions/${prescriptionId}`));
    } catch {
      /* The sheet still holds a usable copy; a failed refresh is not worth
         throwing the pharmacist out of a dispense over. */
    }
  }, [prescriptionId]);

  useEffect(() => {
    setPrep(null);
    setQuantities({});
    setOverride('');
    setNotes('');
    setError(null);
    setDone(false);
    if (!prescriptionId) return;

    api<DispensePreparation>(`/pharmacy/prescriptions/${prescriptionId}`)
      .then((p) => {
        setPrep(p);
        // Pre-fill only where the server was willing to suggest a number.
        // Where it refused, the box stays empty and the pharmacist decides.
        const seeded: Record<number, string> = {};
        for (const item of p.items) {
          const suggested = item.outstandingQuantity ?? item.suggestedQuantity;
          if (suggested) seeded[item.id] = String(Math.min(suggested, item.inDateStock));
        }
        setQuantities(seeded);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load this prescription'));
  }, [prescriptionId]);

  if (!prescriptionId) return null;

  const blocking = prep?.allergyConflicts.filter((c) => c.level === 'BLOCKING') ?? [];
  const warnings = prep?.allergyConflicts.filter((c) => c.level === 'WARNING') ?? [];
  const lines = Object.entries(quantities)
    .map(([id, qty]) => ({ prescriptionItemId: Number(id), quantity: Number(qty) }))
    .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);

  const overrideOk = blocking.length === 0 || override.trim().length >= 10;

  /*
   * The running total, shown before the pharmacist commits.
   *
   * Computed in integer minor units rather than by adding floats: a receipt
   * that disagrees with the invoice by a penny is a conversation nobody wants
   * to have at a counter. Unpriced items contribute nothing and are named
   * separately, because a total that quietly skips them looks correct.
   */
  const priced = (prep?.items ?? [])
    .map((item) => ({ item, qty: Number(quantities[item.id] ?? 0) }))
    .filter(({ qty }) => Number.isFinite(qty) && qty > 0);

  /*
   * Net, tax and gross, previewed before the pharmacist commits.
   *
   * A running total that excluded tax was a number the patient would not
   * recognise on the invoice ten seconds later. The server recomputes
   * authoritatively on dispense; this must agree with it to the penny, which
   * is why both sides derive the tax the same way — see `money-lines.ts`.
   */
  const taxable = priced.map(({ item, qty }) => ({
    unitPrice: item.unitPrice,
    quantity: qty,
    taxRateBasisPoints: item.taxRateBasisPoints ?? 0,
    taxRateName: item.taxRateName ?? null,
    taxComponents: item.taxComponents ?? [],
  }));
  const basket = basketWithTax(taxable, prep?.pricesIncludeTax ?? false);
  /** The rows the invoice will print, previewed here so they cannot differ. */
  const taxRows = taxRowsFor(taxable, prep?.pricesIncludeTax ?? false);
  const totalMinor = basket.grossMinor;
  const unpricedItems = priced.filter(({ item }) => item.unitPrice === null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ charge: SaleCharge }>(
        `/pharmacy/prescriptions/${prescriptionId}/dispense`,
        {
          method: 'POST',
          body: {
            lines,
            overrideReason: blocking.length > 0 ? override.trim() : undefined,
            notes: notes.trim() || undefined,
          },
        },
      );
      setCharge(res.charge);
      setDone(true);

      /*
       * Straight to taking the money.
       *
       * The medicine is already in the patient's hand at this point — the
       * dispense committed and stock came off the shelf. Walking to Pharmacy
       * invoices, finding the right row and opening it is three navigations
       * for something the pharmacist is going to do in the next ten seconds,
       * with the patient still at the counter.
       *
       * NOT when something was left unpriced. That warning is the one thing on
       * this screen the pharmacist can still act on while the patient is here,
       * and whisking them to a payment form buries it — which is exactly how a
       * month of unbilled stock happens. They get the notice and a button
       * instead, so the jump is a decision rather than a surprise.
       *
       * NOT a gate, either. Nothing here checks whether the invoice is
       * settled; the medicine has gone regardless. This is a shortcut to the
       * next task, not a condition on the last one.
       */
      if (res.charge.invoiceId && res.charge.unpriced.length === 0) {
        onDispensed();
        router.push(`/pharmacy/invoices?invoice=${res.charge.invoiceId}`);
      }
    } catch (err) {
      // 409 covers both "stock ran out" and "override required" — the server
      // says which, and it says it better than a guess would.
      setError(err instanceof ApiError ? err.message : 'Could not complete the dispense');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      width="w-[520px]"
      title={done ? 'Dispensed' : `Dispense prescription #${prescriptionId}`}
      footer={
        done ? (
          <>
            {/*
              The half that was missing.

              An open-ended course has no computable total, so the server will
              not call the prescription finished on its own — correctly, because
              guessing is how a patient goes home with the wrong count. Until
              now that refusal led nowhere: the prescription sat at "partially
              dispensed" permanently with nothing able to move it.

              Offered only when nothing is *known* to be outstanding. With a
              line still owing twenty tablets this would close a genuinely
              half-filled course, which is the worse error.
            */}
            {canSettle && (
              <Button
                disabled={settling}
                onClick={() => void markComplete()}
              >
                {settling ? 'Marking…' : 'Mark fully dispensed'}
              </Button>
            )}
            <Button variant="primary" onClick={onDispensed}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button
              variant={blocking.length > 0 ? 'danger' : 'primary'}
              disabled={lines.length === 0 || !overrideOk || submitting || !prep}
              onClick={() => void submit()}
            >
              {submitting
                ? 'Dispensing…'
                : blocking.length > 0
                  ? 'Dispense with override'
                  : 'Dispense'}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            <span className="text-xxs leading-tight text-text-muted">
              Stock is decremented
              <br />
              on your signature
            </span>
          </>
        )
      }
    >
      {!prep && !error && <Skeleton className="h-64 w-full" />}

      {prep && (
        <>
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="text-md font-bold">{prep.patient.fullName}</div>
            <div className="font-mono text-xs text-text-muted">
              #{prep.patient.id} · born {date(prep.patient.dob)}
            </div>
            <div className="mt-1 text-xs text-text-muted">
              Prescribed {date(prep.issuedAt)} by {prep.doctor?.fullName ?? 'unknown'}
            </div>
          </div>

          {/* Allergy check sits above the medicines by design. */}
          {blocking.length > 0 && (
            <div
              role="alert"
              className="mt-3 rounded-sm border border-[#f2c4be] border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5 text-sm text-[#8a2a1f]"
            >
              <div className="font-bold">⚠ Dispensing blocked — allergy conflict</div>
              <ul className="mt-1 list-inside list-disc text-xs">
                {blocking.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs">
                This can be overridden with a documented reason. The reason is recorded against the
                dispense and visible to anyone reviewing it.
              </p>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
              <div className="font-semibold">Allergy caution</div>
              <ul className="mt-1 list-inside list-disc text-xs">
                {warnings.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
            </div>
          )}

          {prep.uncataloguedItems.length > 0 && (
            <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
              <div className="font-semibold">Not allergy-checked</div>
              <p className="mt-0.5 text-xs">
                {prep.uncataloguedItems.join(', ')} — no catalogue entry, so only a name match was
                possible. Map to a medicine to check by drug class and to dispense against stock.
              </p>
            </div>
          )}

          {prep.patient.allergies.length === 0 && (
            <div className="mt-3 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-text-muted">
              No known allergies recorded
            </div>
          )}

          {done ? (
            <>
              <p className="mt-4 text-sm">
                Recorded against prescription <span className="font-mono">#{prescriptionId}</span>.
                Stock has been decremented from the shortest-dated in-date batches.
              </p>

              {/* Reached only when the jump to payment was held back — see
                  `submit`. Either something was not priced, or nothing on the
                  dispense was chargeable at all. */}
              {charge && charge.unpriced.length > 0 && (
                <p className="mt-2 rounded-sm border border-[#ecdca6] bg-warning-soft px-2.5 py-2 text-xs text-[#6b5314]">
                  <strong>Not charged for:</strong> {charge.unpriced.join(', ')}. These left the
                  shelf without a price. Set one on the Inventory screen so the next sale is
                  charged correctly — this one cannot be re-priced.
                </p>
              )}

              {charge?.invoiceId ? (
                <Button
                  variant="primary"
                  className="mt-3"
                  onClick={() => {
                    onDispensed();
                    router.push(`/pharmacy/invoices?invoice=${charge.invoiceId}`);
                  }}
                >
                  Take payment — {money(charge.total)}
                </Button>
              ) : (
                <p className="mt-2 text-xs text-warning">
                  No invoice was raised: nothing on this dispense had a price.
                </p>
              )}
            </>
          ) : (
            <>
              <SectionLabel>Medicines</SectionLabel>
              {prep.items.map((item) => {
                const shortfall = item.inDateStock < (Number(quantities[item.id]) || 0);
                return (
                  <div key={item.id} className="mb-2.5 rounded-sm border border-border bg-[#fcfcfd] p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">
                          {item.medicineName}
                          {item.medicine?.isControlled && (
                            <span className="ml-1.5 rounded-sm border border-border-strong px-1 text-xxs uppercase text-text-muted">
                              Controlled
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-xs text-text-muted">
                          {item.dosage} · {item.frequency} · {item.duration}
                        </div>
                        {item.medicine && (
                          <div className="text-xxs text-text-subtle">
                            {item.medicine.name} {item.medicine.strength} ·{' '}
                            {titleCase(item.medicine.drugClass)}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div
                          className={`font-mono text-xs ${
                            item.inDateStock === 0 ? 'font-bold text-danger' : 'text-text-muted'
                          }`}
                        >
                          {item.inDateStock} in date
                        </div>
                        {/*
                          Ordered against given, stated plainly.

                          Before `quantityPrescribed` existed there was nothing
                          to compare against: the server inferred a total from
                          the free-text course and, when it could not, treated
                          that as "not finished" — so a prescription handed over
                          in full stayed "partially dispensed" permanently and
                          the counter offered no explanation.
                        */}
                        {item.quantityPrescribed !== null && (
                          <div className="text-xxs text-text-subtle">
                            {item.quantityDispensed} of {item.quantityPrescribed} given
                          </div>
                        )}
                        {item.quantityPrescribed === null && item.quantityDispensed > 0 && (
                          <div className="text-xxs text-text-subtle">
                            {item.quantityDispensed} already given
                          </div>
                        )}
                        {item.completion === 'unknown' && (
                          <div className="text-xxs text-warning">no fixed total</div>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex items-end gap-2">
                      <Field
                        label="Quantity"
                        hint={
                          item.completion === 'unknown'
                            ? 'Open-ended course — enter what you are handing over.'
                            : undefined
                        }
                      >
                        <Input
                          type="number"
                          min={0}
                          value={quantities[item.id] ?? ''}
                          onChange={(e) =>
                            setQuantities((q) => ({ ...q, [item.id]: e.target.value }))
                          }
                          className={shortfall ? 'border-danger' : ''}
                          disabled={!item.medicine}
                        />
                      </Field>

                      <div className="pb-2 text-right text-xs">
                        {/*
                          Always the editor. See `price-inline.tsx`: a control
                          that is only sometimes present is one nobody trusts
                          is there, and a wrong price is discovered at the
                          counter exactly like a missing one.

                          An unmapped item is the one case with no control —
                          there is no catalogue row to hold a price, and
                          mapping is the fix the panel above already names.
                        */}
                        {item.medicine ? (
                          <>
                            <PriceInline
                              medicineId={item.medicine.id}
                              medicineName={item.medicine.name}
                              currentPrice={
                                item.unitPrice === null ? null : money(item.unitPrice)
                              }
                              onPriced={() => void reload()}
                            />
                            {item.unitPrice !== null && (
                              <div className="font-mono text-text">
                                {money(
                                  minorToAmount(
                                    lineTotalMinor(
                                      item.unitPrice,
                                      Number(quantities[item.id]) || 0,
                                    ),
                                  ),
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-warning">Not priced</span>
                        )}
                      </div>
                    </div>

                    {!item.medicine && (
                      <p className="text-xs text-danger">
                        Not linked to the catalogue — stock cannot be tracked for this item.
                      </p>
                    )}
                    {shortfall && (
                      <p className="text-xs text-danger">
                        Only {item.inDateStock} in date. Expired stock is never dispensed.
                      </p>
                    )}
                  </div>
                );
              })}

              {/*
                What this is going to cost, before it is committed.
                A pharmacist who only finds out the total after signing has no
                chance to correct a quantity, and the customer is standing there.
              */}
              {priced.length > 0 && (
                <div className="rounded-md border border-border bg-bg px-3 py-2">
                  {/*
                    Net and tax above the total, and only when there is tax.

                    Omitted at zero rather than shown as 0.00: most hospitals
                    charge none, and a permanent zero row trains people to skip
                    the block that matters.
                  */}
                  {basket.taxMinor > 0 && (
                    <>
                      <div className="flex items-baseline justify-between text-xs text-text-muted">
                        <span>Net</span>
                        <span className="font-mono">{money(minorToAmount(basket.netMinor))}</span>
                      </div>
                      {taxRows.map((t) => (
                        <div
                          key={`${t.name}-${t.rateBasisPoints}`}
                          className="flex items-baseline justify-between text-xs text-text-muted"
                        >
                          <span>
                            {t.name}
                            <span className="ml-1 text-text-subtle">
                              {(t.rateBasisPoints / 100).toString()}%
                            </span>
                          </span>
                          <span className="font-mono">{money(minorToAmount(t.minor))}</span>
                        </div>
                      ))}
                    </>
                  )}

                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-text-muted">Total to charge</span>
                    <span className="font-mono text-base font-semibold text-text">
                      {money(minorToAmount(totalMinor))}
                    </span>
                  </div>
                  {unpricedItems.length > 0 && (
                    <p className="mt-1 text-xs text-warning">
                      {unpricedItems.map(({ item }) => item.medicineName).join(', ')} —{' '}
                      {unpricedItems.length === 1 ? 'has' : 'have'} no price, so nothing is charged
                      for {unpricedItems.length === 1 ? 'it' : 'them'}. Set a price on the
                      inventory screen.
                    </p>
                  )}
                </div>
              )}

              {blocking.length > 0 && (
                <Field label="Override reason" required hint="At least a sentence. This is recorded.">
                  <Textarea
                    rows={3}
                    value={override}
                    onChange={(e) => setOverride(e.target.value)}
                    placeholder="e.g. Discussed with prescriber; recorded reaction was a rash, not anaphylaxis."
                  />
                </Field>
              )}

              <Field label="Notes">
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </>
          )}
        </>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}
