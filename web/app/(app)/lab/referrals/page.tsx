'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { LabReferral, LabTest } from '@/lib/types';
import { date, dateTime, titleCase } from '@/lib/format';
import { BILLING_LABEL_INBOUND } from '@/lib/referral-billing';
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

type Segment = 'waiting' | 'resulted' | 'declined';

/**
 * Work sent here by another hospital.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE PHARMACY'S INBOUND QUEUE
 * ----------------------------------------------------------
 * A prescription referral ends when the medicine is handed over, and the
 * sending hospital never hears again. A lab referral cannot end that way: the
 * result is the deliverable, so reporting one writes it back into the ordering
 * hospital's own records, where their doctor finds it on the patient's file.
 *
 * That is the only place in this system where one tenant writes into another's
 * data, and the constraints are worth knowing while using the screen: every
 * test on the referral has to be reported together, it can only be done once,
 * and it is refused outright if the ordering hospital has already authorised
 * something itself.
 *
 * SEGMENTED, NOT FILTERED TO THE OPEN ITEMS
 * -----------------------------------------
 * "Which hospitals send us work, and what happened to it" is asked precisely
 * once a waiting-only list would have dropped the row.
 */
export default function LabReferralsPage() {
  const [segment, setSegment] = useState<Segment>('waiting');
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  /** What just happened, including a charge that could not be raised in full. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Set when the notice above has an invoice worth jumping to. */
  const [noticeInvoiceId, setNoticeInvoiceId] = useState<number | null>(null);
  /*
   * The referral whose tests need saying which of ours they are.
   *
   * Only opened when the codes did not line up — two independent businesses
   * have no reason to share a compendium, so `FBC` here and `CBC` there is
   * normal. Where they do agree, Accept is one click and this never appears.
   */
  const [mapping, setMapping] = useState<LabReferral | null>(null);
  const [catalogue, setCatalogue] = useState<LabTest[]>([]);
  const [rows, setRows] = useState<LabReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<LabReferral | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabReferral[] }>(`/lab/referrals?status=${segment}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load incoming work');
    }
  }, [segment]);

  /**
   * Take the work on, raising this laboratory's own order for it.
   *
   * The server maps the sender's test codes onto this lab's catalogue and
   * registers the referred patient — flagged, so they stay out of reception's
   * search. A code this lab does not offer is refused *by name* rather than
   * skipped, because the answer is either to add it to the catalogue or to
   * decline, and both are decisions a person makes.
   */
  async function accept(referral: LabReferral) {
    setBusyId(referral.id);
    setError(null);
    try {
      const res = await api<{ invoiceId: number | null; unpriced: string[] }>(
        `/lab/referrals/${referral.id}/accept`,
        { method: 'POST', body: {} },
      );
      /*
       * Hand straight over to payment — but only when there is somebody to
       * take it from.
       *
       * Under ORIGIN_PAYS the debtor is the referring hospital: the charge was
       * raised a second ago, nobody is standing at the counter, and the invoice
       * still has to be seen or nobody is sure it exists. That is the case this
       * redirect was built for, reported as "it is silently generating the
       * invoice, people may not know we need to take the money".
       *
       * Under PATIENT_PAYS the payer has not arrived yet. They walk in to give
       * the sample, which is when the money is taken — so opening a payment
       * form now shows a form for an absent person and drops the technician out
       * of the queue they were working. The unpaid invoice surfaces at
       * collection instead, where the patient actually is.
       */
      if (referral.billing === 'ORIGIN_PAYS' && res.invoiceId && !res.unpriced.length) {
        router.push(`/lab/invoices?invoice=${res.invoiceId}`);
        return;
      }

      if (referral.billing === 'PATIENT_PAYS' && res.invoiceId && !res.unpriced.length) {
        setNotice(
          `Accepted. ${referral.patientName} pays here — take it when they come in to give the sample.`,
        );
        setNoticeInvoiceId(res.invoiceId);
        await load();
        return;
      }

      /*
       * Except when something was left unpriced. Then stay put and name it —
       * that notice is the one thing on this screen the technician can still
       * act on, and opening a payment form on top of it buries it. The same
       * rule the dispensing sheet follows.
       */
      /*
       * A charge was raised but something was also left unpriced. Both facts
       * matter and only one can be the destination, so the warning is the
       * message and taking the payment is a link on it.
       */
      setNotice(
        res.unpriced.length
          ? `Accepted. Not charged for: ${res.unpriced.join(', ')} — price them in the catalogue, then raise the charge.`
          : 'Accepted. No charge was raised — the tests have no price set.',
      );
      setNoticeInvoiceId(res.invoiceId);
      await load();
    } catch (e) {
      /*
       * An unmapped test is not an error to report and stop at — it is a
       * question, and the answer is two dropdowns away. The old message told
       * the technician to add the test to the catalogue, which is an
       * administrator's job and therefore an instruction they cannot follow.
       */
      if (e instanceof ApiError && /which of your tests/i.test(e.message)) {
        const tests = await api<{ data: LabTest[] }>('/lab-tests').catch(() => ({ data: [] }));
        setCatalogue(tests.data);
        setMapping(referral);
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not accept that referral');
      }
    } finally {
      setBusyId(null);
    }
  }

  /** Accept again, this time saying which of our tests each one is. */
  async function acceptMapped(referral: LabReferral, chosen: Record<number, number>) {
    setBusyId(referral.id);
    setError(null);
    try {
      await api(`/lab/referrals/${referral.id}/accept`, {
        method: 'POST',
        body: {
          mappings: Object.entries(chosen).map(([referralItemId, labTestId]) => ({
            referralItemId: Number(referralItemId),
            labTestId,
          })),
        },
      });
      setMapping(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not accept that referral');
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3">
        <h1 className="text-lg font-semibold text-text">Incoming</h1>
        <p className="text-sm text-text-muted">
          Tests other hospitals have sent to your laboratory.
        </p>
      </div>

      <div className="mb-4 flex gap-1.5">
        {(
          [
            ['waiting', 'Waiting'],
            ['resulted', 'Reported'],
            ['declined', 'Declined'],
          ] as [Segment, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSegment(key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              segment === key
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border text-text-muted hover:border-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && (

        <div className="mb-3 rounded-md border border-border bg-surface px-3 py-2 text-sm">
          {notice}
          {noticeInvoiceId !== null && (
            <button
              onClick={() => router.push(`/lab/invoices?invoice=${noticeInvoiceId}`)}
              className="ml-2 font-medium text-primary hover:underline"
            >
              Take the payment →
            </button>
          )}
        </div>

      )}

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {!rows ? (
        <TableSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description={
            segment === 'waiting'
              ? 'Work appears here when a hospital that has added your code sends a test. Nothing arrives until an administrator at your end has switched on “accept orders from other hospitals”.'
              : 'Try another tab.'
          }
        />
      ) : (
        rows.map((r) => (
          <div key={r.id} className="mb-2.5 rounded-md border border-border bg-surface">
            <div className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2">
              <span className="font-mono text-sm font-semibold tracking-widest text-primary">
                {r.reference}
              </span>
              <span className="text-sm font-medium">{r.patientName}</span>
              {r.patientDob && (
                <span className="text-xs text-text-muted">b. {date(r.patientDob)}</span>
              )}
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
              {/*
                Who owes for it, before the technician takes it on.
                --------------------------------------------------
                Not decoration: it decides what happens on this screen next.
                An institutional debt is recorded now and chased later; the
                patient's is collected when they walk in with their arm out.
                Reading it after accepting is too late — the redirect has
                already happened.
              */}
              <span
                className={`rounded-sm px-1.5 py-0.5 text-xxs font-semibold uppercase ${
                  r.billing === 'PATIENT_PAYS'
                    ? 'bg-accent-soft text-accent'
                    : 'bg-bg text-text-muted'
                }`}
                title={BILLING_LABEL_INBOUND[r.billing]}
              >
                {r.billing === 'PATIENT_PAYS' ? 'Patient pays' : 'Hospital pays'}
              </span>
              {/*
                Their order number, quoted back.

                A send-out with two identifiers and no mapping between them is
                how a telephone call about a tube becomes twenty minutes of
                searching — real reference laboratories print the referring
                site's number beside their own for exactly this reason.
              */}
              {r.sourceAccession && (
                <span className="font-mono text-xxs text-text-muted">
                  their ref {r.sourceAccession}
                </span>
              )}
              {/*
                Whether the tube exists yet, and how old it is.
                ---------------------------------------------
                A send-out is drawn at the referring hospital and couriered —
                the patient was never here. So a referral with no draw time is
                one whose specimen has not been taken, transmitted so this
                laboratory can expect the work; showing nothing makes that
                indistinguishable from a sample that has gone missing.

                Time since draw is clinical, not decoration: a potassium from a
                six-hour-old tube is a different number.
              */}
              <span
                className={`text-xxs ${
                  r.collectedAt ? 'text-text-muted' : 'text-warning'
                }`}
              >
                {r.collectedAt
                  ? `drawn ${dateTime(r.collectedAt)}${
                      r.dispatchedAt ? ` · sent ${dateTime(r.dispatchedAt)}` : ' · not yet sent'
                    }`
                  : 'specimen not yet taken'}
              </span>
              <span className="ml-auto text-xxs text-text-subtle">
                From {r.from} · {dateTime(r.receivedAt)}
              </span>
            </div>

            {r.clinicalDetails && (
              <p className="border-b border-border px-3 py-1.5 text-xs text-text-muted">
                <span className="font-semibold text-text">Clinical details:</span>{' '}
                {r.clinicalDetails}
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
                </li>
              ))}
            </ul>

            {/* The outcome is rendered from the row rather than inferred from
                which tab returned it, so a list that mixes states still reads
                correctly. */}
            {r.declinedAt && (
              <p className="border-t border-border bg-bg px-3 py-1.5 text-xs text-text-muted">
                <strong>Declined</strong> {dateTime(r.declinedAt)} — {r.declineReason}
              </p>
            )}
            {r.resultedAt && (
              <p className="border-t border-border bg-bg px-3 py-1.5 text-xs text-text-muted">
                <strong>Reported</strong> {dateTime(r.resultedAt)}. Sent back to {r.from}.
              </p>
            )}

            {/* Actions only on the waiting tab. A Report button beside a row
                that was reported last week is a trap. */}
            {/*
              Accepted work lives on the worklist, not here.

              Reporting used to happen straight from this queue — values typed
              into a form and transmitted — which skipped specimen acceptance,
              the bench and authorisation. "Nothing is a result until it is
              verified" held for this hospital's own orders and not for the work
              it did for anybody else, which is backwards: under ISO 15189 the
              performing laboratory owns the examination and its release.
            */}
            {r.acceptedAt && !r.resultedAt && !r.declinedAt && (
              <div className="border-t border-border px-3 py-2 text-sm text-text-muted">
                <strong>On the worklist</strong> — accepted {dateTime(r.acceptedAt)}. Collect the
                specimen, run it, then authorise; the result goes back to {r.from} on
                authorisation.
              </div>
            )}

            {!r.acceptedAt && !r.resultedAt && !r.declinedAt && (
              <div className="flex gap-2 border-t border-border px-3 py-2">
                <Button variant="primary" disabled={busyId === r.id} onClick={() => void accept(r)}>
                  Accept
                </Button>
                <Button onClick={() => setDeclining(r)}>Decline</Button>
              </div>
            )}
          </div>
        ))
      )}

      {mapping && (
        <MapTestsSheet
          referral={mapping}
          catalogue={catalogue}
          busy={busyId === mapping.id}
          onClose={() => setMapping(null)}
          onAccept={(chosen) => void acceptMapped(mapping, chosen)}
        />
      )}

      {declining && (
        <DeclineSheet
          referral={declining}
          onClose={() => setDeclining(null)}
          onSaved={() => {
            setDeclining(null);
            void load();
          }}
        />
      )}
    </div>
  );
}


/**
 * Say which of this laboratory's tests the referred ones are.
 *
 * WHY THIS SCREEN EXISTS
 * ----------------------
 * Accepting matched on the test *code*, and refused everything else with "add
 * it to the catalogue" — an instruction the technician reading it cannot
 * follow, because creating a test is an administrator's job. A correct refusal
 * with no route out is the shape this project has hit repeatedly; this is the
 * route out.
 *
 * It is also how reference laboratories actually work. Codes are local
 * vocabulary: one hospital's `FBC` is another's `CBC`, and two independent
 * businesses have no reason to have agreed a compendium. Inbound codes get
 * mapped to the performing lab's own, once, by somebody who knows both.
 */
function MapTestsSheet({
  referral,
  catalogue,
  busy,
  onClose,
  onAccept,
}: {
  referral: LabReferral;
  catalogue: LabTest[];
  busy: boolean;
  onClose: () => void;
  onAccept: (chosen: Record<number, number>) => void;
}) {
  const [chosen, setChosen] = useState<Record<number, number>>({});

  // Every test has to be answered. A referral accepted with one silently
  // dropped would produce a report that looks complete and is not.
  const complete = referral.items.every((i) => chosen[i.id]);

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Accept ${referral.reference}`}
      footer={
        <>
          <Button variant="primary" disabled={!complete || busy} onClick={() => onAccept(chosen)}>
            {busy ? 'Accepting…' : 'Accept onto the worklist'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-text-muted">
        {referral.from} uses their own test codes. Say which of yours each one is — this laboratory
        runs its own test, under its own reference ranges.
      </p>

      <div className="space-y-3">
        {referral.items.map((item) => (
          <div key={item.id}>
            <div className="text-sm font-medium">
              {item.testName}{' '}
              <span className="font-mono text-xs text-text-subtle">{item.testCode}</span>
            </div>
            <select
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              value={chosen[item.id] ?? ''}
              onChange={(e) =>
                setChosen((prev) => ({ ...prev, [item.id]: Number(e.target.value) }))
              }
            >
              <option value="">Choose one of your tests…</option>
              {catalogue.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {catalogue.length === 0 && (
        <p className="mt-3 text-sm text-danger">
          This laboratory has no active tests at all. An administrator adds them under Lab Tests
          before any work can be accepted.
        </p>
      )}
    </Sheet>
  );
}

function DeclineSheet({
  referral,
  onClose,
  onSaved,
}: {
  referral: LabReferral;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try {
      await api(`/lab/referrals/${referral.id}/decline`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not decline that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Decline ${referral.reference}`}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || reason.trim().length < 6}
            onClick={() => void submit()}
          >
            Decline and tell them
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {/* The reason travels. A hospital that never learns its sample was
          rejected is a hospital whose patient is waiting for a result nobody
          is producing. */}
      <p className="text-sm text-text-muted">
        {referral.from} sees this on their own order, and it lands as{' '}
        <strong>another sample is needed</strong> rather than as a cancellation. Say what went
        wrong — a bare refusal sends them to the telephone.
      </p>

      <Field label="Why" required>
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Sample degraded in transit. Please resend, packed cold."
        />
      </Field>

      {error && <p className="text-sm text-danger">{error}</p>}
    </Sheet>
  );
}

