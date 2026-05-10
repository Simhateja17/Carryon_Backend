CREATE TABLE "BookingAdjustment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingAdjustment_bookingId_type_key" ON "BookingAdjustment"("bookingId", "type");
CREATE INDEX "BookingAdjustment_bookingId_status_idx" ON "BookingAdjustment"("bookingId", "status");
CREATE INDEX "BookingAdjustment_status_createdAt_idx" ON "BookingAdjustment"("status", "createdAt");

ALTER TABLE "BookingAdjustment"
ADD CONSTRAINT "BookingAdjustment_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "BookingAdjustment" (
    "id",
    "bookingId",
    "type",
    "amount",
    "description",
    "status",
    "metadata",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    "id",
    'PICKUP_WAIT_TIME',
    "waitTimeCharge",
    'Pickup wait-time charge',
    'APPLIED',
    jsonb_build_object('waitTimeMinutes', "waitTimeMinutes", 'source', 'migration_backfill'),
    COALESCE("updatedAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
FROM "Booking"
WHERE "waitTimeCharge" > 0
ON CONFLICT ("bookingId", "type") DO NOTHING;
