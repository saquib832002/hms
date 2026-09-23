-- Pharmacy billing: prices, invoice kinds, counter sales.
--
-- Hand-written rather than generated, because the machine this was authored on
-- could not download the Prisma schema engine. It is `prisma migrate diff` by
-- hand and should be checked against `npx prisma migrate diff --from-migrations
-- prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` before
-- it goes near a database holding anything.
--
-- Every change is additive and every new column is nullable or defaulted, so an
-- existing hospital keeps behaving exactly as it did: no prices, no pharmacy
-- invoices, SEPARATE mode, and dispensing that charges nothing until somebody
-- sets a price.

-- CreateEnum
CREATE TYPE "PharmacyBillingMode" AS ENUM ('SEPARATE', 'COMBINED');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('HOSPITAL', 'PHARMACY');

-- CreateEnum
CREATE TYPE "InvoiceItemKind" AS ENUM ('SERVICE', 'MEDICINE');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "pharmacyBilling" "PharmacyBillingMode" NOT NULL DEFAULT 'SEPARATE';

-- AlterTable
ALTER TABLE "medicines" ADD COLUMN "sellingPrice" DECIMAL(10,4);

-- AlterTable
ALTER TABLE "stock_batches" ADD COLUMN "costPrice" DECIMAL(10,4);

-- AlterTable
--
-- `patientId` becomes nullable for the over-the-counter case only. Existing
-- rows all have one, and the application still requires one on every HOSPITAL
-- invoice — the constraint that is dropped here is re-asserted in the service,
-- because "a walk-in has no patient" and "somebody forgot to set the patient"
-- are different things and only the database could not tell them apart.
ALTER TABLE "invoices" ALTER COLUMN "patientId" DROP NOT NULL;
ALTER TABLE "invoices" ADD COLUMN "kind" "InvoiceKind" NOT NULL DEFAULT 'HOSPITAL';

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN "kind" "InvoiceItemKind" NOT NULL DEFAULT 'SERVICE';
ALTER TABLE "invoice_items" ADD COLUMN "quantity" INTEGER;
ALTER TABLE "invoice_items" ADD COLUMN "unitPrice" DECIMAL(10,4);
ALTER TABLE "invoice_items" ADD COLUMN "medicineId" INTEGER;

-- AlterTable
ALTER TABLE "dispense_events" ALTER COLUMN "prescriptionId" DROP NOT NULL;
ALTER TABLE "dispense_events" ADD COLUMN "patientId" INTEGER;
ALTER TABLE "dispense_events" ADD COLUMN "invoiceId" INTEGER;

-- Backfill the patient from the prescription that already implied it, so the
-- new column is not a hole on every historical row. A counter sale is the only
-- thing that legitimately has neither.
UPDATE "dispense_events" e
SET "patientId" = p."patientId"
FROM "prescriptions" p
WHERE p."id" = e."prescriptionId" AND e."patientId" IS NULL;

-- AlterTable
ALTER TABLE "dispense_lines" ALTER COLUMN "prescriptionItemId" DROP NOT NULL;
ALTER TABLE "dispense_lines" ADD COLUMN "unitPrice" DECIMAL(10,4);
ALTER TABLE "dispense_lines" ADD COLUMN "lineTotal" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "invoices_kind_status_idx" ON "invoices"("kind", "status");
CREATE INDEX "invoice_items_medicineId_idx" ON "invoice_items"("medicineId");
CREATE INDEX "dispense_events_patientId_idx" ON "dispense_events"("patientId");
CREATE INDEX "dispense_events_invoiceId_idx" ON "dispense_events"("invoiceId");

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dispense_events" ADD CONSTRAINT "dispense_events_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dispense_events" ADD CONSTRAINT "dispense_events_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
