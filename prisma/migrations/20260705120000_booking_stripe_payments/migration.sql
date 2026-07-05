-- Replace customer stored-value wallet checkout with per-booking Stripe payments.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'STRIPE';

CREATE TABLE "BookingPayment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'myr',
    "status" "StripeLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "refundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refundStatus" "StripeLedgerStatus",
    "failureMessage" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingPayment_stripePaymentIntentId_key" ON "BookingPayment"("stripePaymentIntentId");
CREATE INDEX "BookingPayment_bookingId_createdAt_idx" ON "BookingPayment"("bookingId", "createdAt");
CREATE INDEX "BookingPayment_userId_createdAt_idx" ON "BookingPayment"("userId", "createdAt");
CREATE INDEX "BookingPayment_status_createdAt_idx" ON "BookingPayment"("status", "createdAt");
CREATE INDEX "BookingPayment_refundStatus_createdAt_idx" ON "BookingPayment"("refundStatus", "createdAt");

ALTER TABLE "BookingPayment"
ADD CONSTRAINT "BookingPayment_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingPayment"
ADD CONSTRAINT "BookingPayment_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
