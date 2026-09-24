ALTER TABLE "BrandingSettings"
ADD COLUMN "customDomain" VARCHAR(253),
ADD COLUMN "domainVerifiedAt" TIMESTAMP(3),
ADD COLUMN "senderDomain" VARCHAR(253) NOT NULL DEFAULT 'lancepay.com',
ADD COLUMN "domainRevokedAt" TIMESTAMP(3),
ADD COLUMN "domainRevocationReason" VARCHAR(500);

CREATE UNIQUE INDEX "BrandingSettings_customDomain_key" ON "BrandingSettings"("customDomain");
