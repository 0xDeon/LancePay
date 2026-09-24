CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "debitAccount" VARCHAR(100) NOT NULL,
    "creditAccount" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JournalEntry_userId_date_idx" ON "JournalEntry"("userId", "date");
CREATE INDEX "JournalEntry_currency_idx" ON "JournalEntry"("currency");

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
