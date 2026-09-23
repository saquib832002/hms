-- The order number on the partner-lab payable.
--
-- HAND-WRITTEN, like the sixteen before it. `npm run db:rls` is NOT needed:
-- one column on a table that already carries its policy.
--
-- Nullable and not backfilled. The referral it came from holds the sending
-- hospital's accession, but joining across it to fill this in would guess at
-- rows written before the accession reached the payable — and a number on a
-- financial record that nobody put there is worse than an honest blank.
ALTER TABLE "partner_lab_charges" ADD COLUMN "sourceAccession" TEXT;
