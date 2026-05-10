-- MVP launch policy fields: assignment timing, cancellation fees, wait charges,
-- and approved driver-submitted extra charges.

ALTER TABLE "Booking"
ADD COLUMN "driverAssignedAt" TIMESTAMP(3),
ADD COLUMN "driverArrivedAt" TIMESTAMP(3),
ADD COLUMN "cancelledBy" TEXT,
ADD COLUMN "cancelReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN "cancellationFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "cancellationDriverShare" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "cancellationPlatformShare" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "waitTimeMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "waitTimeCharge" DOUBLE PRECISION NOT NULL DEFAULT 0;

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
