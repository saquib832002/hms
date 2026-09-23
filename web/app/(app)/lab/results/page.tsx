'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { openDocument } from '@/lib/documents';
import type { LabOrder, Paginated, PatientListItem } from '@/lib/types';
import { dateTime, titleCase } from '@/lib/format';
import {
  Button,
  EmptyState,
  Field,
  Input,
  TableSkeleton,
  Textarea,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { LabAuthorisationNotice, LabItemPanel } from '@/components/lab-result-table';
import { LabOrderSheet } from '@/components/lab-order-sheet';
import { LabAttachments } from '@/components/lab-attachments';

/**
 * Investigations, from the clinician's side.
 *
 * WHY THIS IS A PER-PATIENT SCREEN AND NOT A FEED
 * -----------------------------------------------
 * "What came back today" sounds like the useful view and is not the question a
 * doctor actually has. They have a patient in front of them, or on the
 * telephone, and they want that person's results — the feed version means
 * scanning a list of other people's names for the one they care about.
 *
 * There is no "results awaiting my attention" list, and that is a real gap
 * rather than a decision: it needs a notion of acknowledgement that does not
 * exist here yet, and half-building it would produce a list that never empties.
 * Written down in CLAUDE.md rather than faked.
 *
 * WHAT IS DELIBERATELY NOT SHOWN
 * ------------------------------
 * Values the laboratory has not authorised. The API withholds them, and
 * `LabAuthorisationNotice` names the state instead — an unverified result
 * rendered as an empty panel is indistinguishable from a test that found
 * nothing, which is the most dangerous available misreading.
 */
export default function LabResultsPage() {
  const [query, setQuery] = useState('');
  const [patients, setPatients] = useState<PatientListItem[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [patient, setPatient] = useState<PatientListItem | null>(null);
  const [orders, setOrders] = useState<LabOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [cancelling, setCancelling] = useState<LabOrder | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setPatients([]);
      return;
    }
    const t = setTimeout(() => {
      /*
       * `q`, not `search`.
       *
       * The first version sent `?search=`, which the global pipe rejects with
       * `forbidNonWhitelisted` — correctly — and the catch below swallowed the
       * 400 into an empty list. So the dropdown was permanently empty and the
       * screen looked like it simply could not find anybody. The failure is
       * shown now rather than absorbed: "no matches" and "the request was
       * refused" are different facts and only one of them means try a different
       * name.
       */
      void api<Paginated<PatientListItem>>(`/patients?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => {
          setPatients(r.data);
          setSearchError(null);
        })
        .catch((e) => {
          setPatients([]);
          setSearchError(e instanceof Error ? e.message : 'Could not search patients');
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    if (!patient) return;
    setError(null);
    try {
      const res = await api<{ data: LabOrder[] }>(`/patients/${patient.id}/lab-orders`);
      setOrders(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load results');
    }
  }, [patient]);

  useEffect(() => {
    setOrders(null);
    void load();
  }, [load]);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3">
        <h1 className="text-lg font-semibold text-text">Lab results</h1>
        <p className="text-sm text-text-muted">
          Find a patient to see what has been requested and what has come back.
        </p>
      </div>

      <div className="relative mb-4 max-w-md">
        <Input
          value={patient ? patient.fullName : query}
          onChange={(e) => {
            setPatient(null);
            setQuery(e.target.value);
          }}
          placeholder="Patient name or number…"
          autoComplete="off"
        />
        {/* Said out loud. A silently empty dropdown reads as "no such patient",
            which sends somebody looking for a spelling mistake that is not
            there. */}
        {!patient && searchError && (
          <p className="mt-1 text-xs text-danger">{searchError}</p>
        )}

        {!patient && patients.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
            {patients.slice(0, 8).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setPatient(p);
                  setPatients([]);
                }}
                className="flex w-full items-baseline gap-2 border-b border-[#f0f2f4] px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-primary-soft"
              >
                <span className="font-medium">{p.fullName}</span>
                <span className="font-mono text-xxs text-text-subtle">#{p.id}</span>
                <span className="ml-auto text-xs text-text-muted">{p.age}y</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!patient ? (
        <EmptyState
          title="Search for a patient"
          description="Results are attached to the patient, including ones a partner laboratory ran — their report arrives here on the request you raised."
        />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
            <div>
              <div className="font-semibold">{patient.fullName}</div>
              <div className="font-mono text-xs text-text-muted">#{patient.id}</div>
            </div>
            <Button variant="primary" onClick={() => setOrdering(true)}>
              Request tests
            </Button>
          </div>

          {error && <p className="mb-3 text-sm text-danger">{error}</p>}

          {!orders ? (
            <TableSkeleton rows={3} />
          ) : orders.length === 0 ? (
            <EmptyState
              title="Nothing requested"
              description="No investigations have been raised for this patient."
            />
          ) : (
            orders.map((o) => (
              <div key={o.id} className="mb-3 rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-text-muted">#{o.id}</span>
                  <span className="text-sm font-medium">{titleCase(o.status)}</span>
                  {o.priority !== 'ROUTINE' && (
                    <span className="text-xxs uppercase text-text-subtle">{o.priority}</span>
                  )}
                  {o.destination !== 'IN_HOUSE' && (
                    <span className="text-xxs uppercase text-text-subtle">
                      {o.destination === 'PARTNER' ? 'partner lab' : 'external'}
                    </span>
                  )}
                  <span className="ml-auto text-xxs text-text-subtle">
                    Requested {dateTime(o.orderedAt)} by {o.requestedBy}
                  </span>
                </div>

                {o.clinicalDetails && (
                  <p className="mb-2 text-xs text-text-muted">{o.clinicalDetails}</p>
                )}

                <LabAuthorisationNotice order={o} />

                {o.resultsAuthorised ? (
                  o.items.map((i) => <LabItemPanel key={i.id} item={i} />)
                ) : (
                  /* The tests are still listed even where the values are
                     withheld: "what did I ask for" is a different question from
                     "what came back", and only one of them needs authorising. */
                  <ul className="mb-2">
                    {o.items.map((i) => (
                      <li key={i.id} className="flex items-baseline gap-2 py-0.5">
                        <span className="font-mono text-xs text-text-muted">{i.testCode}</span>
                        <span className="text-sm">{i.testName}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Only once authorised — the API withholds them before that,
                    and a report PDF leaving the lab unsigned is exactly what
                    the verify gate exists to prevent. */}
                {o.resultsAuthorised && (
                  <LabAttachments orderId={o.id} canUpload={false} authorised />
                )}

                <div className="mt-2 flex gap-2">
                  {o.resultsAuthorised && (
                    <Button onClick={() => void openDocument('lab-orders', o.id)}>
                      Print report
                    </Button>
                  )}
                  {/*
                   * Retracting an order, with a caller built in the same change
                   * that added the endpoint. `PATCH /prescriptions/:id/cancel`
                   * has been correct, tested and unreachable since Phase 4 — the
                   * most serious of the endpoints with no way in.
                   */}
                  {o.status !== 'VERIFIED' && o.status !== 'CANCELLED' && (
                    <Button onClick={() => setCancelling(o)}>Cancel request</Button>
                  )}
                </div>
              </div>
            ))
          )}
        </>
      )}

      {patient && (
        <LabOrderSheet
          open={ordering}
          onClose={() => setOrdering(false)}
          patientId={patient.id}
          patientName={patient.fullName}
          onSaved={() => {
            setOrdering(false);
            void load();
          }}
        />
      )}

      {cancelling && (
        <CancelSheet
          order={cancelling}
          onClose={() => setCancelling(null)}
          onSaved={() => {
            setCancelling(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CancelSheet({
  order,
  onClose,
  onSaved,
}: {
  order: LabOrder;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try {
      await api(`/lab-orders/${order.id}/cancel`, {
        method: 'PATCH',
        body: { reason: reason.trim() },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not cancel that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Cancel request #${order.id}`}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || reason.trim().length < 6}
            onClick={() => void submit()}
          >
            Cancel the request
          </Button>
          <Button onClick={onClose}>Keep it</Button>
        </>
      }
    >
      <p className="text-sm text-text-muted">
        The laboratory sees this immediately.{' '}
        {order.collectedAt
          ? 'A sample has already been taken, so the charge stands — the work was real.'
          : 'Nothing has been collected yet, so the charge is voided with it.'}
      </p>

      <Field label="Why" required>
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ordered in error — duplicate of yesterday's request."
        />
      </Field>

      {/* A cancelled test with no reason is indistinguishable from one
          cancelled by accident, and the person who finds it is the next doctor
          wondering why a result never came. */}
      <p className="text-xs text-text-subtle">
        This is kept on the record. It is what the next person reads when they wonder why no result
        arrived.
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}
    </Sheet>
  );
}
