-- CreateTable
CREATE TABLE "LedgerDriftFinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "currency" VARCHAR(12) NOT NULL DEFAULT 'USDC',
    "ledgerBalance" DECIMAL(18,7) NOT NULL,
    "onChainBalance" DECIMAL(18,7) NOT NULL,
    "driftAmount" DECIMAL(18,7) NOT NULL,
    "tolerance" DECIMAL(18,7) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "LedgerDriftFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerDriftFinding_userId_currency_idx" ON "LedgerDriftFinding"("userId", "currency");

-- CreateIndex
CREATE INDEX "LedgerDriftFinding_status_detectedAt_idx" ON "LedgerDriftFinding"("status", "detectedAt");

-- AddForeignKey
ALTER TABLE "LedgerDriftFinding" ADD CONSTRAINT "LedgerDriftFinding_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerDriftFinding" ADD CONSTRAINT "LedgerDriftFinding_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
