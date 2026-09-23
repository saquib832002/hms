-- What a hospital has been sold.
--
-- HAND-WRITTEN, like the eleven before it, because the machine this was
-- authored on cannot download the Prisma schema engine. Verify with:
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel   prisma/schema.prisma --script
--
-- `npm run db:rls` is NOT needed: this adds one column to a table that already
-- has its policies, and `tenants` is a global model with none by design.

-- CreateEnum
CREATE TYPE "TenantModule" AS ENUM ('CLINIC', 'WARDS', 'PHARMACY', 'LABORATORY', 'BILLING');

-- AlterTable
--
-- Defaulted to everything, so every hospital that existed before modules did
-- keeps working exactly as it did. A vendor narrows it deliberately; nothing
-- narrows on its own.
--
-- An array rather than five booleans. One column to read, one to write, and one
-- thing for `ModuleGuard` to check — five booleans is five places to forget,
-- and the sixth module would be a sixth migration.
ALTER TABLE "tenants"
  ADD COLUMN "modules" "TenantModule"[]
  NOT NULL
  DEFAULT ARRAY['CLINIC', 'WARDS', 'PHARMACY', 'LABORATORY', 'BILLING']::"TenantModule"[];

-- NOTE: no backfill statement is needed.
--
-- `ADD COLUMN ... DEFAULT` writes the default into every existing row, so every
-- hospital already on this database comes out of the migration with all five.
-- That is the intended state: modules are a commercial narrowing applied by a
-- human, and a migration that silently removed one from a live hospital would
-- be this system deciding what somebody had bought.
