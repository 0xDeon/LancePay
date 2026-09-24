-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "deactivatesAt" TIMESTAMP(3);

-- CreateIndex for grace period queries
CREATE INDEX "ApiKey_deactivatesAt_idx" ON "ApiKey"("deactivatesAt");
