-- The diagnostics module: a test catalogue, orders, results, and partner labs.
--
-- HAND-WRITTEN, like the nine before it, because the machine this was authored
-- on cannot download the Prisma schema engine. Verify with:
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel   prisma/schema.prisma --script
--
-- RUN `npm run db:rls` AFTERWARDS. Eight new tables carry `tenantId` and none
-- of them gets a policy from this file. A table with that column and no policy
-- reads as scoped in review and is open to every hospital at runtime, which is
-- the worst failure available here.
--
-- Additive and defaulted throughout: an existing hospital gains a lab it can
-- ignore, keeps its pharmacy behaviour unchanged, and no existing row moves.

-- AlterEnum
--
-- LAB_TECHNICIAN is appended rather than inserted. Postgres enum ordering is
-- positional and `ADD VALUE` can only append safely; nothing here sorts on it.
--
-- The three `ADD VALUE` statements below are why nothing in this file *uses*
-- the new members. Postgres 12+ allows adding an enum value inside a
-- transaction — which is how Prisma runs a migration — but forbids using it in
-- that same transaction. Every column added here defaults to a pre-existing
-- member, so no second migration is needed.
ALTER TYPE "UserRole" ADD VALUE 'LAB_TECHNICIAN';

-- AlterEnum
--
-- A LAB invoice is its own kind rather than a reuse of PHARMACY, because a
-- hospital may run one, both or neither, and the two settle at different
-- counters into different tills.
ALTER TYPE "InvoiceKind" ADD VALUE 'LAB';

-- AlterEnum
--
-- The line kind the role-shaped invoice response keys on. A test name is a
-- sharper clinical leak than a drug name: "HIV antibody" on a bill tells a
-- billing clerk something the patient told their doctor in confidence.
ALTER TYPE "InvoiceItemKind" ADD VALUE 'LAB_TEST';

-- CreateEnum
CREATE TYPE "LabCategory" AS ENUM ('HAEMATOLOGY', 'BIOCHEMISTRY', 'MICROBIOLOGY', 'SEROLOGY', 'HISTOPATHOLOGY', 'IMAGING', 'OTHER');

-- CreateEnum
-- NONE is what makes imaging fit the same workflow: an X-ray needs no specimen,
-- so collection is skipped rather than leaving a queue nobody can clear.
CREATE TYPE "LabSpecimenType" AS ENUM ('BLOOD', 'URINE', 'STOOL', 'SWAB', 'SPUTUM', 'TISSUE', 'FLUID', 'NONE');

-- CreateEnum
CREATE TYPE "LabPriority" AS ENUM ('ROUTINE', 'URGENT', 'STAT');

-- CreateEnum
CREATE TYPE "LabOrderDestination" AS ENUM ('IN_HOUSE', 'EXTERNAL', 'PARTNER');

-- CreateEnum
-- REJECTED is separate from CANCELLED on purpose: a rejected specimen means
-- somebody has to take blood from the patient again, and collapsing the two
-- turns "we need another sample" into "never mind".
CREATE TYPE "LabOrderStatus" AS ENUM ('ORDERED', 'COLLECTED', 'IN_PROGRESS', 'RESULTED', 'VERIFIED', 'CANCELLED', 'REJECTED');

