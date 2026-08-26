'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AgingReport, Invoice } from '@/lib/types';
import { date } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Select,
  TableSkeleton,
} from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { InvoiceSheet } from '@/components/invoice-sheet';
import { CreateInvoiceSheet } from '@/components/create-invoice-sheet';
import { useMoney } from '@/lib/use-money';

const STATUS_STYLES: Record<string, string> = {
  PAID: 'bg-success-soft text-success',
  PARTIALLY_PAID: 'bg-warning-soft text-warning',
  PENDING: 'bg-primary-soft text-primary',
  OVERDUE: 'bg-danger-soft text-danger',
  CANCELLED: 'bg-[#eef0f2] text-text-muted',
};

/**
 * Invoices, with the aging report as the header rather than a separate page.
 *
 * The question a finance office opens this screen to answer is "how much is
 * late and how late" — putting that behind another click would mean it rarely
 * gets looked at.
 */
export default function InvoicesPage() {
  const fmt = useMoney();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [aging, setAging] = useState<AgingReport | null>(null);
  const [status, setStatus] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (overdueOnly) qs.set('overdueOnly', 'true');
      const [list, report] = await Promise.all([
        api<{ data: Invoice[] }>(`/billing/invoices?${qs}`),
        api<AgingReport>('/billing/aging'),
      ]);
      setInvoices(list.data);
      setAging(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load invoices');
    }
  }, [status, overdueOnly]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: selected === null && !creating,
  });

  useEffect(() => {
    setInvoices(null);
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, overdueOnly]);

  if (error && !invoices) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-5">
          <div>
            <div className="font-mono text-lg font-bold tracking-tight">
              {aging ? fmt(aging.totalOutstanding) : '—'}
            </div>
            <div className="text-xxs uppercase tracking-wider text-text-muted">Outstanding</div>
          </div>
          <div>
            <div className="font-mono text-lg font-bold tracking-tight text-danger">
              {aging ? fmt(aging.totalOverdue) : '—'}
            </div>
            <div className="text-xxs uppercase tracking-wider text-text-muted">Overdue</div>
          </div>

          {/* Aging buckets inline — the answer, not a link to the answer. */}
          {aging &&
            (['d1to30', 'd31to60', 'd61to90', 'over90'] as const).map((key) => (
              <div key={key}>
                <div
                  className={`font-mono text-md font-semibold ${
                    key === 'over90' ? 'text-danger' : key === 'd61to90' ? 'text-warning' : ''
                  }`}
                >
                  {fmt(aging.buckets[key].amount)}
                </div>
                <div className="text-xxs uppercase tracking-wider text-text-muted">
                  {aging.buckets[key].label} · {aging.buckets[key].count}
                </div>
              </div>
            ))}

          <div className="ml-auto flex items-center gap-2">
            <Freshness
              lastUpdated={lastUpdated}
              refreshing={refreshing}
              onRefresh={() => void refreshNow()}
            />
            <Button variant="primary" onClick={() => setCreating(true)}>
              New invoice
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-auto text-sm"
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="PARTIALLY_PAID">Partially paid</option>
            <option value="PAID">Paid</option>
            <option value="CANCELLED">Voided</option>
          </Select>
          <label className="flex items-center gap-1.5 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
            Overdue only
          </label>
          <span className="text-xs text-text-muted">{invoices?.length ?? 0} invoices</span>
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!invoices && <TableSkeleton cols={7} />}
        {invoices?.length === 0 && (
          <EmptyState
            title="No invoices match"
            action={<Button onClick={() => setCreating(true)}>Create one</Button>}
          />
        )}

        {invoices && invoices.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Invoice', 'Patient', 'Issued', 'Due', 'Total', 'Outstanding', 'Status'].map((h) => (
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
              {invoices.map((inv) => (
                <tr
                  key={inv.id}
                  onClick={() => setSelected(inv.id)}
                  className={`cursor-pointer ${
                    inv.daysOverdue > 60 && !inv.settled ? 'bg-danger-soft' : 'hover:bg-[#fafbfc]'
                  }`}
                >
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    INV-{String(inv.id).padStart(4, '0')}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                    {inv.patient?.fullName ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    {date(inv.issuedAt)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    {inv.dueDate ? date(inv.dueDate) : '—'}
                    {inv.daysOverdue > 0 && !inv.settled && (
                      <span className="ml-1.5 font-semibold text-danger">
                        +{inv.daysOverdue}d
                      </span>
                    )}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    {fmt(inv.totalAmount)}
                  </td>
                  <td
                    className={`border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs ${
                      inv.settled ? 'text-text-subtle' : 'font-semibold'
                    }`}
                  >
                    {fmt(inv.outstanding)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xxs font-semibold ${
                        STATUS_STYLES[inv.status] ?? 'bg-[#eef0f2] text-text-muted'
                      }`}
                    >
                      {inv.status === 'CANCELLED' ? 'Voided' : inv.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
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

      <CreateInvoiceSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void refreshNow();
        }}
      />
    </>
  );
}
