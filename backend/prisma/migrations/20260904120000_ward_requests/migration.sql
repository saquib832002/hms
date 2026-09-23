-- Ward requests: supply (logistics) and medication (clinical).
--
-- HAND-WRITTEN, like the four before it, because the machine this was authored
-- on cannot download the Prisma schema engine. Check it before applying to
-- anything holding data:
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel  prisma/schema.prisma --script
--
-- and run `npm run db:rls` AFTERWARDS. Both new tables carry `tenantId` and
-- need the generic tenant policy; they do not get it from this file.

-- CreateEnum
CREATE TYPE "SupplyRequestStatus" AS ENUM ('REQUESTED', 'SUPPLIED', 'DECLINED');

-- CreateEnum
CREATE TYPE "MedicationRequestStatus" AS ENUM ('REQUESTED', 'PRESCRIBED', 'DECLINED');

-- CreateTable
--
-- `prescriptionItemId` is NOT NULL on purpose. A supply request names a line a
-- prescriber already wrote; one that could name any medicine would be
-- prescribing with extra steps, which is the whole distinction between this
-- table and the next one.
CREATE TABLE "supply_requests" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "admissionId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "prescriptionItemId" INTEGER NOT NULL,
    "quantity" INTEGER,
    "note" TEXT,
    "status" "SupplyRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedById" INTEGER,
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,

    CONSTRAINT "supply_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- `medicineText` is free text and not a catalogue FK. The nurse is describing a
-- need, not selecting a product; a FK here would quietly make the request a
-- draft prescription, which is the thing this design refuses.
CREATE TABLE "medication_requests" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "admissionId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "medicineText" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MedicationRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedById" INTEGER,
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "prescriptionId" INTEGER,

    CONSTRAINT "medication_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supply_requests_status_requestedAt_idx" ON "supply_requests"("status", "requestedAt");
CREATE INDEX "supply_requests_admissionId_idx" ON "supply_requests"("admissionId");
CREATE INDEX "supply_requests_tenantId_idx" ON "supply_requests"("tenantId");

CREATE INDEX "medication_requests_status_requestedAt_idx" ON "medication_requests"("status", "requestedAt");
CREATE INDEX "medication_requests_admissionId_idx" ON "medication_requests"("admissionId");
CREATE INDEX "medication_requests_tenantId_idx" ON "medication_requests"("tenantId");

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_prescriptionItemId_fkey" FOREIGN KEY ("prescriptionItemId") REFERENCES "prescription_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_respondedById_fkey" FOREIGN KEY ("respondedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_respondedById_fkey" FOREIGN KEY ("respondedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
