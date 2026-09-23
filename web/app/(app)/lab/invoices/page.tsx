'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Invoice, LabStatement, LabStatements } from '@/lib/types';
import { openDocument } from '@/lib/documents';
import { PeriodPicker, periodQuery, type Period } from '@/components/period-picker';
import { date } from '@/lib/format';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { InvoiceSheet } from '@/components/invoice-sheet';
import { useMoney } from '@/lib/use-money';

/**
 * The laboratory's own till.
 *
 * WHY THIS IS NOT THE BILLING SCREEN WITH A FILTER
 * ------------------------------------------------
 * In SEPARATE mode the lab is a different business with different books. The
 * server scopes the list by role, so this screen, `/pharmacy/invoices` and
 * `/billing/invoices` return three disjoint sets even though they render the
 * same way. One screen with a dropdown would suggest they are one ledger seen
 * through different lenses, which is what the SEPARATE setting says they are
 * not.
 *
 * WHAT A TECHNICIAN SEES ON THESE INVOICES
 * ----------------------------------------
 * The test names — they ran them. A billing clerk looking at the same invoice
 * gets `LAB · Tests (n items)` and a total, because a test name is frequently
 * the clinical question itself. `invoice-response.ts` decides that, per role,
 * and the PDF obeys the same rule because a PDF is a response.
 *
 * WHAT IS MISSING, DELIBERATELY
 * -----------------------------
 * No "create invoice" and no void. A lab invoice is raised by an order — one
 * typed by hand would be a charge with no requisition behind it. Voiding
 * belongs with cancelling the order, which is where "was any of this actually
 * done" can be answered: the charge is voided only while nothing has been
 * collected, and refused once a payment has been taken.
 */
type Segment = 'outstanding' | 'paid' | 'closed';

