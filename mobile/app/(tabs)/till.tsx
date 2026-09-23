import { useLocalSearchParams } from 'expo-router';
import { InvoiceLedger } from '@/components/invoice-ledger';

/**
 * The pharmacy's own till.
 *
 * Separate from the billing tab because in SEPARATE mode these are two
 * businesses: the server scopes the list by role, so this and the billing tab
 * return disjoint sets even though they render identically. A pharmacist never
 * sees a consultation charge, and billing never sees a counter sale.
 *
 * No voiding here. The medicine has physically left the shelf, so a sale that
 * should not have happened is corrected with a refund and a credit — cancelling
 * it outright would claim it never happened while the stock says otherwise.
 */
export default function PharmacyTillScreen() {
  /*
   * `?invoice=` arrives from a dispense that has just raised a charge, so the
   * payment form is already open on the right row when this screen appears.
   */
  const { invoice } = useLocalSearchParams<{ invoice?: string }>();
  const openInvoiceId = invoice && Number.isFinite(Number(invoice)) ? Number(invoice) : null;

  return (
    <InvoiceLedger
      basePath="/pharmacy"
      title="Till"
      emptyBody="Sales appear here once medicine is dispensed or sold at the counter."
      openInvoiceId={openInvoiceId}
    />
  );
}
