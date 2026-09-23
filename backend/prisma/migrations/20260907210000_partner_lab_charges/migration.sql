-- What a hospital owes a partner laboratory, in the hospital's own books.
--
-- HAND-WRITTEN, like the fourteen before it. Verify with:
--
--   npx prisma migrate diff \
--     --from-migrations      prisma/migrations \
--     --to-schema-datamodel  prisma/schema.prisma --script
--
-- **`npm run db:rls` IS required.** This creates a table carrying `tenantId`
-- and it gets no policy from this file — the generic tenant policy is applied
-- by that script. Without it the row is protected by a `where` clause and
-- nothing else, which is precisely what the RLS design refuses to rely on.

-- CreateTable
CREATE TABLE "partner_lab_charges" (
  "id"               SERIAL       NOT NULL,
  "tenantId"         INTEGER      NOT NULL,
  "partnerTenantId"  INTEGER      NOT NULL,
  "partnerName"      TEXT         NOT NULL,
  "sourceReferralId" INTEGER      NOT NULL,
  "reference"        TEXT         NOT NULL,
  "amount"           DECIMAL(10,2) NOT NULL,
  "testCount"        INTEGER      NOT NULL,
  "incurredAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"        TIMESTAMP(3),
  "settledById"      INTEGER,
  "settledNote"      TEXT,

  CONSTRAINT "partner_lab_charges_pkey" PRIMARY KEY ("id")
);

-- One notice per referral.
--
-- The write-back happens *after* the accession transaction commits — it enters
-- another tenant's scope and must not be nested, the same rule `transmit`
-- follows — so a retry is a real possibility and not a theoretical one. This
-- index is what makes the retry safe rather than doubling somebody's debt.
CREATE UNIQUE INDEX "partner_lab_charges_tenantId_partnerTenantId_sourceReferralId_key"
  ON "partner_lab_charges" ("tenantId", "partnerTenantId", "sourceReferralId");

CREATE INDEX "partner_lab_charges_tenantId_settledAt_idx"
  ON "partner_lab_charges" ("tenantId", "settledAt");

ALTER TABLE "partner_lab_charges"
  ADD CONSTRAINT "partner_lab_charges_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "partner_lab_charges"
  ADD CONSTRAINT "partner_lab_charges_partnerTenantId_fkey"
  FOREIGN KEY ("partnerTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "partner_lab_charges"
  ADD CONSTRAINT "partner_lab_charges_settledById_fkey"
  FOREIGN KEY ("settledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
