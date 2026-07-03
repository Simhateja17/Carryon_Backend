-- Manual driver payout review and processing.
CREATE TYPE "DriverBankDetailsStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Driver"
  ADD COLUMN "bankDetailsStatus" "DriverBankDetailsStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "bankDetailsReviewedAt" TIMESTAMP(3),
  ADD COLUMN "bankDetailsReviewedByAdminId" TEXT,
  ADD COLUMN "bankDetailsRejectionReason" TEXT;

ALTER TABLE "DriverWalletTransaction"
  ADD COLUMN "manualReference" TEXT;

ALTER TABLE "DriverPayout"
  ADD COLUMN "bankSnapshot" JSONB,
  ADD COLUMN "manualReference" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paidByAdminId" TEXT;
