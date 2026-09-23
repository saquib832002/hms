'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, EmptyState, Skeleton, Textarea } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

interface HistoryEvent {
  id: number;
  dispensedAt: string;
  notes: string | null;
  pharmacist: { id: number; fullName: string } | null;
  prescription: { id: number; patient: { id: number; fullName: string } | null } | null;
  lines: { id: number; quantity: number; medicine: { name: string } | null }[];
  /** Set when the handover was undone before the medicine left the counter. */
  reversedAt?: string | null;
  reversalReason?: string | null;
}

/**
 * What has been dispensed, and by whom.
 *
 * The reason this exists rather than being a nice-to-have: an allergy override
 * is stored on the dispense event's notes, prefixed `ALLERGY OVERRIDE`. If
 * nothing displays those, the override is technically recorded and practically
 * invisible — which would make the whole override mechanism theatre.
 */
export function DispenseHistorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which dispense is being reversed, and the two things required to do it. */
  const [reversing, setReversing] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [affirmed, setAffirmed] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reverse(eventId: number) {
    setBusy(true);
    setReverseError(null);
    try {
      await api(`/pharmacy/dispense-events/${eventId}/reverse`, {
        method: 'POST',
        body: { reason: reason.trim(), notLeftPremises: affirmed },
      });
      setReversing(null);
      setReason('');
      setAffirmed(false);
      // Re-read rather than patching in place: the reversal also voided an
      // invoice and moved stock, and a list that shows one of those and not
      // the others is worse than one that reloads.
      const res = await api<{ data: HistoryEvent[] }>('/pharmacy/history');
      setEvents(res.data);
    } catch (e) {
      // "Already reversed", "money has been taken against this sale" — the
      // server's wording names the next action, which a guess here would not.
      setReverseError(e instanceof ApiError ? e.message : 'Could not reverse that dispense');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) {
      setEvents(null);
      setError(null);
      return;
    }
    api<{ data: HistoryEvent[] }>('/pharmacy/history')
      .then((r) => setEvents(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load history'));
  }, [open]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="w-[480px]"
      title="Dispensing history"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {!events && !error && <Skeleton className="h-40 w-full" />}
      {events?.length === 0 && <EmptyState title="Nothing dispensed yet" />}

      {events?.map((e) => {
        const overridden = e.notes?.startsWith('ALLERGY OVERRIDE');
        return (
          <div
            key={e.id}
            className={`mb-2.5 rounded-sm border p-2.5 ${
              overridden ? 'border-[#f2c4be] bg-danger-soft' : 'border-border bg-[#fcfcfd]'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">
                {e.prescription?.patient?.fullName ?? 'Unknown patient'}
              </span>
              <span className="font-mono text-xs text-text-muted">
                Rx #{e.prescription?.id}
              </span>
            </div>
            <div className="font-mono text-xs text-text-muted">
              {dateTime(e.dispensedAt)} · {e.pharmacist?.fullName ?? 'unknown'}
            </div>

            <ul className="mt-1.5 space-y-0.5">
              {e.lines.map((l) => (
                <li key={l.id} className="font-mono text-xs">
                  {l.medicine?.name ?? '—'} × {l.quantity}
                </li>
              ))}
            </ul>

            {/*
              Reversing a handover that did not happen.
              ------------------------------------------
              The patient could not pay, or changed their mind, and the
              medicine is still on this side of the counter. Stock goes back to
              the exact batches it came from, the prescription returns to the
              queue, and the invoice is voided.

              Deliberately NOT a returns feature. Medicine that has left cannot
              lawfully be resold in most places, so the pharmacist affirms it
              did not — that fact is the only thing distinguishing the two
              cases, and nothing in the data can tell them apart.
            */}
            {e.reversedAt ? (
              <p className="mt-1.5 rounded-sm border border-[#ecdca6] bg-warning-soft px-2 py-1 text-xs text-[#6b5314]">
                <strong>Reversed</strong> {dateTime(e.reversedAt)} — stock returned, invoice
                voided.
                {e.reversalReason ? ` ${e.reversalReason}` : ''}
              </p>
            ) : (
              <button
                onClick={() => setReversing(e.id)}
                className="mt-1.5 text-xs text-danger hover:underline"
              >
                Reverse — medicine not handed over
              </button>
            )}

            {reversing === e.id && (
              <div className="mt-2 rounded-sm border border-border bg-bg p-2.5">
                <p className="mb-1.5 text-xs text-text-muted">
                  Puts <strong>{e.lines.reduce((n, l) => n + l.quantity, 0)} units</strong> back
                  into the batches they came from, returns the prescription to the queue, and
                  voids the invoice.
                </p>
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={(ev) => setReason(ev.target.value)}
                  placeholder="Why — could not pay, changed their mind, wrong medicine picked."
                />
                <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={affirmed}
                    onChange={(ev) => setAffirmed(ev.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span>
                    I confirm this medicine <strong>did not leave the pharmacy</strong>. If the
                    patient has taken it, refund the invoice instead and put the stock back
                    through Receive stock.
                  </span>
                </label>
                {reverseError && <p className="mt-1 text-xs text-danger">{reverseError}</p>}
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="danger"
                    disabled={busy || reason.trim().length < 10 || !affirmed}
                    onClick={() => void reverse(e.id)}
                  >
                    {busy ? 'Reversing…' : 'Reverse dispense'}
                  </Button>
                  <Button onClick={() => setReversing(null)}>Cancel</Button>
                </div>
              </div>
            )}

            {e.notes && (
              <p
                className={`mt-1.5 text-xs ${
                  overridden ? 'font-semibold text-[#8a2a1f]' : 'text-text-muted'
                }`}
              >
                {e.notes}
              </p>
            )}
          </div>
        );
      })}

      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}
