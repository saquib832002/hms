'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { DispensePreparation } from '@/lib/types';
import { date, titleCase } from '@/lib/format';
import { Button, Field, Input, Textarea, SectionLabel, Skeleton } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

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
  const [prep, setPrep] = useState<DispensePreparation | null>(null);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [override, setOverride] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

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

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/pharmacy/prescriptions/${prescriptionId}/dispense`, {
        method: 'POST',
        body: {
          lines,
          overrideReason: blocking.length > 0 ? override.trim() : undefined,
          notes: notes.trim() || undefined,
        },
      });
      setDone(true);
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
          <Button variant="primary" onClick={onDispensed}>
            Done
          </Button>
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
            <p className="mt-4 text-sm">
              Recorded against prescription <span className="font-mono">#{prescriptionId}</span>.
              Stock has been decremented from the shortest-dated in-date batches.
            </p>
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
                        {item.quantityDispensed > 0 && (
                          <div className="text-xxs text-text-subtle">
                            {item.quantityDispensed} already given
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex items-end gap-2">
                      <Field
                        label="Quantity"
                        hint={
                          item.suggestedQuantity === null
                            ? 'Course length could not be read — enter the quantity.'
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
