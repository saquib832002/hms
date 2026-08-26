'use client';

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

/** Invoice detail: lines, payments, and the two actions available. */
export function InvoiceSheet({
  invoiceId,
  onClose,
  onChanged,
}: {
  invoiceId: number | null;
  onClose: () => void;
  onChanged: () => void;
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
      const inv = await api<Invoice>(`/billing/invoices/${invoiceId}`);
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
      await api(`/billing/invoices/${invoiceId}/payments`, {
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

  async function confirmVoid() {
    setBusy(true);
    try {
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
            {invoice && !invoice.voidedAt && invoice.payments.length === 0 && (
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
              <div className="text-md font-bold">{invoice.patient?.fullName ?? '—'}</div>
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
              {invoice.items.map((line) => (
                <div
                  key={line.id}
                  className="flex items-baseline justify-between border-b border-[#f0f2f4] px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="text-sm">{line.description}</span>
                  <span className="font-mono text-xs">{fmt(line.amount)}</span>
                </div>
              ))}
            </div>

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