-- CreateEnum
-- UNKNOWN rather than defaulting to NORMAL: "compared and found nothing wrong"
-- and "no range existed to compare against" render identically on a report and
-- mean opposite things.
CREATE TYPE "LabResultFlag" AS ENUM ('NORMAL', 'LOW', 'HIGH', 'ABNORMAL', 'CRITICAL_LOW', 'CRITICAL_HIGH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LabBillingMode" AS ENUM ('SEPARATE', 'COMBINED');

-- AlterTable
-- Defaults chosen so an existing hospital behaves exactly as it did: it has a
-- lab it may ignore, bills for it separately, and is discoverable by nobody.
ALTER TABLE "tenants" ADD COLUMN "labBilling" "LabBillingMode" NOT NULL DEFAULT 'SEPARATE';
ALTER TABLE "tenants" ADD COLUMN "hasLab" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "acceptsExternalLabOrders" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "lab_tests" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "LabCategory" NOT NULL,
    "specimenType" "LabSpecimenType" NOT NULL DEFAULT 'BLOOD',
    -- Four decimal places and nullable, exactly as `medicines.sellingPrice`.
    -- NULL means unpriced, which is not the same as free.
    "sellingPrice" DECIMAL(10,4),
    "taxRateId" INTEGER,
    "turnaroundHours" INTEGER,
    "preparation" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_analytes" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "testId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "refLow" DECIMAL(12,4),
    "refHigh" DECIMAL(12,4),
    "refText" TEXT,
    "criticalLow" DECIMAL(12,4),
    "criticalHigh" DECIMAL(12,4),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lab_analytes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_orders" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "appointmentId" INTEGER,
    "admissionId" INTEGER,
    "priority" "LabPriority" NOT NULL DEFAULT 'ROUTINE',
    "destination" "LabOrderDestination" NOT NULL DEFAULT 'IN_HOUSE',
    -- Deliberately not a foreign key. A record of where the copy went; it
    -- grants nothing, and the receiving lab reads its own referral row.
    "routedToTenantId" INTEGER,
    "clinicalDetails" TEXT,
    "status" "LabOrderStatus" NOT NULL DEFAULT 'ORDERED',
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "collectedById" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" INTEGER,
    "externalVerifiedBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" INTEGER,
    "cancelReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "invoiceId" INTEGER,

    CONSTRAINT "lab_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order_items" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    -- Nullable, and the captured text below is authoritative. Renaming or
    -- retiring a catalogue row next year must not restate what was performed on
    -- a patient last year.
    "testId" INTEGER,
    "testCode" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "category" "LabCategory" NOT NULL,
    "specimenType" "LabSpecimenType" NOT NULL DEFAULT 'BLOOD',
    "unitPrice" DECIMAL(10,4),
    "findings" TEXT,
    "impression" TEXT,
    "methodology" TEXT,
    "resultedAt" TIMESTAMP(3),
    "resultedById" INTEGER,
    "performedByName" TEXT,
    "criticalNotifiedAt" TIMESTAMP(3),
    "criticalNotifiedTo" TEXT,
    "criticalNotifiedById" INTEGER,

    CONSTRAINT "lab_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_result_values" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "analyteName" TEXT NOT NULL,
    "unit" TEXT,
    -- TEXT, not numeric. "<0.01", "Not detected" and "Growth of E. coli" are
    -- all real laboratory results, and forcing them into a number would either
    -- hide them in a note or record a zero, which is a lie about a measurement.
    "value" TEXT NOT NULL,
    -- The parsed form where one exists, held beside the text rather than
    -- instead of it, so a value can be trended without the report showing
    -- anything other than what the lab issued.
    "numericValue" DECIMAL(12,4),
    "referenceRange" TEXT,
    "flag" "LabResultFlag" NOT NULL DEFAULT 'UNKNOWN',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lab_result_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_partners" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "partnerTenantId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Written into the RECEIVING lab's scope, and owned by them. The result goes
-- back the same way, into the ordering hospital's scope — see the model
-- comment. No policy exception exists in either direction.
CREATE TABLE "lab_referrals" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "sourceTenantId" INTEGER NOT NULL,
    "sourceTenantName" TEXT NOT NULL,
    -- An opaque id in the sender's scope. Meaningless to read here, and exactly
    -- what the write-back needs to land on the right rows.
    "sourceOrderId" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "patientDob" TIMESTAMP(3),
    "requestedByName" TEXT NOT NULL,
    "clinicalDetails" TEXT,
    "priority" "LabPriority" NOT NULL DEFAULT 'ROUTINE',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_referral_items" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "referralId" INTEGER NOT NULL,
    "sourceOrderItemId" INTEGER NOT NULL,
    "testCode" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "category" "LabCategory" NOT NULL,
    "specimenType" "LabSpecimenType" NOT NULL DEFAULT 'BLOOD',

    CONSTRAINT "lab_referral_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Scoped to the tenant, because two hospitals may both call a test "FBC".
CREATE UNIQUE INDEX "lab_tests_tenantId_code_key" ON "lab_tests"("tenantId", "code");
CREATE INDEX "lab_tests_tenantId_idx" ON "lab_tests"("tenantId");
CREATE INDEX "lab_tests_category_idx" ON "lab_tests"("category");

-- CreateIndex
CREATE UNIQUE INDEX "lab_analytes_testId_name_key" ON "lab_analytes"("testId", "name");
CREATE INDEX "lab_analytes_tenantId_idx" ON "lab_analytes"("tenantId");
CREATE INDEX "lab_analytes_testId_idx" ON "lab_analytes"("testId");

-- CreateIndex
CREATE INDEX "lab_orders_patientId_orderedAt_idx" ON "lab_orders"("patientId", "orderedAt");
CREATE INDEX "lab_orders_doctorId_orderedAt_idx" ON "lab_orders"("doctorId", "orderedAt");
-- The worklist reads by status and sorts urgent work first.
CREATE INDEX "lab_orders_status_priority_idx" ON "lab_orders"("status", "priority");
CREATE INDEX "lab_orders_admissionId_idx" ON "lab_orders"("admissionId");
CREATE INDEX "lab_orders_tenantId_idx" ON "lab_orders"("tenantId");

-- CreateIndex
CREATE INDEX "lab_order_items_orderId_idx" ON "lab_order_items"("orderId");
CREATE INDEX "lab_order_items_testId_idx" ON "lab_order_items"("testId");
CREATE INDEX "lab_order_items_tenantId_idx" ON "lab_order_items"("tenantId");

-- CreateIndex
CREATE INDEX "lab_result_values_orderItemId_idx" ON "lab_result_values"("orderItemId");
CREATE INDEX "lab_result_values_tenantId_idx" ON "lab_result_values"("tenantId");

-- CreateIndex
-- Covers inactive rows too. Removing a partner is a soft delete, so re-adding
-- one reactivates the row rather than being refused against a row the
-- administrator cannot see.
CREATE UNIQUE INDEX "lab_partners_tenantId_partnerTenantId_key" ON "lab_partners"("tenantId", "partnerTenantId");
CREATE INDEX "lab_partners_tenantId_idx" ON "lab_partners"("tenantId");

-- CreateIndex
-- Per tenant, not global: the reference only has to be unambiguous at the lab
-- the patient quotes it to.
CREATE UNIQUE INDEX "lab_referrals_tenantId_reference_key" ON "lab_referrals"("tenantId", "reference");
CREATE INDEX "lab_referrals_tenantId_resultedAt_idx" ON "lab_referrals"("tenantId", "resultedAt");

-- CreateIndex
CREATE INDEX "lab_referral_items_referralId_idx" ON "lab_referral_items"("referralId");
CREATE INDEX "lab_referral_items_tenantId_idx" ON "lab_referral_items"("tenantId");

-- AddForeignKey
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- CASCADE: an analyte is part of its test and has no meaning without it.
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_testId_fkey" FOREIGN KEY ("testId") REFERENCES "lab_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- SET NULL on the actors: deactivating a member of staff must not fail because
-- they once collected a specimen, and must not erase the order either.
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_collectedById_fkey" FOREIGN KEY ("collectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "lab_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_testId_fkey" FOREIGN KEY ("testId") REFERENCES "lab_tests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_resultedById_fkey" FOREIGN KEY ("resultedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_criticalNotifiedById_fkey" FOREIGN KEY ("criticalNotifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_result_values" ADD CONSTRAINT "lab_result_values_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_result_values" ADD CONSTRAINT "lab_result_values_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "lab_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_partners" ADD CONSTRAINT "lab_partners_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_partners" ADD CONSTRAINT "lab_partners_partnerTenantId_fkey" FOREIGN KEY ("partnerTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_referrals" ADD CONSTRAINT "lab_referrals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_referrals" ADD CONSTRAINT "lab_referrals_sourceTenantId_fkey" FOREIGN KEY ("sourceTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_referral_items" ADD CONSTRAINT "lab_referral_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_referral_items" ADD CONSTRAINT "lab_referral_items_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "lab_referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: `npm run db:rls` is REQUIRED after this migration.
--
-- All eight new tables carry `tenantId` and need the generic tenant policy;
-- none of them gets it from this file. The design needs no policy exception in
-- either direction: a referral is written into the receiving lab's scope and
-- the result is written back into the ordering hospital's scope, so
-- `"tenantId" = app_current_tenant()` remains the whole truth on every one of
-- them.
