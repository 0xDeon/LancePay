-- CreateTable
CREATE TABLE "DistributedJobLock" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "tokenHash" VARCHAR(64),
    "previousTokenHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "holderId" VARCHAR(191),
    "acquiredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributedJobLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DistributedJobLock_name_key" ON "DistributedJobLock"("name");

-- CreateIndex
CREATE INDEX "DistributedJobLock_expiresAt_idx" ON "DistributedJobLock"("expiresAt");
