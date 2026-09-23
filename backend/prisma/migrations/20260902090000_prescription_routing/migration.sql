-- Sending a prescription to a pharmacy that is not yours.
--
-- Hand-written, like the two before it, because the machine this was authored
-- on cannot download the Prisma schema engine. Verify with `migrate diff
-- --from-schema-datasource ... --to-schema-datamodel ...` after applying.
--
-- Additive and defaulted throughout: an existing hospital keeps a pharmacy,
-- accepts nothing from outside, and every existing prescription stays IN_HOUSE,
-- which is exactly how they behaved before this existed.

-- CreateEnum
CREATE TYPE "PrescriptionDestination" AS ENUM ('IN_HOUSE', 'EXTERNAL', 'PARTNER');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "hasPharmacy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "acceptsExternalPrescriptions" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN "destination" "PrescriptionDestination" NOT NULL DEFAULT 'IN_HOUSE';
ALTER TABLE "prescriptions" ADD COLUMN "routedToTenantId" INTEGER;

-- AlterTable
ALTER TABLE "dispense_events" ADD COLUMN "referralId" INTEGER;

-- CreateTable
CREATE TABLE "pharmacy_partners" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "partnerTenantId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_referrals" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "sourceTenantId" INTEGER NOT NULL,
    "sourceTenantName" TEXT NOT NULL,
    "sourcePrescriptionId" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "patientDob" TIMESTAMP(3),
    "prescriberName" TEXT NOT NULL,
    "prescriberRegistrationNo" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "dispensedAt" TIMESTAMP(3),
    "dispenseEventId" INTEGER,
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescription_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_referral_items" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "referralId" INTEGER NOT NULL,
    "medicineName" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration" TEXT NOT NULL,

    CONSTRAINT "prescription_referral_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_partners_tenantId_partnerTenantId_key" ON "pharmacy_partners"("tenantId", "partnerTenantId");
CREATE INDEX "pharmacy_partners_tenantId_idx" ON "pharmacy_partners"("tenantId");

-- The reference is what a patient reads out at a counter, so it has to be
-- unique within the pharmacy that will be typing it — not globally, which would
-- make it longer for no benefit.
CREATE UNIQUE INDEX "prescription_referrals_tenantId_reference_key" ON "prescription_referrals"("tenantId", "reference");
CREATE INDEX "prescription_referrals_tenantId_dispensedAt_idx" ON "prescription_referrals"("tenantId", "dispensedAt");

CREATE INDEX "prescription_referral_items_referralId_idx" ON "prescription_referral_items"("referralId");
CREATE INDEX "prescription_referral_items_tenantId_idx" ON "prescription_referral_items"("tenantId");

-- AddForeignKey
ALTER TABLE "pharmacy_partners" ADD CONSTRAINT "pharmacy_partners_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_partners" ADD CONSTRAINT "pharmacy_partners_partnerTenantId_fkey" FOREIGN KEY ("partnerTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescription_referrals" ADD CONSTRAINT "prescription_referrals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prescription_referrals" ADD CONSTRAINT "prescription_referrals_sourceTenantId_fkey" FOREIGN KEY ("sourceTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescription_referral_items" ADD CONSTRAINT "prescription_referral_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prescription_referral_items" ADD CONSTRAINT "prescription_referral_items_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "prescription_referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: all three new tables are tenant-scoped and need the generic policy.
-- Run `npm run db:rls` after this. A referral belongs to the RECEIVING pharmacy
-- and is protected by their policy like any other row of theirs — the design
-- transmits a copy precisely so that no policy exception is needed.
