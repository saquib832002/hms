'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { openDocument } from '@/lib/documents';
import type { LabOrder, LabTest, LabWorklistRow } from '@/lib/types';
import { dateTime, titleCase } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SectionLabel,
  TableSkeleton,
  Textarea,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { LabItemPanel } from '@/components/lab-result-table';
import { LabAttachments } from '@/components/lab-attachments';
import { useMoney } from '@/lib/use-money';
import { useUser } from '@/lib/auth-context';
import { canReach } from '@/lib/nav';

type Segment = 'sendout' | 'pending' | 'collected' | 'resulted' | 'completed';

/**
 * Where a scanned specimen lives on this screen.
 *
 * Derived from the order's own status rather than guessed, so a scan always
 * lands on the list containing the tube. IN_PROGRESS sits with COLLECTED
 * because the distinction is about the bench rather than about the specimen,
 * and the technician holding the tube is asking "has this been taken yet".
 */
function segmentFor(status: string): Segment {
  if (status === 'ORDERED') return 'pending';
  if (status === 'COLLECTED' || status === 'IN_PROGRESS') return 'collected';
  if (status === 'RESULTED') return 'resulted';
  return 'completed';
}

const SEGMENTS: { key: Segment; label: string }[] = [
  /*
   * Work leaving the building, still ours to draw and hand over.
   *
   * A clinic with a doctor and no bench takes the sample itself — the patient
   * is in its waiting room and pays its bill — and only the tube travels. Every
   * other segment is the hospital's own bench, and this one is the specimen,
   * which is why a PARTNER order belongs here and nowhere else.
   */
  { key: 'sendout', label: 'To send out' },
  { key: 'pending', label: 'To collect' },
  { key: 'collected', label: 'On the bench' },
  { key: 'resulted', label: 'To authorise' },
  { key: 'completed', label: 'Done' },
];

/**
 * The laboratory's own screen.
 *
 * SEGMENTED, NOT FILTERED TO THE OPEN ITEMS
 * -----------------------------------------
 * Fifth time in this codebase. The pharmacy invoice list hid every settled
 * invoice, the refund screen could not find a paid one, the referral queue
 * dropped a row the moment it was handed over. Filtering a list to the open
 * items is the natural thing to build and it is wrong every time, because the
 * question people bring to a screen is usually about something that has already
 * finished: "did that troponin ever come back" is asked precisely once a
 * pending-only list would have dropped it.
 *
 * WHY AUTHORISING IS ITS OWN COLUMN
 * ---------------------------------
 * Because it is the step that turns numbers into a result. Everything before it
 * is invisible to the ordering doctor by design, and a workflow that let
 * resulting and authorising happen in one tap would make that distinction
 * ceremonial.
 */
