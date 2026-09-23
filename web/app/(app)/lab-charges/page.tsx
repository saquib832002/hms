'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { PartnerLabStatements } from '@/lib/types';
import { PeriodPicker, periodQuery, type Period } from '@/components/period-picker';
import { dateTime } from '@/lib/format';
import { useMoney } from '@/lib/use-money';
import { Button, EmptyState, ErrorState, Input, TableSkeleton } from '@/components/ui/primitives';

/**
 * What this hospital owes the laboratories it sends work to.
 *
 * WHY THIS SCREEN HAD TO EXIST
 * ----------------------------
 * Under `ORIGIN_PAYS` the partner laboratory raises a real invoice against
 * this hospital — in **its own** tenant. So from here the debt was completely
 * invisible: our books showed the patient's charge and nothing owing, and
 * "what do we owe them this month" could not be answered from anywhere in the
 * product. It arrived as a statement, and the first person to see it was
 * whoever opened the post.
 *
 * That is the same shape as the hole the billing modes were built to close.
 * There, neither party billed; here, one party billed and the other could not
 * see it. Both are a number that exists in one tenant and matters in two.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not accounts payable. No part-payments, no credit notes, no aging buckets —
 * settling with another company is a bank transfer and a telephone call, and
 * modelling half of that would produce a balance disagreeing with both parties'
 * real books. Marking a row settled records that somebody here says it has
 * been dealt with, and is reversible because the commonest correction is
 * ticking the wrong line.
 *
 * The authoritative record remains the laboratory's own invoice. This is their
 * notice of it, written into our scope when they accepted the work.
 */
interface Charge {
  id: number;
  partnerName: string;
  reference: string;
  sourceAccession: string | null;
  amount: string;
  testCount: number;
  incurredAt: string;
  settledAt: string | null;
  settledBy: string | null;
  settledNote: string | null;
}

interface Payload {
  data: Charge[];
  outstandingCount: number;
  outstandingTotal: string;
}

type Tab = 'outstanding' | 'settled' | 'all' | 'statements';

