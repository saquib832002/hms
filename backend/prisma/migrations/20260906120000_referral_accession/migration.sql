-- A referral becomes a real order in the performing laboratory.
--
-- HAND-WRITTEN, like the twelve before it, because the machine this was
-- authored on cannot download the Prisma schema engine. Verify with:
--
--   npx prisma migrate diff \
--     --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script
--
-- `npm run db:rls` is NOT needed: these are columns on tables that already
-- carry their tenant policies.

-- WHY
-- ---
-- Work referred by another hospital was reported in one shot: values typed
-- into a form and transmitted. That skipped specimen acceptance, the bench,
-- and — most seriously — the separation between values entered and values
-- authorised. "Nothing is a result until it is verified" held for a hospital's
-- own orders and not for work it performed for anybody else, which is the
-- opposite of how accreditation assigns responsibility: the *performing*
-- laboratory owns the examination and its release.

-- A referred patient is registered here, because a laboratory labels tubes and
-- prints reports carrying identifiers. Flagged so they stay out of reception's
-- search — the same objection that keeps a pharmacy walk-in out of `patients`.
ALTER TABLE "patients"
  ADD COLUMN "isReferralOrigin" BOOLEAN NOT NULL DEFAULT false;

-- When this lab accessioned the referral and raised its own order.
ALTER TABLE "lab_referrals"
  ADD COLUMN "acceptedAt" TIMESTAMP(3);

-- The order doing the work. UNIQUE: one referral cannot be accessioned twice,
-- and the constraint is the guarantee rather than the service check, exactly
-- as `invoices.appointmentId` is for consultation billing.
ALTER TABLE "lab_orders"
  ADD COLUMN "referralId" INTEGER;

CREATE UNIQUE INDEX "lab_orders_referralId_key"
  ON "lab_orders"("referralId");

ALTER TABLE "lab_orders"
  ADD CONSTRAINT "lab_orders_referralId_fkey"
  FOREIGN KEY ("referralId") REFERENCES "lab_referrals"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: referrals already reported keep `acceptedAt` NULL and gain no order.
--
-- Backfilling one would invent an accession that never happened and put a
-- fabricated order into a laboratory's own record — which is precisely the
-- kind of thing this migration exists to stop. They stay as they are, visible
-- on the reported tab, and the new path applies from here.
