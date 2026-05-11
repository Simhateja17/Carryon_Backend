ALTER TABLE "Driver"
ADD COLUMN "verificationRejectionReason" TEXT,
ADD COLUMN "verificationReviewedAt" TIMESTAMP(3),
ADD COLUMN "verificationReviewedByAdminId" TEXT;
