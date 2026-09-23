-- Subscriptions, and a place for people to ask to become customers.
--
-- Hand-written, like the pharmacy_billing migration before it, because the
-- machine this was authored on cannot download the Prisma schema engine. Verify
-- with `prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` before applying it to
-- anything holding data.
--
-- Additive and defaulted throughout, so an existing hospital keeps working
-- exactly as it did. The default is TRIAL with a NULL end date, which behaves
-- identically to ACTIVE — see the note on `subscriptionEndsAt` in the schema
-- for why a missing date must never be read as "expired".

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TenantApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL';
ALTER TABLE "tenants" ADD COLUMN "subscriptionEndsAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "subscriptionNote" TEXT;

-- Every hospital that already exists was onboarded by hand and is presumed a
-- paying customer. Leaving them on the TRIAL default would be accurate about
-- the column and wrong about the world.
UPDATE "tenants" SET "subscriptionStatus" = 'ACTIVE';

-- CreateTable
CREATE TABLE "tenant_applications" (
    "id" SERIAL NOT NULL,
    "hospitalName" TEXT NOT NULL,
    "requestedSlug" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "notes" TEXT,
    "timezone" TEXT,
    "currency" TEXT,
    "status" "TenantApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "tenantId" INTEGER,
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedFromIp" TEXT,

    CONSTRAINT "tenant_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_applications_status_createdAt_idx" ON "tenant_applications"("status", "createdAt");
CREATE INDEX "tenant_applications_contactEmail_idx" ON "tenant_applications"("contactEmail");

-- AddForeignKey
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_applications_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: `tenant_applications` carries no tenantId and is NOT tenant-scoped. It
-- takes the *inverted* platform policy — visible only when no hospital is in
-- scope — which `npm run db:rls` applies and self-checks. Run it after this.
