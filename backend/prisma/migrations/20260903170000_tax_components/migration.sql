-- Several taxes on one sale: CGST + SGST, or state + county + city.
--
-- WHY THIS IS A SECOND MIGRATION
-- ------------------------------
-- These changes were originally written into `20260903150000_tax`, which had
-- already been applied. Prisma records a checksum for every applied migration,
-- so editing one that has run makes the history inconsistent — the next
-- `migrate deploy` refuses, and on a shared deployment two databases silently
-- disagree about what a migration name means. A migration that has run is
-- immutable; new work is a new file.
--
-- Verify with `npm run db:verify` before and after, then `npm run db:rls` —
-- `tax_rate_components` is tenant-scoped and does NOT get its policy here.

-- ---------------------------------------------------------------------------
-- The parts of a rate.
-- ---------------------------------------------------------------------------
-- Both parts are charged on the SAME taxable value. India's 12% GST is 6% + 6%,
-- not 6% compounded on 6%; a US rate is state plus county plus city, each on
-- the shelf price. So `tax_rates.rateBasisPoints` stays the authoritative total
-- and the sale arithmetic never reasons about parts — these rows exist so an
-- invoice can *show* the split, which an Indian statutory invoice is invalid
-- without.
CREATE TABLE "tax_rate_components" (
  "id"              SERIAL PRIMARY KEY,
  "tenantId"        INTEGER NOT NULL REFERENCES "tenants"("id"),
  -- Cascade: a component has no meaning apart from its rate, and nothing
  -- references one. Invoices capture the split as data at billing time rather
  -- than pointing here, so deleting a component cannot orphan a bill.
  "taxRateId"       INTEGER NOT NULL REFERENCES "tax_rates"("id") ON DELETE CASCADE,
  "name"            TEXT NOT NULL,
  "rateBasisPoints" INTEGER NOT NULL DEFAULT 0,
  -- CGST before SGST is conventional on an Indian invoice, and an invoice that
  -- reorders its own tax lines between prints looks wrong to the person filing
  -- it even when the arithmetic is identical.
  "position"        INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "tax_rate_components_rate_sane" CHECK ("rateBasisPoints" BETWEEN 0 AND 10000)
);

CREATE INDEX "tax_rate_components_taxRateId_idx" ON "tax_rate_components"("taxRateId");
CREATE INDEX "tax_rate_components_tenantId_idx" ON "tax_rate_components"("tenantId");

-- ---------------------------------------------------------------------------
-- The split as it was applied, captured on the invoice line.
-- ---------------------------------------------------------------------------
-- `[{ name, rateBasisPoints, amount }]`. Captured rather than resolved, exactly
-- like `taxRateName` and `unitPrice`: an invoice printed today must still show
-- CGST 6% / SGST 6% next year, after somebody has restructured or retired the
-- rate it used. A statutory document that cannot be reproduced is not one.
--
-- Null on a flat rate, which is the ordinary case and stays cheap.
ALTER TABLE "invoice_items" ADD COLUMN "taxBreakdown" JSONB;
