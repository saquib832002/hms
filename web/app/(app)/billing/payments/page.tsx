'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { PaymentListItem } from '@/lib/types';
import { dateTime, titleCase } from '@/lib/format';
import { EmptyState, ErrorState, Select, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { InvoiceSheet } from '@/components/invoice-sheet';
import { useMoney } from '@/lib/use-money';

/**
 * Money received.
 *
 * Read-only. Payments are recorded against the invoice they settle — there is
 * no "add a payment" button here, because a payment with no invoice behind it is
 * money the ledger cannot explain. This screen answers "what came in today",
 * which is the other question a finance desk asks.
 */
export default function PaymentsPage() {
  const fmt = useMoney();
  const [payments, setPayments] = useState<PaymentListItem[] | null>(null);
  const [method, setMethod] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: PaymentListItem[] }>('/billing/payments');
      setPayments(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payments');
    }
  }, []);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: selected === null,
  });

  useEffect(() => {
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !payments) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  const rows = (payments ?? []).filter((p) => !method || p.method === method);

  // Summed in integer minor units, from the strings the API sent — never via
  // parseFloat, which is how a totals row ends up a penny out.
  const totalMinor = rows.reduce((minor, p) => {
    const [whole, fraction = '00'] = p.amount.split('.');
    return minor + Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }, 0);

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <div>
          <div className="font-mono text-lg font-bold tracking-tight text-success">
            {fmt((totalMinor / 100).toFixed(2))}
          </div>
          <div className="text-xxs uppercase tracking-wider text-text-muted">Shown</div>
        </div>
        <div>
          <div className="text-lg font-bold tracking-tight">{rows.length}</div>
          <div className="text-xxs uppercase tracking-wider text-text-muted">Payments</div>
        </div>

        <Select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="w-auto text-sm"
        >
          <option value="">All methods</option>
          {['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'INSURANCE', 'OTHER'].map((m) => (
            <option key={m} value={m}>
              {titleCase(m)}
            </option>
          ))}
        </Select>

        <div className="ml-auto">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!payments && <TableSkeleton cols={6} />}
        {payments && rows.length === 0 && (
          <EmptyState
            title="No payments recorded"
            description="Payments are recorded against an invoice, on the Invoices screen."
          />
        )}

        {rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Received', 'Amount', 'Method', 'Reference', 'Patient', 'Invoice'].map((h) => (
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
              {rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p.invoiceId)}
                  className="cursor-pointer hover:bg-[#fafbfc]"
                >
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    {dateTime(p.receivedAt)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs font-semibold">
                    {fmt(p.amount)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">{titleCase(p.method)}</td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    {p.reference ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                    {p.patient?.fullName ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    INV-{String(p.invoiceId).padStart(4, '0')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <InvoiceSheet
        invoiceId={selected}
        onClose={() => setSelected(null)}
        onChanged={() => void refreshNow()}
      />
    </>
  );
}
