-- AlterTable
ALTER TABLE "Transaction"
ADD COLUMN "reconciliationStatus" VARCHAR(20) NOT NULL DEFAULT 'pending',
ADD COLUMN "reconciliationReason" VARCHAR(30),
ADD COLUMN "reconciliationAttemptedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Transaction_reconciliationStatus_reconciliationAttemptedAt_idx"
    ON "Transaction"("reconciliationStatus", "reconciliationAttemptedAt");
