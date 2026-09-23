'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Invoice } from '@/lib/types';
import { date } from '@/lib/format';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { InvoiceSheet } from '@/components/invoice-sheet';
import { useMoney } from '@/lib/use-money';

/**
 * The pharmacy's own till.
 *
 * WHY THIS IS NOT THE BILLING SCREEN WITH A FILTER
 * ------------------------------------------------
 * In SEPARATE mode the pharmacy is a different business with different books.
 * Billing staff do not see these invoices at all — the server scopes the list by
 * role, so this screen and `/billing/invoices` return disjoint sets even though
 * they render the same way. Making it one screen with a dropdown would suggest
 * the two are the same ledger seen through different lenses, which is exactly
 * what the SEPARATE setting says they are not.
 *
 * WHAT IS MISSING HERE, DELIBERATELY
 * ----------------------------------
 * No "create invoice" and no void. A pharmacy invoice is raised by a sale — it
 * is a receipt for goods that physically left a shelf, and one typed by hand
 * would be a charge with no stock movement behind it. Voiding fails the same
 * way in reverse: the medicine has gone, so the correction is a refund and a
 * credit, which the sheet still offers.
 *
 * THE THREE SEGMENTS ARE THE ONES THAT WERE MISSING LAST TIME
 * -----------------------------------------------------------
 * Outstanding / Paid / Closed, because a list showing only unsettled invoices
 * hid every settled one — reported twice from use on the mobile invoice screen,
 * where a refundable payment simply could not be found.
 */
type Segment = 'outstanding' | 'paid' | 'closed';

export default function PharmacyInvoicesPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-text-subtle">Loading…</div>}>
      <PharmacyInvoicesView />
    </Suspense>
  );
}

function PharmacyInvoicesView() {
  const fmt = useMoney();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [segment, setSegment] = useState<Segment>('outstanding');
  const [error, setError] = useState<string | null>(null);
  /*
   * Opened directly by id, so dispensing can hand straight over to payment.
   *
   * The pharmacist has just given the patient their medicine and is about to
   * take the money from the person standing there. Making them find the row
   * they created ten seconds ago is three navigations for nothing.
   *
   * A query parameter rather than component state passed down, because the
   * jump comes from a different route entirely — and because it survives a
   * refresh, which matters when the till is the screen somebody leaves open.
   */
  const router = useRouter();
  const params = useSearchParams();
  const opened = params.get('invoice');
  const [selected, setSelected] = useState<number | null>(
    opened && Number.isFinite(Number(opened)) ? Number(opened) : null,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: Invoice[] }>('/pharmacy/invoices');
      setInvoices(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load pharmacy invoices');
    }
  }, []);

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

  /*
   * Totals per segment, summed in minor units.
   *
   * A list of amounts with no total is a list somebody has to add up by hand,
   * and the first thing anyone asks of a till screen is what is in it.
   */
  const minor = (s: string) => Math.round(Number(s) * 100);
  const totalMinor = rows.reduce(
    (sum, i) => sum + minor(segment === 'outstanding' ? i.outstanding : i.amountPaid),
    0,
  );

  const SEGMENTS: { key: Segment; label: string; hint: string }[] = [
    { key: 'outstanding', label: 'Outstanding', hint: 'Sold, not yet paid for' },
    { key: 'paid', label: 'Paid', hint: 'Settled — refund from here' },
    { key: 'closed', label: 'Voided', hint: 'Cancelled, kept as a record' },
  ];

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <div>
          <h1 className="text-lg font-semibold text-text">Pharmacy invoices</h1>
          <p className="text-sm text-text-muted">
            Sales from dispensing and the counter. Take payment and issue refunds here.
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
                  i.voidedAt ? s.key === 'closed' : s.key === 'outstanding' ? !i.settled : s.key === 'paid' ? i.settled : false,
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
                ? 'Every sale has been paid for.'
                : 'Sales appear here once they are raised from dispensing or the counter.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Sold to</th>
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
                  <td className="px-3 py-2">
                    {/* A counter sale has no patient, and that is not a gap.
                        "Counter sale" is the honest label; an em dash would
                        read as missing data. */}
                    {i.patient?.fullName ?? (
                      <span className="text-text-subtle">Counter sale</span>
                    )}
                  </td>
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

      <InvoiceSheet
        invoiceId={selected}
        basePath="/pharmacy"
        /* See the header: a sale that physically happened is corrected with a
           refund, not cancelled as though it never did. */
        canVoid={false}
        onClose={() => {
          setSelected(null);
          /* Drop `?invoice=` once it has been dealt with, so a refresh does
             not reopen a sheet the pharmacist deliberately closed. */
          if (opened) router.replace('/pharmacy/invoices', { scroll: false });
        }}
        onChanged={() => void load()}
      />
    </div>
  );
}
