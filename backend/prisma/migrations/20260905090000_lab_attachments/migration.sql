-- Files attached to a lab result: a signed report, an analyser printout.
--
-- HAND-WRITTEN, like the ten before it, because the machine this was authored
-- on cannot download the Prisma schema engine. Verify with:
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel   prisma/schema.prisma --script
--
-- RUN `npm run db:rls` AFTERWARDS. Both new tables carry `tenantId` and neither
-- gets a policy from this file. `lab_attachment_data` holds the bytes of a
-- patient's report; a table with that column and no policy reads as scoped in
-- review and is open to every hospital at runtime.

-- CreateEnum
CREATE TYPE "LabAttachmentKind" AS ENUM ('REPORT', 'RAW', 'OTHER');

-- CreateTable
-- Metadata only. Listing these must never drag a PDF into memory, which is why
-- the content is not a column here — see `lab_attachment_data` below.
CREATE TABLE "lab_attachments" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    -- Sanitised on the way in: no path, no quotes, no control characters, and
    -- the extension corrected to match what the file actually is. It goes into
    -- a Content-Disposition header, where a quote or a newline is injection.
    "fileName" TEXT NOT NULL,
    -- Determined from the file's own leading bytes. The type the client
    -- declared is used for nothing — see `attachment-rules.ts`.
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    -- SHA-256. Answers "is the file I downloaded the file that was uploaded",
    -- which is the question asked when a report is disputed and which a byte
    -- count cannot answer.
    "checksum" TEXT NOT NULL,
    "kind" "LabAttachmentKind" NOT NULL DEFAULT 'REPORT',
    "description" TEXT,
    "uploadedById" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The bytes, alone.
--
-- A separate table rather than a column on the row above, and that is the whole
-- design. Prisma selects every scalar unless told otherwise, so a `BYTEA`
-- column on `lab_attachments` would mean the query that lists filenames pulling
-- every report into memory — and the mistake would be invisible at the call
-- site. Behind a relation, a blob only arrives if somebody writes an `include`,
-- and exactly one method does.
--
-- Postgres will TOAST these out of line automatically, so the physical storage
-- is already separate; this makes the *query* separate too, which is the half
-- that TOAST does not solve.
CREATE TABLE "lab_attachment_data" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "attachmentId" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "lab_attachment_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lab_attachments_orderItemId_idx" ON "lab_attachments"("orderItemId");
CREATE INDEX "lab_attachments_tenantId_idx" ON "lab_attachments"("tenantId");

-- CreateIndex
-- One blob per attachment, enforced rather than assumed: two rows here would
-- mean a download that returns whichever the planner happened to find first.
CREATE UNIQUE INDEX "lab_attachment_data_attachmentId_key" ON "lab_attachment_data"("attachmentId");
CREATE INDEX "lab_attachment_data_tenantId_idx" ON "lab_attachment_data"("tenantId");

-- AddForeignKey
ALTER TABLE "lab_attachments" ADD CONSTRAINT "lab_attachments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- CASCADE: an attachment belongs to the test it reports on and has no meaning
-- without it.
ALTER TABLE "lab_attachments" ADD CONSTRAINT "lab_attachments_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "lab_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL: deactivating a member of staff must not fail because they once
-- uploaded a report, and must not erase the report either.
ALTER TABLE "lab_attachments" ADD CONSTRAINT "lab_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_attachment_data" ADD CONSTRAINT "lab_attachment_data_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_attachment_data" ADD CONSTRAINT "lab_attachment_data_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "lab_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: `npm run db:rls` is REQUIRED after this migration.
--
-- Both tables carry `tenantId` and need the generic tenant policy.
-- `lab_attachment_data` is the more important of the two: it holds the bytes of
-- a patient's laboratory report, and a missing policy there is one hospital's
-- reports readable by another.
