-- Letterhead: what a hospital prints at the top of anything a patient carries.
--
-- HAND-WRITTEN, like the seven before it, because the machine this was authored
-- on cannot download the Prisma schema engine. Check it before applying:
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel  prisma/schema.prisma --script
--
-- `npm run db:rls` is NOT required for this one. Both tables already carry the
-- generic tenant policy; these are columns on existing tables, not new tables.
--
-- WHY THIS EXISTS
-- The prescription renderer had `<h1>Meridian Hospital</h1>` hard-coded — the
-- demo seed's name, printed on every tenant's prescriptions. A patient walked
-- into a pharmacy holding a document naming a hospital they had never attended.

-- AlterTable: the hospital's own details.
--
-- Every column is nullable. A clinic that fills none still prints a usable
-- document headed with its own name, which tenancy already guaranteed — the
-- letterhead degrades rather than blocking the print.
ALTER TABLE "tenants"
  ADD COLUMN "addressLine1"   TEXT,
  ADD COLUMN "addressLine2"   TEXT,
  ADD COLUMN "city"           TEXT,
  ADD COLUMN "postcode"       TEXT,
  ADD COLUMN "country"        TEXT,
  ADD COLUMN "contactPhone"   TEXT,
  ADD COLUMN "contactEmail"   TEXT,
  ADD COLUMN "website"        TEXT,
  -- The hospital's licence number. Statutory on a prescription in most of the
  -- places this product is aimed at.
  ADD COLUMN "registrationNo" TEXT,
  -- Small print: VAT number, complaints address, "not a receipt". Free text
  -- because what a jurisdiction demands here differs everywhere.
  ADD COLUMN "footerText"     TEXT,
  -- `data:image/png;base64,...`. Stored on the row rather than in object
  -- storage: file storage is the riskiest item in Phase 8 and none of it
  -- exists. The API caps the upload, and `ClinicSettingsService` does not
  -- select this column, so it is read when a document is printed and not on
  -- every request.
  ADD COLUMN "logoDataUrl"    TEXT;

-- AlterTable: the prescriber's qualifications, printed under their name.
ALTER TABLE "doctors"
  ADD COLUMN "qualifications" TEXT;
