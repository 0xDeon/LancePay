-- CreateTable
CREATE TABLE "LedgerDriftCorrectionProposal" (
    "id" TEXT NOT NULL,
    "driftFindingId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "amount" DECIMAL(18,7) NOT NULL,
    "currency" VARCHAR(12) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "LedgerDriftCorrectionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerDriftCorrectionProposal_driftFindingId_status_idx"
    ON "LedgerDriftCorrectionProposal"("driftFindingId", "status");

-- CreateIndex
CREATE INDEX "LedgerDriftCorrectionProposal_proposedById_idx"
    ON "LedgerDriftCorrectionProposal"("proposedById");

-- CreateIndex
CREATE INDEX "LedgerDriftCorrectionProposal_status_createdAt_idx"
    ON "LedgerDriftCorrectionProposal"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "LedgerDriftCorrectionProposal" ADD CONSTRAINT "LedgerDriftCorrectionProposal_driftFindingId_fkey"
    FOREIGN KEY ("driftFindingId") REFERENCES "LedgerDriftFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerDriftCorrectionProposal" ADD CONSTRAINT "LedgerDriftCorrectionProposal_proposedById_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
