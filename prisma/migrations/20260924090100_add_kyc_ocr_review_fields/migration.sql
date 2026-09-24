ALTER TABLE "KycDocument"
ADD COLUMN "ocrConfidence" DECIMAL(5,4),
ADD COLUMN "ocrReviewedAt" TIMESTAMP(3);

CREATE INDEX "KycDocument_ocrConfidence_ocrReviewedAt_idx"
ON "KycDocument"("ocrConfidence", "ocrReviewedAt");
