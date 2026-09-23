-- Observation orders and escalations.
--
-- HAND-WRITTEN, like the six before it, because the machine this was authored
-- on cannot download the Prisma schema engine. Check it before applying to
-- anything holding data:
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel  prisma/schema.prisma --script
--
-- and run `npm run db:rls` AFTERWARDS. Both tables carry `tenantId` and need
-- the generic tenant policy; they do not get it from this file.

-- CreateEnum
--
-- Every member names a real charting interval, because the ward board has to
-- decide whether a set is overdue and cannot do that against a word.
-- "Continuous" is deliberately absent rather than mapped to a guessed number.
CREATE TYPE "ObservationFrequency" AS ENUM (
  'QUARTER_HOURLY', 'HALF_HOURLY', 'HOURLY', 'TWO_HOURLY',
  'FOUR_HOURLY', 'SIX_HOURLY', 'TWELVE_HOURLY', 'DAILY'
);

-- CreateTable
--
-- Never updated in place. Each change is a new row and the newest wins, so
-- "who moved this patient to hourly obs, and when" stays answerable — the
-- first question asked after a deterioration nobody caught.
CREATE TABLE "observation_orders" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "admissionId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "frequency" "ObservationFrequency" NOT NULL,
    "reason" TEXT,
    "isEscalation" BOOLEAN NOT NULL DEFAULT false,
    "setById" INTEGER NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "observation_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- `respondedAt` NULL is itself the finding: an escalation nobody answered is
-- exactly what an incident review looks for, so it is a visible open state
-- rather than an absent field.
CREATE TABLE "observation_escalations" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "admissionId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "vitalId" INTEGER,
    "escalatedTo" TEXT NOT NULL,
    "concern" TEXT NOT NULL,
    "raisedById" INTEGER NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "observation_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "observation_orders_admissionId_setAt_idx" ON "observation_orders"("admissionId", "setAt");
CREATE INDEX "observation_orders_tenantId_idx" ON "observation_orders"("tenantId");

CREATE INDEX "observation_escalations_admissionId_raisedAt_idx" ON "observation_escalations"("admissionId", "raisedAt");
-- Open escalations are the ones anybody looks for, so the null case is indexed.
CREATE INDEX "observation_escalations_respondedAt_idx" ON "observation_escalations"("respondedAt");
CREATE INDEX "observation_escalations_tenantId_idx" ON "observation_escalations"("tenantId");

-- AddForeignKey
ALTER TABLE "observation_orders" ADD CONSTRAINT "observation_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "observation_orders" ADD CONSTRAINT "observation_orders_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "observation_orders" ADD CONSTRAINT "observation_orders_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "observation_escalations" ADD CONSTRAINT "observation_escalations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "observation_escalations" ADD CONSTRAINT "observation_escalations_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "observation_escalations" ADD CONSTRAINT "observation_escalations_vitalId_fkey" FOREIGN KEY ("vitalId") REFERENCES "vitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "observation_escalations" ADD CONSTRAINT "observation_escalations_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
