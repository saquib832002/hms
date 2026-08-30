/*
  Warnings:

  - A unique constraint covering the columns `[appointmentId]` on the table `invoices` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "consultationFee" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "appointmentId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "invoices_appointmentId_key" ON "invoices"("appointmentId");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
