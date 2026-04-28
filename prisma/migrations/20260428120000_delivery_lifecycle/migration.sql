-- Server-owned delivery lifecycle.
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'ARRIVED_AT_DROP';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeliveryLifecycleActorType') THEN
    CREATE TYPE "DeliveryLifecycleActorType" AS ENUM ('DRIVER', 'USER', 'SYSTEM');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeliveryLifecycleCommand') THEN
    CREATE TYPE "DeliveryLifecycleCommand" AS ENUM (
      'ARRIVE_PICKUP',
      'VERIFY_PICKUP_OTP',
      'START_DELIVERY',
      'ARRIVE_DROP',
      'REQUEST_DROP_OTP',
      'COMPLETE_DELIVERY',
      'CANCEL_BEFORE_PICKUP'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "DeliveryLifecycleEvent" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "actorType" "DeliveryLifecycleActorType" NOT NULL,
  "actorId" TEXT NOT NULL,
  "command" "DeliveryLifecycleCommand" NOT NULL,
  "fromStatus" "BookingStatus",
  "toStatus" "BookingStatus",
  "success" BOOLEAN NOT NULL DEFAULT false,
  "failureCode" TEXT,
  "message" TEXT NOT NULL DEFAULT '',
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "accuracyMeters" DOUBLE PRECISION,
  "distanceToExpectedMeters" DOUBLE PRECISION,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeliveryLifecycleEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeliveryLifecycleEvent_bookingId_createdAt_idx"
  ON "DeliveryLifecycleEvent"("bookingId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeliveryLifecycleEvent_actorType_actorId_createdAt_idx"
  ON "DeliveryLifecycleEvent"("actorType", "actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeliveryLifecycleEvent_command_createdAt_idx"
  ON "DeliveryLifecycleEvent"("command", "createdAt");
CREATE INDEX IF NOT EXISTS "DeliveryLifecycleEvent_success_createdAt_idx"
  ON "DeliveryLifecycleEvent"("success", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DeliveryLifecycleEvent_bookingId_fkey'
  ) THEN
    ALTER TABLE "DeliveryLifecycleEvent"
      ADD CONSTRAINT "DeliveryLifecycleEvent_bookingId_fkey"
      FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
