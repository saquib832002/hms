'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import type { PrescriptionReferral } from '@/lib/types';
import { date } from '@/lib/format';
import { Button, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * Prescriptions written at another hospital and sent to this pharmacy.
 *
 * WHAT THESE ARE
 * --------------
 * Copies, not a window into somebody else's records. The prescribing hospital
 * transmitted a snapshot into this tenant; it is owned here and protected by
 * this hospital's own policy like any other row. There is deliberately no link
 * back — this pharmacy cannot read that patient's history, and is not meant to.
 *
 * WHY THE ALLERGY LINE IS SO PROMINENT
 * ------------------------------------
 * The sending hospital does not transmit allergies. That is the right call for
 * minimum-necessary across a company boundary, and it has a consequence a
 * pharmacist must not discover by assuming: **no allergy check was run at all**.
 * An empty warnings panel would read as "nothing found", which is a completely
 * different statement. The counter sale makes the same distinction for the same
 * reason.
 */
type Segment = 'waiting' | 'dispensed' | 'declined';

const SEGMENTS: { key: Segment; label: string; hint: string }[] = [
  { key: 'waiting', label: 'Waiting', hint: 'Sent here, not yet handed over' },
  { key: 'dispensed', label: 'Dispensed', hint: 'Already filled at this counter' },
  { key: 'declined', label: 'Declined', hint: 'Refused, with the reason given' },
];

export default function ReferralsPage() {
  const [rows, setRows] = useState<PrescriptionReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  /*
   * Waiting / Dispensed / Declined.
   *
   * The list used to be waiting-only, so once a referral was handed over it
   * left the screen and there was nowhere else to look — "which patients did
   * the other hospital send us, and what happened to them" could not be
   * answered even though every row records it.
   *
   * Third time this shape has appeared here: the pharmacy invoice list hid
   * every settled invoice, and the refund screen could not find a paid one.
   * Filtering a list to the open items is the natural thing to build and it
   * is wrong every time, because a question people bring to a screen is
   * usually about something that has already finished.
   */
  const [segment, setSegment] = useState<Segment>('waiting');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: PrescriptionReferral[] }>(
        `/pharmacy/referrals?status=${segment}`,
      );
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load incoming prescriptions');
    }
  }, [segment]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load);

  useEffect(() => {
    void load();
  }, [load]);

  async function decline(id: number) {
    try {
      await api(`/pharmacy/referrals/${id}/decline`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      setDeclining(null);
      setReason('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not decline that');
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text">Incoming prescriptions</h1>
          <p className="text-sm text-text-muted">
            Written at another hospital and sent here. The patient quotes the reference.
          </p>
        </div>
        <div className="ml-auto">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {SEGMENTS.map((seg) => (
          <button
            key={seg.key}
            onClick={() => setSegment(seg.key)}
            title={seg.hint}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              segment === seg.key
                ? 'border-primary bg-primary-soft font-medium text-primary'
                : 'border-border bg-surface text-text-muted hover:text-text'
            }`}
          >
            {seg.label}
          </button>
        ))}
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {!rows ? (
        <TableSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            segment === 'waiting'
              ? 'Nothing waiting'
              : segment === 'dispensed'
                ? 'Nothing dispensed yet'
                : 'Nothing declined'
          }
          description={
            segment === 'waiting'
              ? 'Prescriptions sent here by partner hospitals appear in this list.'
              : 'Referrals move here once they have been handled.'
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <article key={r.id} className="rounded-md border border-border bg-surface p-4">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-lg font-semibold tracking-widest text-primary">
                  {r.reference}
                </span>
                <span className="font-medium text-text">{r.patientName}</span>
                {r.patientDob && (
                  <span className="text-xs text-text-subtle">born {date(r.patientDob)}</span>
                )}
                <span className="ml-auto text-xs text-text-subtle">
                  {r.from} · {date(r.issuedAt)}
                </span>
              </div>

              <p className="mt-0.5 text-xs text-text-muted">
                Prescribed by {r.prescriberName}
                {r.prescriberRegistrationNo ? ` (${r.prescriberRegistrationNo})` : ''}
              </p>

              {/*
                Each line as written, then what it comes to.
                -------------------------------------------
                "Amoxicillin 500mg · 2 · 7" made the pharmacist do the
                arithmetic — and work out first that "2" meant twice a day.
                Mental maths at a counter is where dispensing errors come
                from, so the total is stated.

                The doctor's own text is kept above the total rather than
                replaced by it. The prescription is what was written; this is
                a reading of it, and a pharmacist has to be able to see both to
                catch a misreading.
              */}
              <ul className="mt-2 space-y-1.5 text-sm">
                {r.items.map((i, n) => (
                  <li key={n}>
                    <span className="font-medium">{i.medicineName}</span>
                    <span className="text-text-muted">
                      {' '}
                      — {i.dosage}, {i.frequency}, {i.duration}
                    </span>

                    <div className="text-xs">
                      <span className="text-text">
                        {i.dosage}, {i.frequencyLabel}
                        {i.durationLabel ? ` for ${i.durationLabel}` : ''}
                      </span>
                      {i.totalUnits ? (
                        <span className="ml-2 rounded-sm bg-primary-soft px-1.5 py-0.5 font-semibold text-primary">
                          Dispense {i.totalUnits.amount} {i.totalUnits.unit}
                        </span>
                      ) : i.totalDoses ? (
                        <span className="ml-2 rounded-sm bg-primary-soft px-1.5 py-0.5 font-semibold text-primary">
                          {i.totalDoses} doses
                        </span>
                      ) : (
                        /* Said, not left blank. A missing total and a
                           deliberately withheld one look identical. */
                        <span className="ml-2 text-warning">Quantity not calculated</span>
                      )}
                    </div>

                    {(i.interpretation || i.whyNot) && (
                      <p className="text-xxs text-text-subtle">
                        {[i.interpretation, i.whyNot].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>

              {/*
                "Not checked" is not "nothing found". The sending hospital does
                not transmit allergies, so there is nothing here to check
                against — and a pharmacist who assumes silence means safety is
                the exact failure this line exists to prevent.
              */}
              <p className="mt-2 rounded-sm border border-[#ecdca6] bg-warning-soft px-2.5 py-1.5 text-xs text-[#6b5314]">
                <strong>No allergy check was run.</strong> Allergies are not sent between
                hospitals — ask the patient before dispensing.
              </p>

              {/* The outcome, on the row. A history entry that does not say
                  what happened is just an older copy of the queue. */}
              {r.dispensedAt && (
                <p className="mt-2 text-xs text-success">
                  Dispensed {date(r.dispensedAt)} at this counter.
                </p>
              )}
              {r.declinedAt && (
                <p className="mt-2 text-xs text-danger">
                  Declined {date(r.declinedAt)}
                  {r.declineReason ? ` — ${r.declineReason}` : ''}
                </p>
              )}

              <div className="mt-3 flex items-center gap-2">
                {/* Dispensed through the counter sale, because the prescription
                    belongs to another hospital and there is no local row to
                    key on. The pharmacist maps the names to their own stock. */}
                {/* Link, not <a>: a full document load drops the in-memory
                    access token and lands the pharmacist on the login screen
                    mid-dispense. */}
                {/* Only while it is still open. A Dispense button on an
                    already-filled referral is an invitation to hand the same
                    medicine over twice — the server refuses, but the refusal
                    should not be the first time anybody finds out. */}
                {segment === 'waiting' && (
                  <>
                    <Link href={`/pharmacy/sell?referral=${r.id}`}>
                      <Button variant="primary">Dispense</Button>
                    </Link>
                    <Button onClick={() => setDeclining(declining === r.id ? null : r.id)}>
                      Decline
                    </Button>
                  </>
                )}
              </div>

              {declining === r.id && (
                <div className="mt-2">
                  <textarea
                    className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
                    rows={2}
                    placeholder="Why — out of stock, wrong pharmacy, patient never came. The sending hospital cannot ask."
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    variant="danger"
                    className="mt-1"
                    disabled={reason.trim().length < 6}
                    onClick={() => void decline(r.id)}
                  >
                    Confirm decline
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
