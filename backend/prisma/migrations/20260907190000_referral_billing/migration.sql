-- Who pays the laboratory for referred work.
--
-- HAND-WRITTEN, like the thirteen before it, because the machine this was
-- authored on cannot download the Prisma schema engine. Verify with:
--
--   npx prisma migrate diff \
--     --from-migrations      prisma/migrations \
--     --to-schema-datamodel  prisma/schema.prisma --script
--
-- `npm run db:rls` is NOT needed. This creates one type and adds four columns
-- to tables that already carry their policies; it creates no table.

-- CreateEnum
CREATE TYPE "ReferralBilling" AS ENUM ('ORIGIN_PAYS', 'PATIENT_PAYS');

-- AlterTable
--
-- The receiving half of the handshake. Defaulted to ORIGIN_PAYS alone, because
-- that is precisely what every lab predating this was silently doing — it is
-- the only arrangement the code could express — so no existing partnership
-- changes meaning on the morning this is applied.
--
-- An empty array is legal and means the lab takes external orders under no
-- billing arrangement at all. That is a real state during setup rather than a
-- broken one, and the partner lookup says so rather than reporting the lab as
-- not found.
ALTER TABLE "tenants"
  ADD COLUMN "acceptedReferralBilling" "ReferralBilling"[]
  NOT NULL
  DEFAULT ARRAY['ORIGIN_PAYS']::"ReferralBilling"[];

-- AlterTable
--
-- The sending half: a commercial term of one relationship, which is why it is
-- here and not on either tenant. One laboratory routinely holds a wholesale
-- contract with a hospital group and takes walk-in referrals from a clinic
-- down the road.
ALTER TABLE "lab_partners"
  ADD COLUMN "billing" "ReferralBilling" NOT NULL DEFAULT 'ORIGIN_PAYS';

-- AlterTable
--
-- The snapshot. Read by everything at the receiving end; `lab_partners` lives
-- in the sender's scope and is not reachable from here at all.
--
-- Backfilling to ORIGIN_PAYS is correct rather than merely convenient: every
-- referral already in this table was accepted and invoiced to the sending
-- hospital, so this records what actually happened.
ALTER TABLE "lab_referrals"
  ADD COLUMN "billing" "ReferralBilling" NOT NULL DEFAULT 'ORIGIN_PAYS';

-- AlterTable
--
-- "Somebody else is charging for this", which is a different fact from
-- "nobody priced it". Every row that exists today is the latter or is priced,
-- so false is the honest backfill.
ALTER TABLE "lab_order_items"
  ADD COLUMN "payableExternally" BOOLEAN NOT NULL DEFAULT false;
