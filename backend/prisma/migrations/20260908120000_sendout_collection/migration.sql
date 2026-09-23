-- The specimen is drawn at the referring hospital and only the tube travels.
--
-- HAND-WRITTEN, like the seventeen before it. `npm run db:rls` is NOT needed:
-- three columns on tables that already carry their policies.

-- AlterTable
--
-- When the tube left us for the partner. Separate from `collectedAt`, because
-- the gap between them is real: a specimen drawn at 09:14 and couriered at
-- 16:00 spent the day on a bench, and a potassium from it reads differently.
ALTER TABLE "lab_orders" ADD COLUMN "dispatchedAt" TIMESTAMP(3);

-- AlterTable
--
-- The sender's draw and dispatch times, carried onto the referral so the
-- receiving laboratory can judge sample integrity. Null means the tube has not
-- been drawn yet — the referral was transmitted so the lab can expect it.
ALTER TABLE "lab_referrals" ADD COLUMN "collectedAt"  TIMESTAMP(3);
ALTER TABLE "lab_referrals" ADD COLUMN "dispatchedAt" TIMESTAMP(3);
