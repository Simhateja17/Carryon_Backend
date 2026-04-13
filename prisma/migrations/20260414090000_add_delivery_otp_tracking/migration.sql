-- AlterTable
ALTER TABLE "Address"
ADD COLUMN "contactEmail" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Booking"
ADD COLUMN "dispatchSource" TEXT NOT NULL DEFAULT 'USER_APP',
ADD COLUMN "deliveryOtp" TEXT NOT NULL DEFAULT '',
ADD COLUMN "deliveryOtpSentAt" TIMESTAMP(3),
ADD COLUMN "deliveryOtpVerifiedAt" TIMESTAMP(3);
