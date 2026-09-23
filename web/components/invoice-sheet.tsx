'use client';

import { openDocument } from '@/lib/documents';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Invoice, PaymentMethod } from '@/lib/types';
import { date, dateTime, titleCase } from '@/lib/format';
import {
  Button,
  Field,
  Input,
  Select,
  Textarea,
  SectionLabel,
  Skeleton,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { useMoney } from '@/lib/use-money';

const METHODS: PaymentMethod[] = ['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'INSURANCE', 'OTHER'];

/**
 * Is this canonical money string zero?
 *
 * String comparison, not `Number(...) === 0`. The server always sends
 * `fromMinor` output — two decimals, no separators — so `'0.00'` is the only
 * spelling of nothing, and parsing it to a float to find that out is the habit
 * that later becomes float arithmetic on a balance.
 */
const isZero = (amount: string) => amount === '0.00';

/** Invoice detail: lines, payments, and the two actions available. */
export function InvoiceSheet({
  invoiceId,
  onClose,
  onChanged,
  /**
   * Which set of books this invoice belongs to.
   *
   * The pharmacy has its own routes rather than sharing `/billing` — see
   * `pharmacy-till.controller.ts` for why widening `@Roles` there would have
   * cost the cleanest role boundary in the system. The *screen* is the same
   * screen, so it takes a base path rather than being copied.
   *
   * Voiding is deliberately absent from the pharmacy path: the medicine has
   * left the shelf, so the correction is a refund and a credit, not a
   * cancellation of a sale that physically happened.
   */
  basePath = '/billing',
  canVoid = true,
}: {
  invoiceId: number | null;
  onClose: () => void;
  onChanged: () => void;
  basePath?: '/billing' | '/pharmacy' | '/lab';
  canVoid?: boolean;
}) {
  const fmt = useMoney();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CARD');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [refunding, setRefunding] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('CASH');
  const [refundReason, setRefundReason] = useState('');
  const [cancelCharge, setCancelCharge] = useState(true);

  useEffect(() => {
    setInvoice(null);
    setError(null);
    setAmount('');
    setReference('');
    setVoidReason('');
    if (!invoiceId) return;
    void reload();
  }, [invoiceId]);

  async function reload() {
    try {
      /*
       * Both routes spelled out rather than assembled from `basePath`.
       *
       * `endpoint-coverage.spec.ts` matches on the literal passed to `api()`,
       * and a path built from a variable is invisible to it — which turns a
       * real caller into a reported orphan and invites an exemption that hides
       * a genuine gap later. Also easier to grep for.
       *
       * Three tills now, and the repetition is the price of the guarantee.
       */
      const inv = await api<Invoice>(
        basePath === '/pharmacy'
          ? `/pharmacy/invoices/${invoiceId}`
          : basePath === '/lab'
            ? `/lab/invoices/${invoiceId}`
            : `/billing/invoices/${invoiceId}`,
      );
      setInvoice(inv);
      // Default to settling the balance — the common case at a desk.
      setAmount(inv.settled ? '' : inv.outstanding);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that invoice');
    }
  }

  if (!invoiceId) return null;

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      await api(
        basePath === '/pharmacy'
          ? `/pharmacy/invoices/${invoiceId}/payments`
          : basePath === '/lab'
            ? `/lab/invoices/${invoiceId}/payments`
            : `/billing/invoices/${invoiceId}/payments`,
        {
        method: 'POST',
        // The amount goes as a string, exactly as typed. Converting to a
        // number here would undo the reason the API takes a string.
        body: { amount: amount.trim(), method, reference: reference.trim() || undefined },
      });
      await reload();
      onChanged();
    } catch (err) {
      // Overpayment and already-settled both arrive as 409 with the arithmetic
      // spelled out — show it rather than paraphrasing.
      setError(err instanceof ApiError ? err.message : 'Could not record that payment');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Give money back.
   *
   * Capped at what the invoice currently *holds*, not at what was charged —
   * refunding twice against one payment is the obvious way to pay somebody the
   * same money twice, and the server enforces it. The hint states the figure so
   * the desk is not guessing.
   *
   * The method is asked for rather than inherited from the original payment: a
   * card payment refunded in cash is ordinary, and assuming otherwise would put
   * a wrong number in the split that reconciles the till.
   */
  async function confirmRefund() {
    setBusy(true);
    setError(null);
    try {
      await api(
        basePath === '/pharmacy'
          ? `/pharmacy/invoices/${invoiceId}/refunds`
          : basePath === '/lab'
            ? `/lab/invoices/${invoiceId}/refunds`
            : `/billing/invoices/${invoiceId}/refunds`,
        {
        method: 'POST',
        body: {
          amount: refundAmount.trim(),
          method: refundMethod,
          reason: refundReason.trim(),
          cancelCharge,
        },
      });
      setRefunding(false);
      setRefundAmount('');
      setRefundReason('');
      await reload();
      onChanged();
    } catch (err) {
      // "More than is held" and "nothing to refund" both arrive as 409 with the
      // arithmetic spelled out.
      setError(err instanceof ApiError ? err.message : 'Could not issue that refund');
      setRefunding(false);
    } finally {
      setBusy(false);
    }
  }

  async function confirmVoid() {
    setBusy(true);
    try {
      /*
       * Billing only, and there is no pharmacy branch because there is no
       * pharmacy route.
       *
       * `canVoid` hides the button, and hiding a button is not the same as not
       * having the code — this ternary existed for one commit and would have
       * issued a 404 against `PATCH /pharmacy/invoices/:id/void` if anything
       * ever set `canVoid` on that path. `endpoint-coverage.spec.ts` caught it
       * as a call to a route no controller serves, which is the mirror of the
       * orphan check and the reason both directions are asserted.
       *
       * A pharmacy sale is corrected with a refund and a credit: the medicine
       * physically left the shelf, so cancelling the invoice outright would
       * claim it never happened while the stock says otherwise.
       */
      await api(`/billing/invoices/${invoiceId}/void`, {
        method: 'PATCH',
        body: { reason: voidReason.trim() },
      });
      setVoiding(false);
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not void that invoice');
      setVoiding(false);
    } finally {
      setBusy(false);
    }
  }

  const canPay = !!invoice && !invoice.settled && !invoice.voidedAt && amount.trim().length > 0;

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        width="w-[480px]"
        title={`Invoice INV-${String(invoiceId).padStart(4, '0')}`}
        footer={
          <>
            <Button variant="primary" disabled={!canPay || busy} onClick={() => void pay()}>
              {busy ? 'Recording…' : 'Record payment'}
            </Button>
            <Button onClick={onClose}>Close</Button>
            {/* Offered whenever the invoice is actually holding money. Not
                "has payments" — a fully refunded invoice has payments and
                holds nothing, and offering to refund it again would be an
                invitation to pay somebody twice. */}
            {invoice && !invoice.voidedAt && !isZero(invoice.amountPaid) && (
              <Button
                variant="danger"
                onClick={() => {
                  setRefundAmount(invoice.amountPaid);
                  setRefunding(true);
                }}
              >
                Refund
              </Button>
            )}
            {/* Void needs the money gone first — see the server's message. */}
            {canVoid && invoice && !invoice.voidedAt && isZero(invoice.amountPaid) && (
              <Button variant="danger" onClick={() => setVoiding(true)}>
                Void
              </Button>
            )}
          </>
        }
      >
        {!invoice && !error && <Skeleton className="h-48 w-full" />}

        {invoice && (
          <>
            <div className="rounded border border-border bg-bg p-2.5">
              {/* Referred work is billed to the hospital that sent it, so the
                  payer is a company rather than a person — a dash there reads
                  as data missing. */}
              <div className="text-md font-bold">
                {invoice.patient?.fullName ?? invoice.payer ?? '—'}
              </div>
              {/*
                The doctor's order number, at the top of the invoice.

                It is in every lab line's description too, but somebody
                reconciling a bill against a worklist wants it once, where the
                invoice identifies itself — not read out of a column of line
                text.
              */}
              {invoice.labAccessions && invoice.labAccessions.length > 0 && (
                <div className="font-mono text-xs text-text">
                  Order {invoice.labAccessions.join(', ')}
                </div>
              )}
              <div className="font-mono text-xs text-text-muted">
                Issued {date(invoice.issuedAt)}
                {invoice.dueDate ? ` · due ${date(invoice.dueDate)}` : ' · no due date'}
              </div>
              {invoice.daysOverdue > 0 && !invoice.settled && (
                <div className="mt-1 text-xs font-semibold text-danger">
                  {invoice.daysOverdue} days overdue
                </div>
              )}
            </div>

            {invoice.voidedAt && (
              <div className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-3 py-2 text-sm text-[#8a2a1f]">
                <div className="font-semibold">Voided {date(invoice.voidedAt)}</div>
                <p className="text-xs">{invoice.voidReason}</p>
              </div>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2">
              <Figure label="Total" value={fmt(invoice.totalAmount)} />
              <Figure label="Paid" value={fmt(invoice.amountPaid)} tone="success" />
              <Figure
                label="Outstanding"
                value={fmt(invoice.outstanding)}
                tone={invoice.settled ? undefined : 'danger'}
              />
            </div>

            <SectionLabel>Lines</SectionLabel>
            <div className="rounded-sm border border-border">
              {invoice.items.map((line, i) => (
                <div
                  /*
                   * Index in the key, because a rolled-up medicine summary has
                   * no id — it is not a row anybody can fetch or act on, which
                   * is the point. See `invoice-response.ts`.
                   */
                  key={line.id ?? `summary-${i}`}
                  className="flex items-baseline justify-between border-b border-[#f0f2f4] px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="text-sm">
                    {line.description}
                    {line.quantity !== null && (
                      <span className="ml-1.5 text-xs text-text-subtle">
                        {line.quantity} × {line.unitPrice}
                      </span>
                    )}
                  </span>
                  <span className="text-right font-mono text-xs">
                    {fmt(line.amount)}
                    {/*
                      The tax on this line, under the net.

                      Both are shown because a statutory invoice has to be
                      readable as an arithmetic: net, tax, total. Printing only
                      the gross means a patient — or an auditor — cannot see
                      what rate was applied, and the rate NAME matters as much
                      as the number, since "Exempt" and "Zero-rated" are
                      different things that look identical as 0.00.
                    */}
                    {Number(line.taxAmount) > 0 &&
                      (line.taxBreakdown && line.taxBreakdown.length > 0 ? (
                        /*
                          Each part named separately — CGST 6%, SGST 6%.
                          An Indian statutory invoice is not valid showing only
                          a combined "GST 12.00", and a US receipt reading
                          "tax 6.00" cannot be reconciled against state, county
                          and city. The parts sum exactly to the tax line above
                          because they were apportioned from it, never computed
                          independently.
                        */
                        <span className="block text-xxs font-normal text-text-subtle">
                          {line.taxBreakdown.map((c) => (
                            <span key={c.name} className="block">
                              + {fmt(c.amount)} {c.name}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="block text-xxs font-normal text-text-subtle">
                          + {fmt(line.taxAmount)}
                          {line.taxRateName ? ` ${line.taxRateName}` : ' tax'}
                        </span>
                      ))}
                  </span>
                </div>
              ))}

              {/*
                Net, tax and total, only when there is tax.

                Omitted entirely at zero rather than printed as "Tax 0.00" on
                every bill: most hospitals here charge none, and a row of
                zeroes on every invoice is noise that trains people to skip the
                totals block.
              */}
              {Number(invoice.taxTotal) > 0 && (
                <div className="border-t border-border bg-bg px-2.5 py-1.5 text-xs">
                  <div className="flex justify-between text-text-muted">
                    <span>Net</span>
                    <span className="font-mono">
                      {fmt(
                        (Number(invoice.totalAmount) - Number(invoice.taxTotal)).toFixed(2),
                      )}
                    </span>
                  </div>
                  {/*
                    One row per named tax, with its percentage.

                    "Tax 12.00" is not a lawful line on an Indian invoice —
                    CGST and SGST must be shown separately — and it is not
                    reconcilable on a US receipt either, where the same figure
                    is state plus county plus city. The rows come from what
                    each line captured at billing, so they still print
                    correctly after the rate has been renamed or restructured.
                  */}
                  {invoice.taxSummary.map((t) => (
                    <div key={`${t.name}-${t.rateBasisPoints}`} className="flex justify-between text-text-muted">
                      <span>
                        {t.name}
                        <span className="ml-1 text-text-subtle">{t.label}</span>
                      </span>
                      <span className="font-mono">{fmt(t.amount)}</span>
                    </div>
                  ))}
                  <div className="mt-0.5 flex justify-between border-t border-border pt-0.5 font-semibold text-text">
                    <span>Total</span>
                    <span className="font-mono">{fmt(invoice.totalAmount)}</span>
                  </div>
                </div>
              )}
            </div>

            {/*
              The printed copy obeys the same role rule as this screen: a
              billing clerk's PDF collapses the medicine lines exactly as their
              API response does. A PDF is a response.
            */}
            <button
              onClick={() => void openDocument('invoices', invoice.id)}
              className="mb-3 inline-block text-sm text-primary hover:underline"
            >
              Print this invoice (PDF) →
            </button>

            <SectionLabel>Payments</SectionLabel>
            {invoice.payments.length === 0 ? (
              <p className="text-sm text-text-subtle">Nothing received yet.</p>
            ) : (
              <div className="rounded-sm border border-border">
                {invoice.payments.map((p) => (
                  <div key={p.id} className="border-b border-[#f0f2f4] px-2.5 py-1.5 last:border-b-0">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium">{fmt(p.amount)}</span>
                      <span className="font-mono text-xxs text-text-muted">
                        {dateTime(p.receivedAt)}
                      </span>
                    </div>
                    <div className="text-xs text-text-muted">
                      {titleCase(p.method)}
                      {p.reference ? ` · ${p.reference}` : ''}
                      {p.receivedBy ? ` · ${p.receivedBy}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!invoice.settled && !invoice.voidedAt && (
              <>
                <SectionLabel>Record a payment</SectionLabel>
                <Field
                  label="Amount"
                  required
                  hint={`Outstanding is ${fmt(invoice.outstanding)}. Overpayment is rejected — there is no credit balance yet.`}
                >
                  <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Method" required>
                  <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {titleCase(m)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference" hint="Card auth code, cheque number, claim id.">
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                </Field>
              </>
            )}

            {/* Refunds sit beside payments, never subtracted from them. An
                invoice that took 120 and gave 120 back is not the same as one
                never paid, and only showing the net hides which. */}
            {invoice.refunds.length > 0 && (
              <>
                <SectionLabel>Refunded</SectionLabel>
                <div className="rounded-sm border border-[#f2c4be]">
                  {invoice.refunds.map((r) => (
                    <div
                      key={r.id}
                      className="border-b border-[#f0f2f4] px-2.5 py-1.5 last:border-b-0"
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm font-medium text-danger">−{fmt(r.amount)}</span>
                        <span className="font-mono text-xxs text-text-muted">
                          {dateTime(r.refundedAt)}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted">
                        {titleCase(r.method)}
                        {r.refundedBy ? ` · ${r.refundedBy}` : ''}
                      </div>
                      {/* The reason is the whole point of the row. */}
                      <div className="mt-0.5 text-xs italic text-text-subtle">{r.reason}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {invoice.settled && !invoice.voidedAt && (
              <div className="mt-3 rounded-sm border border-[#b7dcc5] bg-success-soft px-3 py-2 text-sm text-[#14562f]">
                Settled in full.
              </div>
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

      {voiding && (
        <Sheet
          open
          onClose={() => setVoiding(false)}
          title="Void this invoice"
          footer={
            <>
              <Button
                variant="danger"
                disabled={voidReason.trim().length < 10 || busy}
                onClick={() => void confirmVoid()}
              >
                Void invoice
              </Button>
              <Button onClick={() => setVoiding(false)}>Cancel</Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-text-muted">
            The invoice stays in the ledger marked as voided — it is never deleted. A gap in the
            numbering is indistinguishable from a cover-up.
          </p>
          <Field label="Reason" required hint="At least a sentence. This is permanent.">
            <Textarea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          </Field>
        </Sheet>
      )}

      {refunding && invoice && (
        <Sheet
          open
          onClose={() => setRefunding(false)}
          title="Refund"
          footer={
            <>
              <Button
                variant="danger"
                disabled={
                  refundReason.trim().length < 8 || refundAmount.trim().length === 0 || busy
                }
                onClick={() => void confirmRefund()}
              >
                {busy ? 'Refunding…' : 'Issue refund'}
              </Button>
              <Button onClick={() => setRefunding(false)}>Cancel</Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-text-muted">
            This records money going back to the patient. The charge itself stands — the invoice
            returns to unpaid, and both the payment and the refund stay in the ledger.
          </p>

          <Field
            label="Amount"
            required
            hint={`This invoice is holding ${fmt(invoice.amountPaid)}. A refund cannot exceed that.`}
          >
            <Input
              value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </Field>

          <Field
            label="Method"
            required
            hint="How the money is going back — not necessarily how it came in."
          >
            <Select
              value={refundMethod}
              onChange={(e) => setRefundMethod(e.target.value as PaymentMethod)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reason"
            required
            hint="Why the money is going back. This appears on the invoice and in the audit trail."
          >
            <Textarea
              rows={3}
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
            />
          </Field>

          {/*
            The credit, and the loop it closes.
            ----------------------------------
            Refunding alone gives the money back and leaves the charge standing,
            so the balance reappears and the invoice becomes payable again —
            pay, refund, outstanding, pay, with no state that ends. Cancelling
            the charge is what terminates it, and it is almost always what
            happened: the charge was wrong too.

            Left as a choice because the other case is real — a returned deposit
            against a charge the patient still genuinely owes.
          */}
          <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={cancelCharge}
              onChange={(e) => setCancelCharge(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="font-medium">Cancel the charge too</span>
              <span className="mt-0.5 block text-xs text-text-muted">
                {cancelCharge
                  ? 'The invoice is reduced by this amount, so no balance reappears. Fully refunded and fully cancelled invoices close.'
                  : 'The charge stands and the patient still owes this amount — only use this for a returned deposit.'}
              </span>
            </span>
          </label>
        </Sheet>
      )}
    </>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger';
}) {
  const colour = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : '';
  return (
    <div className="rounded-sm border border-border bg-surface p-2 text-center">
      <div className={`font-mono text-sm font-bold ${colour}`}>{value}</div>
      <div className="text-xxs uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}
