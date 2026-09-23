-- The number on the tube.
--
-- HAND-WRITTEN, like the fifteen before it. `npm run db:rls` is NOT needed:
-- these are columns on tables that already carry their policies.

-- AlterTable
--
-- Nullable, and deliberately not backfilled. An accession is allocated when a
-- specimen is ordered; inventing one for an order raised before this existed
-- would put a number on a record that never had a label printed for it, which
-- is worse than the honest absence — the screens say "not allocated" rather
-- than showing a number nobody can find on a tube.
ALTER TABLE "lab_orders" ADD COLUMN "accession" TEXT;

-- Unique per hospital, not globally.
--
-- Two hospitals on this platform legitimately both have a 26-000412, and the
-- moment work crosses between them a global unique would refuse a perfectly
-- ordinary specimen. Postgres treats NULLs as distinct, so the un-backfilled
-- rows above do not collide with each other.
CREATE UNIQUE INDEX "lab_orders_tenantId_accession_key"
  ON "lab_orders" ("tenantId", "accession");

-- AlterTable
ALTER TABLE "lab_referrals" ADD COLUMN "sourceAccession" TEXT;
