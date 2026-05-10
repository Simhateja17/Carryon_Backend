-- MVP launch policy fields: assignment timing, cancellation fees, wait charges,
-- and approved driver-submitted extra charges.

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "driverAssignedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "driverArrivedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancellationFee" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancellationDriverShare" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancellationPlatformShare" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "waitTimeMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "waitTimeCharge" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "BookingExtraCharge" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "proofUrl" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reviewedByAdminId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookingExtraCharge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookingExtraCharge_bookingId_status_idx" ON "BookingExtraCharge"("bookingId", "status");
CREATE INDEX "BookingExtraCharge_driverId_createdAt_idx" ON "BookingExtraCharge"("driverId", "createdAt");
CREATE INDEX "BookingExtraCharge_status_createdAt_idx" ON "BookingExtraCharge"("status", "createdAt");

ALTER TABLE "BookingExtraCharge"
ADD CONSTRAINT "BookingExtraCharge_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingExtraCharge"
ADD CONSTRAINT "BookingExtraCharge_driverId_fkey"
FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