export default function LabChargesPage() {
  const money = useMoney();
  const [tab, setTab] = useState<Tab>('outstanding');
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<Record<number, string>>({});

  /**
   * The same charges, grouped into the month the laboratory bills as one.
   *
   * WHY THIS VIEW HAD TO EXIST
   * --------------------------
   * A reference laboratory raises an invoice per referral and then posts **one
   * statement a month**. What arrives here is that piece of paper; what this
   * screen held was forty separate notices, so checking the two against each
   * other meant adding a column of figures up by eye — which is how a hospital
   * comes to pay a statement it never actually reconciled.
   *
   * Two independently-kept sets of rows agreeing is the whole value of the
   * notice. One party's figure taken on trust is worth much less.
   */
  const [period, setPeriod] = useState<Period | null>(null);
  const [statements, setStatements] = useState<PartnerLabStatements | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === 'statements') {
        // A literal per call: `endpoint-coverage.spec.ts` reads the literal at
        // the call site, and an interpolated path is invisible to it.
        setStatements(
          await api<PartnerLabStatements>(`/lab-partners/statements${periodQuery(period)}`),
        );
        return;
      }
      setPayload(await api<Payload>(`/lab-partners/charges?status=${tab}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load partner lab bills');
    }
  }, [tab, period]);

  useEffect(() => {
    setPayload(null);
    setStatements(null);
    void load();
  }, [load]);

  /**
   * Mark a whole month dealt with, in one act.
   *
   * The alternative is ticking forty rows and the realistic outcome of that is
   * thirty-nine ticked — a month reading as part-settled when the transfer
   * covered all of it. Every row is still written individually underneath, so
   * the per-row Undo keeps working and nothing new has to be reconciled.
   *
   * Still not a payment. No money moves between two companies inside this
   * system and no `Payment` row is written, because takings are counted from
   * that table and this never passed through a till.
   */
  async function settleMonth(partnerTenantId: number, settled: boolean) {
    setBusyId(partnerTenantId);
    setError(null);
    try {
      await api(`/lab-partners/statements/${partnerTenantId}/settle`, {
        method: 'POST',
        body: { from: statements?.from, to: statements?.to, settled },
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update that month');
    } finally {
      setBusyId(null);
    }
  }

  async function settle(id: number, settled: boolean) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/lab-partners/charges/${id}/settle`, {
        method: 'POST',
        body: { settled, note: settled ? note[id]?.trim() || undefined : undefined },
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update that charge');
    } finally {
      setBusyId(null);
    }
  }

  if (error && !payload && !statements) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-text">Partner lab bills</h1>
          <p className="text-sm text-text-muted">
            Tests we sent to another laboratory and agreed to pay for.
          </p>
        </div>

        {/*
          The total, beside the list rather than inside it. "What do we owe" is
          the question this screen exists for, and making somebody add a column
          of figures by eye is how it gets answered wrongly.

          Always over the outstanding rows, whichever tab is showing — a total
          that changes meaning when you switch tab is worse than none.
        */}
        {tab !== 'statements' && payload && (
          <div className="text-right">
            <div className="text-xs uppercase text-text-subtle">Outstanding</div>
            <div className="text-lg font-semibold text-text">{money(payload.outstandingTotal)}</div>
            <div className="text-xs text-text-muted">
              {payload.outstandingCount} {payload.outstandingCount === 1 ? 'bill' : 'bills'}
            </div>
          </div>
        )}

        {tab === 'statements' && statements && (
          <div className="text-right">
            <div className="text-xs uppercase text-text-subtle">{statements.label}</div>
            <div className="text-lg font-semibold text-text">{money(statements.outstanding)}</div>
            <div className="text-xs text-text-muted">outstanding of {money(statements.total)}</div>
          </div>
        )}
      </div>

      {/*
        Segmented, never filtered down to the open items. Fifth time in this
        codebase: "did we ever pay them for that" is asked precisely once an
        outstanding-only list would have dropped the row.
      */}
      <div className="mb-3 flex items-center gap-1">
        {/*
          `statements` sits beside the three status tabs rather than replacing
          them: the notices are the row-by-row record and the statement is the
          shape the bill actually arrives in. Both are needed, and reconciling
          means holding one against the other.
        */}
        {(['outstanding', 'settled', 'all', 'statements'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-sm px-3 py-1 text-sm capitalize ${
              tab === t ? 'bg-primary-soft font-semibold text-primary' : 'text-text-muted hover:bg-bg'
            }`}
          >
            {t === 'statements' ? 'By month' : t}
          </button>
        ))}

      </div>

      {/*
        A period, not a month. Referral agreements are written weekly,
        ten-daily and fortnightly as often as monthly, and the paper that
        arrives covers whatever the agreement says — so the view that checks it
        has to be able to cover the same days.
      */}
      {tab === 'statements' && (
        <PeriodPicker
          value={period}
          onChange={setPeriod}
          label={statements?.label}
          busy={!statements}
        />
      )}

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}

      {tab === 'statements' ? (
        !statements ? (
          <TableSkeleton rows={3} />
        ) : statements.data.length === 0 ? (
          <EmptyState
            title={`Nothing billed to us in ${statements.label}`}
            description="A month appears here once a partner laboratory has accepted work we agreed to pay for. Tests a patient paid for at the laboratory's own counter are not on one — we owe nothing for those."
          />
        ) : (
          <div className="space-y-3">
            {statements.data.map((s) => (
              <div key={s.partnerTenantId} className="rounded-md border border-border bg-surface">
                <div className="flex flex-wrap items-baseline gap-3 border-b border-border px-3 py-2">
                  <span className="text-sm font-semibold text-text">{s.partnerName}</span>
                  <span className="text-xs text-text-muted">
                    {s.referrals} {s.referrals === 1 ? 'referral' : 'referrals'} · {s.tests}{' '}
                    {s.tests === 1 ? 'test' : 'tests'} · {statements.label}
                  </span>
                  <span className="ml-auto font-mono text-sm font-semibold text-text">
                    {money(s.total)}
                  </span>
                  {s.settled ? (
                    <span className="rounded-full bg-success-soft px-2 py-0.5 text-xxs font-semibold uppercase text-success">
                      Settled
                    </span>
                  ) : (
                    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xxs font-semibold uppercase text-[#6b5314]">
                      {money(s.outstanding)} due
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <button
                    onClick={() =>
                      setExpanded(expanded === s.partnerTenantId ? null : s.partnerTenantId)
                    }
                    className="text-xs text-primary hover:underline"
                  >
                    {expanded === s.partnerTenantId
                      ? 'Hide the lines'
                      : `Check the ${s.referrals} ${s.referrals === 1 ? 'line' : 'lines'}`}
                  </button>

                  <div className="ml-auto">
                    {s.settled ? (
                      <button
                        onClick={() => void settleMonth(s.partnerTenantId, false)}
                        disabled={busyId === s.partnerTenantId}
                        className="text-xs text-danger hover:underline"
                      >
                        Undo the month
                      </button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busyId === s.partnerTenantId}
                        onClick={() => void settleMonth(s.partnerTenantId, true)}
                      >
                        Mark {statements.label} settled
                      </Button>
                    )}
                  </div>
                </div>

                {/*
                  The lines, so the statement that arrived can be held against
                  our own records rather than taken on trust. Our specimen
                  number first — it is what makes a line auditable from here
                  instead of by telephoning the laboratory.
                */}
                {expanded === s.partnerTenantId && (
                  <table className="w-full border-t border-border text-sm">
                    <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
                      <tr>
                        <th className="px-3 py-2">Our order</th>
                        <th className="px-3 py-2">Reference</th>
                        <th className="px-3 py-2">Tests</th>
                        <th className="px-3 py-2">Incurred</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2">Settled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.lines.map((l) => (
                        <tr key={l.id} className="border-t border-border">
                          <td className="px-3 py-2 font-mono text-xs">
                            {l.sourceAccession ?? <span className="text-text-subtle">—</span>}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-text-muted">
                            {l.reference}
                          </td>
                          <td className="px-3 py-2 text-xs text-text-muted">{l.testCount}</td>
                          <td className="px-3 py-2 text-xs text-text-muted">
                            {dateTime(l.incurredAt)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs">
                            {money(l.amount)}
                          </td>
                          <td className="px-3 py-2 text-xs text-text-muted">
                            {l.settledAt ? dateTime(l.settledAt) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )
      ) : !payload ? (
        <TableSkeleton rows={4} />
      ) : payload.data.length === 0 ? (
        <EmptyState
          title={tab === 'outstanding' ? 'Nothing outstanding' : 'Nothing here'}
          description={
            tab === 'outstanding'
              ? 'A bill appears here when a partner laboratory accepts work we agreed to pay for.'
              : 'Bills you have marked settled will show here.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Laboratory</th>
                <th className="px-3 py-2">Our order</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2">Tests</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Incurred</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {payload.data.map((c) => (
                <tr key={c.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-medium">{c.partnerName}</td>
                  {/*
                    Our own specimen number, which is what makes this row
                    auditable rather than just a figure: "what is this charge
                    for" is answered from our records, not by ringing the lab.
                  */}
                  <td className="px-3 py-2 font-mono text-xs">
                    {c.sourceAccession ?? <span className="text-text-subtle">—</span>}
                  </td>
                  {/* The six characters both sides say out loud on the phone. */}
                  <td className="px-3 py-2 font-mono text-xs text-text-muted">{c.reference}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{c.testCount}</td>
                  <td className="px-3 py-2 text-right font-medium">{money(c.amount)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{dateTime(c.incurredAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {c.settledAt ? (
                      <div className="text-xs text-text-muted">
                        Settled {dateTime(c.settledAt)}
                        {c.settledBy ? ` by ${c.settledBy}` : ''}
                        {c.settledNote ? ` — ${c.settledNote}` : ''}
                        <button
                          onClick={() => void settle(c.id, false)}
                          disabled={busyId === c.id}
                          className="ml-2 text-xs text-danger hover:underline"
                        >
                          Undo
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <Input
                          value={note[c.id] ?? ''}
                          onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                          placeholder="Reference, optional"
                          className="w-40 text-xs"
                        />
                        <Button
                          size="sm"
                          disabled={busyId === c.id}
                          onClick={() => void settle(c.id, true)}
                        >
                          Mark settled
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
        Said once, plainly, because the alternative is somebody reconciling this
        against a bank statement and assuming it is authoritative.
      */}
      <p className="mt-3 text-xs text-text-subtle">
        No money moves through this screen. The laboratory&rsquo;s own invoice is the record;
        marking a bill settled notes that it has been dealt with, and can be undone.
      </p>
    </div>
  );
}
