import { InvoiceLedger } from '@/components/invoice-ledger';

/**
 * Billing on a phone: look up an invoice, take a payment, issue a refund.
 *
 * The screen itself lives in `components/invoice-ledger.tsx` because the
 * pharmacy till is the same screen against a different set of books — see the
 * note there. Aging, reconciliation and bulk entry stay on the web app, which
 * is the "task parity, not feature parity" rule and survives opening mobile to
 * every role: a clerk working through 200 overdue accounts wants a desk.
 */
export default function InvoicesScreen() {
  return (
    <InvoiceLedger
      basePath="/billing"
      title="Invoices"
      emptyBody="Settled invoices appear here."
    />
  );
}