export default function LabInvoicesPage() {
  const fmt = useMoney();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [segment, setSegment] = useState<Segment>('outstanding');
  const [error, setError] = useState<string | null>(null);

  /*
   * `?invoice=` opens that invoice's payment form on arrival.
   *
   * Accepting a referral hands straight over to it, exactly as dispensing does.
   * The charge was raised a second ago and somebody has to collect it — an
   * invoice that appears silently in a list is one nobody is sure was raised,
   * and the person who would have taken the money has already moved on.
   */
  const router = useRouter();
  const params = useSearchParams();
  const opened = params.get('invoice');
  const [selected, setSelected] = useState<number | null>(
    opened && Number.isFinite(Number(opened)) ? Number(opened) : null,
  );

  /**
   * Who owes it: a patient at the counter, or a hospital that referred work.
   *
   * A laboratory doing send-out work keeps two ledgers with very different
   * shapes — patients paying today, and institutions invoiced monthly. Mixed
   * into one list the second is a handful of "no patient" rows scattered
   * through the first, and *what do referring hospitals owe us* cannot be
   * answered at all. Reported exactly that way.
   */
  const [payer, setPayer] = useState<'all' | 'patient' | 'institution' | 'statements'>('all');

  /**
   * The month being billed, as one page per hospital.
   *
   * WHY A FOURTH TAB RATHER THAN A FOURTH SCREEN
   * --------------------------------------------
   * This is the same ledger asked a different question. `Referring hospitals`
   * lists the invoices; `Statements` groups a month of them into the single
   * document a laboratory actually posts, which is what the recipient pays. A
   * separate screen would make them look like two sets of books, which is
   * exactly what the SEPARATE setting says the *pharmacy* and the lab are and
   * these are not.
   *
   * Blank means the current month, resolved on the server in the hospital's own
   * timezone — a referral accessioned at 23:40 on the 30th in Asia/Kolkata is
   * already the 1st in UTC, and bucketing it here would post it onto the wrong
   * statement.
   */
  const [period, setPeriod] = useState<Period | null>(null);
  const [statements, setStatements] = useState<LabStatements | null>(null);

  /**
   * The lines behind one hospital's month, read before it is sent.
   *
   * Fetched on demand rather than with the summary: a laboratory with thirty
   * partners would otherwise pull every referral of the month to draw a table
   * of thirty rows. It is also the answer to a question the summary cannot
   * settle — *is this right* — and posting a statement nobody checked is the
   * one thing worse than posting none.
   */
  const [detail, setDetail] = useState<LabStatement | null>(null);
  const [detailFor, setDetailFor] = useState<number | null>(null);

  async function toggleLines(sourceTenantId: number, forPeriod: Period | null) {
    if (detailFor === sourceTenantId) {
      setDetailFor(null);
      setDetail(null);
      return;
    }
    setDetailFor(sourceTenantId);
    setDetail(null);
    try {
      setDetail(
        /*
         * Both branches written out, because `endpoint-coverage.spec.ts` reads
         * the literal at the call site and two adjacent interpolations collapse
         * into `/lab/statements/` with no parameter — the route then reads as
         * having no caller and as being one nothing declares. The same reason
         * `documents.ts` carries one literal per document.
         */
        forPeriod
          ? await api<LabStatement>(
              `/lab/statements/${sourceTenantId}?from=${encodeURIComponent(
                forPeriod.from,
              )}&to=${encodeURIComponent(forPeriod.to)}`,
            )
          : await api<LabStatement>(`/lab/statements/${sourceTenantId}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that statement');
      setDetailFor(null);
    }
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      if (payer === 'statements') {
        // A literal per call, because `endpoint-coverage.spec.ts` reads the
        // literal at the call site and an interpolated path is invisible to it.
        setStatements(await api<LabStatements>(`/lab/statements${periodQuery(period)}`));
        return;
      }

      const res =
        payer === 'institution'
          ? await api<{ data: Invoice[] }>('/lab/invoices?payer=institution')
          : payer === 'patient'
            ? await api<{ data: Invoice[] }>('/lab/invoices?payer=patient')
            : await api<{ data: Invoice[] }>('/lab/invoices');
      setInvoices(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load lab invoices');
    }
  }, [payer, period]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !invoices) return <ErrorState message={error} onRetry={() => void load()} />;

  const all = invoices ?? [];
  const rows = all.filter((i) => {
    if (i.voidedAt) return segment === 'closed';
    if (segment === 'outstanding') return !i.settled;
    if (segment === 'paid') return i.settled;
    return false;
  });

  const minor = (s: string) => Math.round(Number(s) * 100);
  const totalMinor = rows.reduce(
    (sum, i) => sum + minor(segment === 'outstanding' ? i.outstanding : i.amountPaid),
    0,
  );

  const SEGMENTS: { key: Segment; label: string; hint: string }[] = [
    { key: 'outstanding', label: 'Outstanding', hint: 'Requested, not yet paid for' },
    { key: 'paid', label: 'Paid', hint: 'Settled — refund from here' },
    { key: 'closed', label: 'Voided', hint: 'Cancelled before any sample was taken' },
  ];

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      {/*
        Why this screen opened by itself.

        Arriving here is a handover from the act that raised the charge —
        accepting a referral, or requesting a test. The payment sheet opens on
        its own, and without a line saying why that reads as the app having
        jumped somewhere at random. Reported as "it silently generates the
        invoice, people may not know we need to take the money".
      */}
      {opened && selected !== null && (
        <p className="mb-3 rounded-md border border-primary bg-primary-soft px-3 py-2 text-sm font-medium">
          Charge raised — take the payment now.
        </p>
      )}

      <div className="mb-3 flex items-center gap-2">
        <div>
          <h1 className="text-lg font-semibold text-text">Lab invoices</h1>
          <p className="text-sm text-text-muted">
            Charges raised when a test was requested. Take payment and issue refunds here.
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

      {/*
        Two ledgers, one screen. Named after the payer rather than the invoice
        kind, because "referring hospitals" is the question somebody arrives
        with and `patientId === null` is the answer to a different one.
      */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {(
          [
            ['all', 'Everyone'],
            ['patient', 'Patients'],
            ['institution', 'Referring hospitals'],
            /*
              A month of referred work as the one page that gets posted.
              Beside the invoices rather than instead of them: the invoices are
              the record, the statement is what the recipient pays.
            */
            ['statements', 'Statements'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setPayer(key)}
            className={`rounded-sm px-2.5 py-1 text-xs ${
              payer === key
                ? 'bg-primary-soft font-semibold text-primary'
                : 'text-text-muted hover:bg-bg'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        A month of referred work, per hospital, as one page to send.

        WHAT IS ON THIS TABLE AND WHAT IS NOT
        -------------------------------------
        A count of tests and the money. No test names anywhere — a test name is
        frequently the clinical question itself, and this is the view somebody
        prints and posts to another company where a finance clerk opens it. The
        same rule `labSummaryDescription` follows on an invoice line, applied
        where it matters most.
      */}
      {payer === 'statements' && (
        <div className="mb-4">
          <PeriodPicker
            value={period}
            onChange={setPeriod}
            label={
              statements
                ? `${statements.label} · ${fmt(statements.outstanding)} outstanding of ${fmt(statements.total)}`
                : undefined
            }
            busy={!statements}
          />

          <div className="overflow-hidden rounded-md border border-border bg-surface">
            {!statements ? (
              <TableSkeleton cols={5} />
            ) : statements.data.length === 0 ? (
              <EmptyState
                title={`Nothing referred in ${statements.label}`}
                description="A statement appears here for every hospital that sent us work we agreed to invoice them for. Work a patient paid for at this counter is not on one — they settled it themselves."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
                  <tr>
                    <th className="px-3 py-2">Hospital</th>
                    <th className="px-3 py-2 text-right">Referrals</th>
                    <th className="px-3 py-2 text-right">Tests</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Outstanding</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {/*
                    Two rows per hospital: the summary, and the lines when
                    somebody has asked to check them. Returned as an array
                    rather than a fragment because a `<tbody>` may not contain
                    anything else, and a fragment with a key renders one.
                  */}
                  {statements.data.flatMap((s) => [
                    <tr key={s.sourceTenantId} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{s.hospital}</td>
                      <td className="px-3 py-2 text-right text-xs text-text-muted">
                        {s.referrals}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-text-muted">{s.tests}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(s.total)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {s.settled ? (
                          <span className="rounded-full bg-success-soft px-2 py-0.5 text-xxs font-semibold uppercase text-success">
                            Settled
                          </span>
                        ) : (
                          fmt(s.outstanding)
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/*
                          Read it before it is posted. A statement nobody
                          checked is the one thing worse than no statement, and
                          the summary above cannot settle "is this right".
                        */}
                        <button
                          onClick={() =>
                            void toggleLines(s.sourceTenantId, { from: statements.from, to: statements.to })
                          }
                          className="mr-3 text-xs text-primary hover:underline"
                        >
                          {detailFor === s.sourceTenantId ? 'Hide lines' : 'Check lines'}
                        </button>
                        <button
                          onClick={async () => {
                            const res = await openDocument(
                              'lab-statements',
                              s.sourceTenantId,
                              { from: statements.from, to: statements.to },
                            );
                            if (!res.ok) setError(res.message ?? 'Could not print that statement');
                          }}
                          className="text-xs text-primary hover:underline"
                        >
                          Print statement
                        </button>
                      </td>
                    </tr>,
                    detailFor === s.sourceTenantId ? (
                      <tr key={`${s.sourceTenantId}-lines`} className="border-t border-border">
                        <td colSpan={6} className="bg-bg px-3 py-2">
                          {!detail ? (
                            <p className="text-xs text-text-muted">Reading the month…</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead className="text-left uppercase text-text-subtle">
                                <tr>
                                  <th className="py-1">Date</th>
                                  <th className="py-1">Their ref.</th>
                                  <th className="py-1">Our ref.</th>
                                  <th className="py-1 text-right">Tests</th>
                                  <th className="py-1 text-right">Amount</th>
                                  <th className="py-1 text-right">Outstanding</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.lines.map((l) => (
                                  <tr key={l.invoiceId} className="border-t border-border">
                                    <td className="py-1 text-text-muted">{date(l.issuedAt)}</td>
                                    {/* Theirs first: it is the only number the
                                        recipient can match to anything. */}
                                    <td className="py-1 font-mono">{l.sourceAccession ?? '—'}</td>
                                    <td className="py-1 font-mono text-text-muted">
                                      {l.accession ?? '—'}
                                    </td>
                                    <td className="py-1 text-right text-text-muted">{l.tests}</td>
                                    <td className="py-1 text-right font-mono">{fmt(l.amount)}</td>
                                    <td className="py-1 text-right font-mono">
                                      {fmt(l.outstanding)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ) : null,
                  ])}
                </tbody>
              </table>
            )}
          </div>

          {/*
            Said plainly, because the tempting misreading is that pressing Print
            has told the other hospital something. It has not — this system
            writes them a notice at accession and nothing since, and the page is
            for a human to send.
          */}
          <p className="mt-3 text-xs text-text-subtle">
            Printing does not send anything. The hospital sees each charge as a
            notice when we accept the work; this page is the month gathered into
            one document for you to post or email, and each side records its own
            settlement.
          </p>
        </div>
      )}

      {payer !== 'statements' && (
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSegment(s.key)}
            title={s.hint}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              segment === s.key
                ? 'border-primary bg-primary-soft font-medium text-primary'
                : 'border-border bg-surface text-text-muted hover:text-text'
            }`}
          >
            {s.label}
            <span className="ml-1.5 text-xs opacity-70">
              {
                all.filter((i) =>
                  i.voidedAt
                    ? s.key === 'closed'
                    : s.key === 'outstanding'
                      ? !i.settled
                      : s.key === 'paid'
                        ? i.settled
                        : false,
                ).length
              }
            </span>
          </button>
        ))}

        {segment !== 'closed' && rows.length > 0 && (
          <span className="ml-auto text-sm text-text-muted">
            {segment === 'outstanding' ? 'Owed' : 'Taken'}{' '}
            <span className="font-mono font-semibold text-text">
              {fmt((totalMinor / 100).toFixed(2))}
            </span>
          </span>
        )}
      </div>
      )}

      {payer !== 'statements' && (
      <div className="overflow-hidden rounded-md border border-border bg-surface">
        {!invoices ? (
          <TableSkeleton cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              segment === 'outstanding'
                ? 'Nothing outstanding'
                : segment === 'paid'
                  ? 'Nothing settled yet'
                  : 'Nothing voided'
            }
            description={
              segment === 'outstanding'
                ? 'Every test requested has been paid for.'
                : 'Charges appear here as soon as a doctor requests a test. Tests with no price raise no charge — check the catalogue if you expected one.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">
                  {segment === 'outstanding' ? 'Outstanding' : 'Paid'}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setSelected(i.id)}
                  className="cursor-pointer border-t border-border hover:bg-bg"
                >
                  <td className="px-3 py-2 font-mono text-xs text-text-muted">#{i.id}</td>
                  {/*
                    The doctor's order number, on the row.

                    It was already inside each line's description, and the
                    lines are one click *in* — so a till showing forty rows
                    gave no way to tell which order any of them was for without
                    opening every one. Apple to apple, on the list.
                  */}
                  <td className="px-3 py-2 font-mono text-xs">
                    {i.labAccessions?.length
                      ? i.labAccessions.join(', ')
                      : <span className="text-text-subtle">—</span>}
                  </td>
                  {/* Referred work is billed to the hospital that sent it, so the payer
                    is a company rather than a person. A dash there reads as
                    missing data. */}
                <td className="px-3 py-2">{i.patient?.fullName ?? i.payer ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{date(i.issuedAt)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(i.totalAmount)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {fmt(segment === 'outstanding' ? i.outstanding : i.amountPaid)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}

      <InvoiceSheet
        invoiceId={selected}
        basePath="/lab"
        /* Voiding lives with cancelling the order, where the question "was any
           of this actually done" is answerable. */
        canVoid={false}
        onClose={() => {
          setSelected(null);
          /* Drop `?invoice=` once dealt with, so a refresh does not reopen a
             sheet the technician deliberately closed. */
          if (opened) router.replace('/lab/invoices', { scroll: false });
        }}
        onChanged={() => void load()}
      />
    </div>
  );
}