export default function LabWorklistPage() {
  const money = useMoney();
  /*
   * Two clinical roles read this screen — LAB_TECHNICIAN and, for the send-out
   * case, NURSE — and they can reach different screens from it. `canReach` is
   * derived from the nav table rather than a second list here, which is the
   * whole reason it exists.
   */
  const { role } = useUser();
  const [segment, setSegment] = useState<Segment>('pending');
  const [rows, setRows] = useState<LabWorklistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [resulting, setResulting] = useState<{ orderId: number; itemId: number } | null>(null);
  const [rejecting, setRejecting] = useState<LabWorklistRow | null>(null);
  const [scan, setScan] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const scanBox = useRef<HTMLInputElement>(null);
  /**
   * The row a scan just landed on.
   *
   * Highlighted rather than opened. A technician working a rack scans twenty
   * tubes in a row, and a detail page they have to dismiss each time turns a
   * one-handed job into a two-handed one.
   */
  const [highlight, setHighlight] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabWorklistRow[] }>(`/lab/worklist?status=${segment}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worklist');
    }
  }, [segment]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  /*
   * A STAT sample can arrive at any moment and this is a screen somebody leaves
   * open all shift. Fifteen seconds, matching the queues and the ward board.
   */
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  /**
   * Two actions, two literal paths.
   *
   * The first version of this took a path as an argument and passed it to
   * `api(path)`. Shorter, and invisible to `endpoint-coverage.spec.ts`, which
   * reads the literal at the call site — so both routes reported as having no
   * web caller, and the fix available then would have been a `MOBILE_ONLY`
   * exemption saying the web does not call them. That would have been false,
   * and a false reason in an exemption list is worse than no list.
   */
  /**
   * The tube has gone to the partner laboratory.
   *
   * The send-out half of a referral: the referral itself was transmitted at
   * ordering so the lab could expect the work, and this is the specimen
   * actually leaving. Two events, and the second one had nowhere to be
   * recorded — so a reference laboratory could not tell a referral it was
   * still waiting for from one whose tube was already in the van.
   */
  async function dispatchSpecimen(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api(`/lab/orders/${id}/dispatch`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  async function collect(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api(`/lab/orders/${id}/collect`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Authorising also transmits, when the work came from another hospital.
   *
   * `reportedBack` is read rather than ignored, and that is the fix. It was
   * returned by the API from the day the return leg was built and no client
   * anywhere looked at it — so a transmission that failed left the technician
   * looking at an ordinary success, the order left the worklist, and the doctor
   * at the other end waited for a result nobody was sending. The reason was in
   * the response the whole time.
   */
  async function verify(id: number) {
    setBusy(id);
    setError(null);
    try {
      const res = await api<{ reportedBack?: boolean; reportedBackError?: string | null }>(
        `/lab/orders/${id}/verify`,
        { method: 'POST', body: {} },
      );
      if (res.reportedBack === false) {
        setError(
          `Authorised, but the referring hospital was not sent the report: ${
            res.reportedBackError ?? 'the transmission failed'
          } — it is on the Completed tab with a Send report again button.`,
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Send it again, after it failed.
   *
   * Nothing else in the product could: `verify` refuses on an order that is
   * already authorised, so an authorised report that never transmitted was
   * stuck for good. Safe to press twice — the server refuses once the other
   * hospital actually has it, because a correction is a new order.
   */
  async function reportBack(id: number) {
    setBusy(id);
    setError(null);
    try {
      const res = await api<{ reportedBack?: boolean; reportedBackError?: string | null }>(
        `/lab/orders/${id}/report-back`,
        { method: 'POST', body: {} },
      );
      if (res.reportedBack === false) {
        setError(res.reportedBackError ?? 'The referring hospital still could not be reached');
      }
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  /**
   * A specimen number, scanned or typed.
   *
   * THIS IS THE WHOLE SCANNER INTEGRATION, AND THAT IS NOT A SHORTCUT
   * -----------------------------------------------------------------
   * Bench barcode scanners are keyboard-wedge devices: they type the characters
   * and press Enter, exactly as a person would. So a focused text input *is*
   * the driver, and it works with every scanner on the market without
   * configuration, without a permission prompt, and without a camera. This is
   * what a real laboratory information system presents, and building a camera
   * pipeline for a desktop would be solving a problem the hardware already
   * solved thirty years ago.
   *
   * The check character is verified on the server before anything is looked
   * up, so a mistyped number is refused rather than resolving to somebody
   * else's specimen.
   */
  async function findByAccession(e: React.FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;

    setScanError(null);
    try {
      const order = await api<LabOrder>(`/lab-orders/by-accession/${encodeURIComponent(code)}`);
      setScan('');
      /*
       * Filtered rather than navigated away. A technician scanning a rack of
       * tubes wants each one to surface in the list they are working, not to
       * be thrown onto a detail page they have to come back from twenty times.
       */
      /*
       * Jump to the segment the tube is actually in, rather than assuming it is
       * in the one being viewed. A technician scanning a rack has no idea which
       * stage each specimen reached, and landing on an empty list reads as the
       * scan having failed.
       */
      setSegment(segmentFor(order.status));
      setHighlight(order.id);
    } catch (err) {
      // Kept on screen next to the box rather than replacing the worklist —
      // a failed scan must not cost the technician the list they were working.
      setScanError(err instanceof Error ? err.message : 'Could not find that specimen');
    } finally {
      scanBox.current?.focus();
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text">Laboratory worklist</h1>
          <p className="text-sm text-text-muted">Tests requested at this hospital.</p>
        </div>

        {/*
          Scan a tube to find it. Autofocused, because the first thing a
          technician does at this screen is pick up a rack and a scanner — and
          a wedge scanner types into whatever has focus, so a box that has to
          be clicked first is a box that drops the first scan of every session.
        */}
        <form onSubmit={findByAccession} className="flex items-center gap-2">
          <Input
            ref={scanBox}
            autoFocus
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Scan or type a specimen number"
            className="w-64 font-mono"
          />
          <Button type="submit" size="sm">
            Find
          </Button>
        </form>
      </div>

      {scanError && (
        <p className="mb-2 text-sm text-danger">{scanError}</p>
      )}

      <div className="mb-4 flex gap-1.5">
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSegment(s.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              segment === s.key
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border text-text-muted hover:border-primary'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {!rows ? (
        <TableSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            segment === 'sendout'
              ? 'Nothing to send out'
              : segment === 'pending'
                ? 'Nothing waiting'
                : 'Nothing here'
          }
          description={
            /*
              An empty send-out list has two very different causes and the
              screen has to distinguish them: a clinic that has drawn and
              couriered everything, and a laboratory that never sends work out
              at all. Saying what the tab is *for* covers both — the same
              reason an unbuilt screen and an empty table must not render
              identically.
            */
            segment === 'sendout'
              ? 'Tests going to a partner laboratory appear here until the specimen has been taken and handed to the courier. A laboratory that runs everything itself never has any.'
              : segment === 'pending'
              /*
                This used to end "ones being run at a partner lab are not on
                this list — they are on somebody else's", which stopped being
                true the moment the send-out tab existed. A partner order *is*
                on this screen now, because the specimen is drawn here; what
                happens elsewhere is the examination.
              */
              ? 'Tests to be taken on this hospital’s own bench. Ones going to a partner laboratory are under To send out — the specimen is still drawn here.'
              : 'Try another tab.'
          }
        />
      ) : (
        rows.map((r) => (
          <div
            key={r.id}
            /* The row a scan just landed on, so the technician's eye goes
               straight to it in a list of forty. */
            className={`mb-2.5 rounded-md border bg-surface ${
              highlight === r.id ? 'border-primary ring-1 ring-primary' : 'border-border'
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2">
              {/*
                The specimen number, first and in monospace.

                It is what the technician is holding, what they scanned, and
                what they will read out if they ring the ward. A row that does
                not show it makes them open the order to check they scanned the
                right tube.
              */}
              <span className="font-mono text-xs font-semibold text-primary">
                {r.accession ?? '— no specimen no.'}
              </span>
              {/*
                What is owed, and a way to take it.
                ---------------------------------
                The person drawing the blood is standing in front of the
                patient — the only moment the money is easy to collect — and
                the row said an invoice existed without saying whether it was
                settled, which is the half that decides whether to ask.

                **A link, never a gate.** Nothing in collection, dispatch or
                resulting reads this: the tube is drawn either way, and the
                same rule `lab-billing.spec.ts` asserts the absence of one
                level down. It is a shortcut to the next task, not a condition
                on the last one.
              */}
              {r.invoice && r.invoice.settled && (
                <span className="self-center rounded-full bg-success-soft px-2 py-0.5 text-xxs font-semibold uppercase text-success">
                  Paid
                </span>
              )}

              {/*
                A link only for somebody who can actually follow it.

                NURSE may collect a send-out specimen — that is the whole point
                of the send-out segment, since a clinic with no bench has no
                technician — and `/lab/invoices` is LAB_TECHNICIAN's screen, so
                `canReach` bounces them. A nurse was being offered *Take
                payment* and landing back on their own ward board.

                A refusal with no route out, in the one screen this project
                added to close a refusal with no route out. The state is still
                worth telling them: they are standing in front of the patient
                and can say "there is 120.00 to settle at the desk", which is
                the useful half. What they cannot do is take it.
              */}
              {r.invoice && !r.invoice.settled && canReach(role, '/lab/invoices') && (
                <Link
                  href={`/lab/invoices?invoice=${r.invoice.id}`}
                  className="self-center rounded-md border border-warning px-2.5 py-1 text-xs font-semibold text-[#6b5314] hover:bg-warning-soft"
                >
                  Take payment · {money(r.invoice.outstanding)} due
                </Link>
              )}

              {r.invoice && !r.invoice.settled && !canReach(role, '/lab/invoices') && (
                <span
                  className="self-center rounded-full bg-warning-soft px-2 py-0.5 text-xxs font-semibold uppercase text-[#6b5314]"
                  title="Payable at the desk. Your role cannot open the till."
                >
                  {money(r.invoice.outstanding)} due
                </span>
              )}

              {/*
                Raise a charge that never got raised.

                Offered only where there is no invoice, so it is invisible on
                the ordinary case and present on exactly the orders that went
                out unbilled — which is the state nobody could get out of
                before: the price is captured at ordering, so pricing the
                catalogue afterwards fixed the next order and not this one.
              */}
              {r.invoiceId === null && (
                <button
                  onClick={async () => {
                    setError(null);
                    try {
                      await api(`/lab-orders/${r.id}/charge`, { method: 'POST', body: {} });
                      await load();
                    } catch (e) {
                      setError(e instanceof ApiError ? e.message : 'Could not raise that charge');
                    }
                  }}
                  className="text-xxs text-warning underline hover:text-text"
                >
                  Raise charge
                </button>
              )}

              {/*
                Always offered, even with no number yet.
                --------------------------------------
                Printing a label is somebody deciding a tube is about to exist,
                so it *allocates* the number for an order raised before
                accessions existed. Hiding the button for exactly those orders
                would leave "no specimen no." as a permanent state with no way
                out of it — which is what was reported, and the shape this
                project has had to reopen six times.

                Reprintable at any point too. Labels smudge, peel and get stuck
                to the wrong tube, and the answer to all three is another one.
              */}
              <button
                onClick={async () => {
                  const res = await openDocument('specimen-labels', r.id);
                  // Refetched only on success, because printing may have just
                  // allocated the number and a row still reading "no specimen
                  // no." beside a label that has one is worse than either
                  // alone. On failure the reason is in the tab, and repeated
                  // here so it is visible without leaving the worklist.
                  if (!res.ok) setError(res.message ?? 'Could not print those labels');
                  else if (!r.accession) await load();
                }}
                className="text-xxs text-text-muted underline hover:text-text"
              >
                {r.accession ? 'Labels' : 'Get number & labels'}
              </button>
              <span className="text-sm font-semibold text-text">{r.patient.fullName}</span>
              {/* Age and sex are on the row because reference ranges are banded
                  by both — a technician checking a value needs them in front of
                  them, not one screen away. */}
              <span className="text-xs text-text-muted">
                {age(r.patient.dob)} · {titleCase(r.patient.gender)}
              </span>
              <span className="font-mono text-xxs text-text-subtle">#{r.patient.id}</span>
              {r.priority !== 'ROUTINE' && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xxs font-semibold uppercase ${
                    r.priority === 'STAT'
                      ? 'bg-danger-soft text-[#8a2a1f]'
                      : 'bg-warning-soft text-[#6b5314]'
                  }`}
                >
                  {r.priority}
                </span>
              )}
              <span className="ml-auto text-xxs text-text-subtle">
                Requested {dateTime(r.orderedAt)} by {r.requestedBy}
              </span>
            </div>

            {r.clinicalDetails && (
              <p className="border-b border-border px-3 py-1.5 text-xs text-text-muted">
                <span className="font-semibold text-text">Clinical details:</span>{' '}
                {r.clinicalDetails}
              </p>
            )}

            {r.rejectReason && (
              <p className="border-b border-border bg-warning-soft px-3 py-1.5 text-xs text-[#6b5314]">
                <strong>Previous sample rejected:</strong> {r.rejectReason}. Another one is needed.
              </p>
            )}

            {/*
              Work another hospital sent us, and whether they have the answer.

              Said on the row rather than left to be discovered, because the
              failure is otherwise invisible from both ends: this laboratory
              sees an authorised report and the referring hospital sees an order
              still in progress, and neither screen mentions the other. The
              patient is the one waiting.

              Only rendered for referred work — `referredFrom` is null on this
              hospital's own orders, which is why it is a name and not a flag.
            */}
            {r.referredFrom && r.reportedBack === false && r.status === 'VERIFIED' && (
              <p className="border-b border-border bg-danger-soft px-3 py-1.5 text-xs text-[#8a2a1f]">
                <strong>Not sent to {r.referredFrom}.</strong> This report is authorised here and
                they do not have it. Send it again below, and ring them if it keeps failing.
              </p>
            )}

            {r.referredFrom && r.reportedBack === true && (
              <p className="border-b border-border px-3 py-1.5 text-xs text-text-muted">
                Referred by {r.referredFrom} — the report has been sent back to them.
              </p>
            )}

            <ul className="px-3 py-2">
              {r.items.map((i) => (
                <li key={i.id} className="flex items-baseline gap-2 py-0.5">
                  <span className="font-mono text-xs text-text-muted">{i.testCode}</span>
                  <span className="text-sm">{i.testName}</span>
                  <span className="text-xxs text-text-subtle">
                    {i.specimenType === 'NONE' ? 'no specimen' : titleCase(i.specimenType)}
                  </span>
                  {i.hasCritical && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xxs font-semibold uppercase text-[#8a2a1f]">
                      {i.criticalNotifiedAt ? 'critical · called' : 'critical · not called'}
                    </span>
                  )}
                  {(r.status === 'COLLECTED' ||
                    r.status === 'IN_PROGRESS' ||
                    r.status === 'RESULTED') && (
                    <button
                      onClick={() => setResulting({ orderId: r.id, itemId: i.id })}
                      className="ml-auto text-xs text-primary hover:underline"
                    >
                      {i.resultedAt ? 'Edit result' : 'Enter result'}
                    </button>
                  )}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
              {(r.status === 'ORDERED' || r.status === 'REJECTED') && (
                <Button
                  variant="primary"
                  disabled={busy === r.id}
                  onClick={() => void collect(r.id)}
                >
                  {r.items.every((i) => i.specimenType === 'NONE')
                    ? 'Patient attended'
                    : 'Specimen taken'}
                </Button>
              )}

              {/*
                Hand the tube to the courier.
                ----------------------------
                Only on a send-out, and only once it has been drawn. Marking a
                specimen sent before it exists tells the partner something is
                on its way when it is not — and they then wait for a van rather
                than ringing to ask.

                Separate from collection because the gap is real: a sample
                drawn at 09:14 and couriered at 16:00 spent the day on a bench,
                and the laboratory reading it needs to know that.
              */}
              {r.destination === 'PARTNER' && !r.dispatchedAt && (
                <Button
                  variant={r.status === 'ORDERED' ? 'default' : 'primary'}
                  disabled={busy === r.id || r.status === 'ORDERED'}
                  onClick={() => void dispatchSpecimen(r.id)}
                  title={
                    r.status === 'ORDERED'
                      ? 'Take the specimen first — a tube cannot be sent before it has been drawn.'
                      : undefined
                  }
                >
                  Sent to the lab
                </Button>
              )}

              {r.destination === 'PARTNER' && r.dispatchedAt && (
                <span className="self-center text-xs text-text-muted">
                  Sent {dateTime(r.dispatchedAt)} — the laboratory reports back onto this request.
                </span>
              )}

              {r.status !== 'ORDERED' && r.status !== 'VERIFIED' && (
                /*
                 * Rejecting is not cancelling, and the button says so. It sends
                 * the request back for another sample rather than ending it —
                 * the distinction that stops "we need more blood" reading as
                 * "never mind" to the doctor who is waiting.
                 */
                <Button disabled={busy === r.id} onClick={() => setRejecting(r)}>
                  Sample unusable
                </Button>
              )}

              {r.status === 'RESULTED' && (
                <Button
                  variant="primary"
                  disabled={busy === r.id}
                  onClick={() => void verify(r.id)}
                >
                  Authorise report
                </Button>
              )}

              {r.status === 'VERIFIED' && (
                <Button onClick={() => void openDocument('lab-orders', r.id)}>Print report</Button>
              )}

              {/*
                The route out of a failed transmission.

                Offered on exactly the rows where it applies, which is what
                stops it reading as a general "resend" that somebody presses on
                a report the other hospital already acted on. The server refuses
                that anyway — a correction is a new order — but a button nobody
                should press is a button that eventually gets pressed.
              */}
              {r.referredFrom && r.reportedBack === false && r.status === 'VERIFIED' && (
                <Button
                  variant="primary"
                  disabled={busy === r.id}
                  onClick={() => void reportBack(r.id)}
                >
                  Send report again
                </Button>
              )}
            </div>
          </div>
        ))
      )}

      {resulting && (
        <ResultSheet
          orderId={resulting.orderId}
          itemId={resulting.itemId}
          onClose={() => setResulting(null)}
          onSaved={() => {
            setResulting(null);
            void load();
          }}
        />
      )}

      {rejecting && (
        <RejectSheet
          row={rejecting}
          onClose={() => setRejecting(null)}
          onSaved={() => {
            setRejecting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Entering one test's result.
 *
 * The analyte rows come from the catalogue so the technician types values
 * rather than names, and the server flags them — never the client. Flagging
 * here would mean two implementations of the reference-range comparison, and a
 * disagreement between them is a value that reads as normal on one screen and
 * high on another.
 */
function ResultSheet({
  orderId,
  itemId,
  onClose,
  onSaved,
}: {
  orderId: number;
  itemId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [order, setOrder] = useState<LabOrder | null>(null);
  const [test, setTest] = useState<LabTest | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState('');
  const [impression, setImpression] = useState('');
  const [methodology, setMethodology] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [critical, setCritical] = useState<string[] | null>(null);
  const [notifiedTo, setNotifiedTo] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const o = await api<LabOrder>(`/lab-orders/${orderId}`);
        setOrder(o);
        const item = o.items.find((i) => i.id === itemId);
        setFindings(item?.findings ?? '');
        setImpression(item?.impression ?? '');
        setMethodology(item?.methodology ?? '');
        setValues(Object.fromEntries((item?.values ?? []).map((v) => [v.analyteName, v.value])));

        const catalogue = await api<{ data: LabTest[] }>('/lab-tests');
        setTest(catalogue.data.find((t) => t.code === item?.testCode) ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load that test');
      }
    })();
  }, [orderId, itemId]);

  const item = order?.items.find((i) => i.id === itemId);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ critical: string[] }>(`/lab/items/${itemId}/result`, {
        method: 'POST',
        body: {
          values: (test?.analytes ?? [])
            .filter((a) => (values[a.name] ?? '').trim())
            .map((a) => ({ analyteName: a.name, value: values[a.name].trim(), unit: a.unit })),
          findings: findings.trim() || null,
          impression: impression.trim() || null,
          methodology: methodology.trim() || null,
        },
      });

      /*
       * A critical value stops the sheet rather than closing it.
       *
       * Nothing in this system telephones anybody, and it says so. What it can
       * do is refuse to let the moment pass silently: the technician is here,
       * now, with the number in front of them, and closing straight back to a
       * list is how a potassium of 7.2 becomes something somebody notices
       * tomorrow.
       */
      if (res.critical.length > 0) {
        setCritical(res.critical);
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save that result');
    } finally {
      setBusy(false);
    }
  }

  async function recordCall() {
    setBusy(true);
    try {
      await api(`/lab/items/${itemId}/critical-notified`, {
        method: 'POST',
        body: { notifiedTo: notifiedTo.trim() },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  /** Fixing a missing price where it is discovered, not two screens away. */
  async function savePrice() {
    if (!test) return;
    setBusy(true);
    try {
      await api(`/lab-tests/${test.id}`, { method: 'PATCH', body: { sellingPrice: price.trim() } });
      setTest({ ...test, sellingPrice: price.trim() });
      setPrice('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set that price');
    } finally {
      setBusy(false);
    }
  }

  if (critical) {
    return (
      <Sheet
        open
        onClose={onSaved}
        title="Critical result"
        footer={
          <>
            <Button
              variant="primary"
              disabled={busy || notifiedTo.trim().length < 2}
              onClick={() => void recordCall()}
            >
              Record the call
            </Button>
            <Button onClick={onSaved}>Not yet</Button>
          </>
        }
      >
        <div className="rounded-sm border border-[#f2c4be] bg-danger-soft px-3 py-2 text-sm text-[#8a2a1f]">
          <strong>{critical.join(', ')}</strong> {critical.length === 1 ? 'is' : 'are'} outside the
          critical range for this test.
        </div>

        {/* The honest sentence. A button that looks like it pages somebody and
            does not is worse than no button, because the technician stops
            making the call. */}
        <p className="mt-3 text-sm text-text-muted">
          Nothing here notifies anybody. Telephone the requesting clinician, then record who you
          spoke to — that record is what an incident review asks for and it has nowhere else to
          live.
        </p>

        <Field label="Who you told" required>
          <Input
            value={notifiedTo}
            onChange={(e) => setNotifiedTo(e.target.value)}
            placeholder="Dr Rao, medical on-call, 03:40"
          />
        </Field>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={item ? `${item.testCode} — ${item.testName}` : 'Enter result'}
      footer={
        <>
          <Button variant="primary" disabled={busy || !order} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save result'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {order && (
        <div className="rounded border border-border bg-bg p-2.5">
          <div className="text-md font-bold">{order.patient?.fullName}</div>
          <div className="text-xs text-text-muted">
            {order.patient && `${age(order.patient.dob)} · ${titleCase(order.patient.gender)}`}
          </div>
          {order.clinicalDetails && (
            <p className="mt-1 text-xs text-text-muted">{order.clinicalDetails}</p>
          )}
        </div>
      )}

      {test && test.sellingPrice === null && (
        /*
         * Priced here, where the gap is found. "Not priced" on the pharmacy's
         * dispensing screen was a dead end that sent the pharmacist to another
         * screen with a patient at the counter, and in practice the medicine
         * went out unpriced and the loss surfaced a month later.
         */
        <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-2.5 py-2 text-sm text-[#6b5314]">
          <strong>Nobody has priced this test.</strong> It will be performed and not charged for.
          <div className="mt-2 flex gap-2">
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="max-w-32"
            />
            <Button disabled={busy || !price.trim()} onClick={() => void savePrice()}>
              Set price
            </Button>
          </div>
        </div>
      )}

      {test && test.analytes.length > 0 && (
        <>
          <SectionLabel>Values</SectionLabel>
          {test.analytes.map((a) => (
            <div key={a.id} className="mb-2 flex items-end gap-2">
              <Field label={a.name} hint={a.display ?? 'No reference range set'}>
                <Input
                  value={values[a.name] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                  /* Not type="number". "<0.01" and "No growth" are real
                     laboratory results, and a numeric input would refuse them. */
                  placeholder={a.unit ?? ''}
                  className="font-mono"
                />
              </Field>
              <span className="pb-2 text-xs text-text-muted">{a.unit}</span>
            </div>
          ))}
        </>
      )}

      {test && test.analytes.length === 0 && (
        <p className="mt-3 text-xs text-text-subtle">
          This test has no analytes defined, so it reports as narrative only — which is how imaging
          and histopathology work. An administrator can add analytes under Lab Tests if it should
          have measured values.
        </p>
      )}

      <SectionLabel>Report</SectionLabel>
      <Field label="Findings">
        <Textarea rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} />
      </Field>
      <Field label="Impression" hint="What a clinician in a hurry reads first.">
        <Textarea rows={2} value={impression} onChange={(e) => setImpression(e.target.value)} />
      </Field>
      <Field label="Method" hint="Optional — the assay, analyser or stain, where it matters.">
        <Input value={methodology} onChange={(e) => setMethodology(e.target.value)} />
      </Field>

      {/*
        Attached files sit with the report rather than in a separate step,
        because for a histopathology or an imaging result the file IS the
        report — the narrative boxes above are a summary of it.
      */}
      <SectionLabel>Files</SectionLabel>
      <LabAttachments
        orderId={orderId}
        itemId={itemId}
        canUpload
        authorised={order?.status === 'VERIFIED'}
      />

      {item && item.values.length > 0 && (
        <>
          <SectionLabel>Currently recorded</SectionLabel>
          <LabItemPanel item={item} />
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

/**
 * The sample could not be used.
 *
 * A reason is required, and the wording is the point: this asks for another
 * sample rather than closing the request. A bare "rejected" sends the ward to
 * the telephone, which is what the worklist replaces.
 */
function RejectSheet({
  row,
  onClose,
  onSaved,
}: {
  row: LabWorklistRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try {
      await api(`/lab/orders/${row.id}/reject`, { method: 'POST', body: { reason: reason.trim() } });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Sample unusable"
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || reason.trim().length < 6}
            onClick={() => void submit()}
          >
            Ask for another sample
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p className="text-sm text-text-muted">
        This does not cancel the request. It goes back to <strong>To collect</strong> so another
        sample can be taken from {row.patient.fullName}, and your reason is what tells them why.
      </p>

      <Field label="What was wrong" required>
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Haemolysed. Please resend in a fresh EDTA tube."
        />
      </Field>

      {error && <p className="text-sm text-danger">{error}</p>}
    </Sheet>
  );
}

/** Age in years, from a date of birth. */
function age(dob: string): string {
  const d = new Date(dob);
  const now = new Date();
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) years--;
  return `${years}y`;
}
