-- Reversing a dispense that never left the counter.
--
-- WHY THIS IS NOT A REFUND
-- ------------------------
-- A refund returns money for medicine the patient has. A reversal undoes a
-- handover that did not happen: the patient could not pay, or changed their
-- mind, and the box never left the pharmacist's hand. Stock goes back to the
-- exact batches it came from, the prescription becomes dispensable again, and
-- the invoice is voided.
--
-- The distinction is not pedantry. Dispensed medicine that has left the
-- premises cannot lawfully be resold in most jurisdictions, so putting it back
-- into saleable stock automatically would be a regulatory problem wearing the
-- shape of a convenience — and it would overstate the number the whole
-- dispensing flow trusts. That path stays a deliberate act through
-- `POST /pharmacy/stock`, with its own trail.
--
-- Verify with `npm run db:verify` before and after. No RLS change is needed:
-- these are columns on an existing tenant-scoped table, which already carries
-- its policy.

ALTER TABLE "dispense_events" ADD COLUMN "reversedAt" TIMESTAMP(3);
ALTER TABLE "dispense_events" ADD COLUMN "reversedById" INTEGER;
ALTER TABLE "dispense_events" ADD COLUMN "reversalReason" TEXT;

ALTER TABLE "dispense_events"
  ADD CONSTRAINT "dispense_events_reversedById_fkey"
  FOREIGN KEY ("reversedById") REFERENCES "users"("id");

-- Who reversed it and why are recorded together, or not at all. A reversal
-- with no named pharmacist is an unattributable stock movement, and a stock
-- ledger nobody can attribute is one nobody can audit.
ALTER TABLE "dispense_events"
  ADD CONSTRAINT "dispense_events_reversal_complete"
  CHECK (
    ("reversedAt" IS NULL AND "reversedById" IS NULL AND "reversalReason" IS NULL)
    OR ("reversedAt" IS NOT NULL AND "reversedById" IS NOT NULL AND "reversalReason" IS NOT NULL)
  );

-- Finding the reversals for a day's reconciliation, without scanning the table.
CREATE INDEX "dispense_events_reversedAt_idx" ON "dispense_events"("reversedAt");
