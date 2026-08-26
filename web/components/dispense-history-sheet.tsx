'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, EmptyState, Skeleton } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

interface HistoryEvent {
  id: number;
  dispensedAt: string;
  notes: string | null;
  pharmacist: { id: number; fullName: string } | null;
  prescription: { id: number; patient: { id: number; fullName: string } | null } | null;
  lines: { id: number; quantity: number; medicine: { name: string } | null }[];
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
