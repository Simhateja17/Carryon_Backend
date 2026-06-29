-- Add an intermediate state for Stripe transfers that have reached the
-- connected account but have not yet produced a terminal bank payout webhook.
ALTER TYPE "DriverTransactionStatus" ADD VALUE IF NOT EXISTS 'TRANSFERRED';

ALTER TYPE "DriverNotificationType" ADD VALUE IF NOT EXISTS 'PAYOUT_PAID';
ALTER TYPE "DriverNotificationType" ADD VALUE IF NOT EXISTS 'PAYOUT_FAILED';
ALTER TYPE "DriverNotificationType" ADD VALUE IF NOT EXISTS 'PAYOUT_SETUP_NEEDED';

ALTER TABLE "DriverPayout"
ADD COLUMN IF NOT EXISTS "stripePayoutId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "DriverPayout_stripePayoutId_key"
ON "DriverPayout"("stripePayoutId");
