'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { SupplyRequest } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { Button, EmptyState, ErrorState, Field, Input, TableSkeleton } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * Ward supply requests.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * --------------------------------------------
 * A ward asking for stock of something a doctor has already prescribed. It is a
 * *logistics* queue: the clinical decision was made when the prescription was
 * written, and the only question here is whether the pharmacy sends it.
 *
 * The other request — a nurse asking for something not prescribed at all — goes
 * to a doctor, not here. They read alike and a single queue would route half of
 * each to the wrong person, with a drug supplied that nobody prescribed as the
 * available failure.
 *
 * **Marking supplied moves no stock.** The medicine leaves the shelf through
 * dispensing, where batches, expiry, the allergy check and pricing all happen
 * properly and are counted once. A decrement here would give the hospital a
 * second stock ledger, and the day one was forgotten the count would still look
 * plausible — the same argument that keeps counter sales inside `DispenseEvent`.
 */
const TABS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'supplied', label: 'Supplied' },
  { key: 'declined', label: 'Declined' },
] as const;

export default function SupplyRequestsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('waiting');
  const [rows, setRows] = useState<SupplyRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<SupplyRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api<SupplyRequest[]>(`/supply-requests?status=${tab}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load supply requests');
    }
  }, [tab]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: declining === null,
  });

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  async function supply(r: SupplyRequest) {
    setBusy(true);
    try {
      await api(`/supply-requests/${r.id}/supply`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not mark that supplied');
    } finally {
      setBusy(false);
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-4 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-sm px-2.5 py-1 text-sm ${
              tab === t.key ? 'bg-primary-soft font-semibold text-primary' : 'text-text-muted'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      {error && rows && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!rows && <TableSkeleton cols={5} />}

        {rows?.length === 0 && (
          <EmptyState
            title={tab === 'waiting' ? 'Nothing waiting' : `No ${tab} requests`}
            description={
              tab === 'waiting'
                ? 'Wards ask here when they have run out of something already prescribed.'
                : undefined
            }
          />
        )}

        {rows && rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Asked', 'Patient', 'Bed', 'Medicine', 'Qty', 'Note', ''].map((h) => (
                  <th
                    key={h}
                    className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#fafbfc]">
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    {dateTime(r.requestedAt)}
                    {r.requestedBy && (
                      <div className="text-xxs text-text-subtle">{r.requestedBy.fullName}</div>
                    )}
                  </td>
                  {/*
                    The patient is named. That is how the wrong medicine going
                    to the wrong bed is caught at the counter rather than at the
                    bedside — the same reason the dispensing queue names them,
                    and the same reason admin is excluded from all of this.
                  */}
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                    {r.admission.patient.fullName}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    {r.admission.bed?.label ?? '—'}
                    <div className="text-xxs text-text-subtle">
                      {r.admission.bed?.ward?.name ?? ''}
                    </div>
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">
                    {r.prescriptionItem.medicineName}
                    <div className="font-mono text-xxs text-text-subtle">
                      {r.prescriptionItem.dosage} · {r.prescriptionItem.frequency}
                    </div>
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    {r.quantity ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-xs text-text-muted">
                    {r.note ?? ''}
                    {r.responseNote && (
                      <div className="mt-0.5 text-text">
                        {r.respondedBy ? <strong>{r.respondedBy.fullName}: </strong> : null}
                        {r.responseNote}
                      </div>
                    )}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-right">
                    {/*
                      Actions only on the waiting tab. An answered request
                      cannot be answered again — the server refuses it, and
                      offering the button then explaining the refusal is worse
                      than not offering it.
                    */}
                    {r.status === 'REQUESTED' && (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void supply(r)}>
                          Supplied
                        </Button>
                        <Button size="sm" onClick={() => setDeclining(r)}>
                          Decline
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <DeclineSheet
        request={declining}
        onClose={() => setDeclining(null)}
        onDeclined={() => {
          setDeclining(null);
          void load();
        }}
        onError={setError}
      />
    </>
  );
}

/**
 * Declining, with a reason the ward can act on.
 *
 * "Out of stock, ordered, expect Thursday" changes what the nurse does next. A
 * bare refusal does not, and sends them to the phone — which is the thing this
 * queue was built to replace.
 */
function DeclineSheet({
  request,
  onClose,
  onDeclined,
  onError,
}: {
  request: SupplyRequest | null;
  onClose: () => void;
  onDeclined: () => void;
  onError: (m: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setReason(''), [request]);

  async function save() {
    if (!request) return;
    setBusy(true);
    try {
      await api(`/supply-requests/${request.id}/decline`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      onDeclined();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not decline that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={request !== null}
      onClose={onClose}
      title="Decline this request"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 5}
            onClick={() => void save()}
          >
            {busy ? 'Declining…' : 'Decline'}
          </Button>
        </div>
      }
    >
      {request && (
        <div className="space-y-3">
          <div className="rounded border border-border bg-bg p-2.5">
            <div className="font-semibold">{request.prescriptionItem.medicineName}</div>
            <div className="font-mono text-xs text-text-muted">
              {request.admission.patient.fullName} · {request.admission.bed?.label ?? '—'}
            </div>
          </div>

          <Field
            label="Why"
            required
            hint="The ward sees this. Say what they should do next — a bare refusal sends them to the phone."
          >
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Out of stock, ordered, expect Thursday"
            />
          </Field>
        </div>
      )}
    </Sheet>
  );
}
