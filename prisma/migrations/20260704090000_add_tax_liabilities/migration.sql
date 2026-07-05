-- Track tax collected from customers as a separate payable liability.
CREATE TYPE "TaxLiabilityStatus" AS ENUM ('PENDING', 'REMITTED', 'VOID');

ALTER TABLE "Invoice" ALTER COLUMN "taxRate" SET DEFAULT 0.06;

CREATE TABLE "TaxLiability" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taxableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "status" "TaxLiabilityStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'BOOKING',
    "remittedAt" TIMESTAMP(3),
    "remittedByAdminId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxLiability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaxLiability_bookingId_key" ON "TaxLiability"("bookingId");
CREATE INDEX "TaxLiability_status_createdAt_idx" ON "TaxLiability"("status", "createdAt");
CREATE INDEX "TaxLiability_userId_createdAt_idx" ON "TaxLiability"("userId", "createdAt");

ALTER TABLE "TaxLiability"
ADD CONSTRAINT "TaxLiability_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TaxLiability"
ADD CONSTRAINT "TaxLiability_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "TaxLiability" (
    "id",
    "bookingId",
    "userId",
    "taxableAmount",
    "taxAmount",
    "totalAmount",
    "taxRate",
    "currency",
    "status",
    "source",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    i."bookingId",
    i."userId",
    i."subtotal",
    i."tax",
    i."total",
    i."taxRate",
    i."currency",
    'PENDING'::"TaxLiabilityStatus",
    'INVOICE_BACKFILL',
    i."issuedAt",
    CURRENT_TIMESTAMP
FROM "Invoice" i
LEFT JOIN "TaxLiability" tl ON tl."bookingId" = i."bookingId"
WHERE tl."id" IS NULL;

WITH recalculated AS (
    SELECT
        t."id",
        t."walletId",
        t."amount" AS "oldDriverAmount",
        COALESCE(NULLIF(t."grossAmount", 0), b."finalPrice", b."estimatedPrice", 0) AS "grossAmount",
        COALESCE(i."taxRate", 0.06) AS "taxRate"
    FROM "DriverWalletTransaction" t
    JOIN "DriverWallet" w ON w."id" = t."walletId"
    LEFT JOIN "Booking" b ON b."id" = t."jobId"
    LEFT JOIN "Invoice" i ON i."bookingId" = b."id"
    WHERE t."type" = 'DELIVERY_EARNING'
      AND t."status" = 'COMPLETED'
      AND t."jobId" IS NOT NULL
),
split AS (
    SELECT
        "id",
        "walletId",
        "oldDriverAmount",
        ROUND(("grossAmount")::numeric, 2)::double precision AS "grossAmount",
        ROUND(("grossAmount" / (1 + "taxRate"))::numeric, 2)::double precision AS "taxableAmount"
    FROM recalculated
),
updated AS (
    UPDATE "DriverWalletTransaction" t
    SET
        "grossAmount" = s."grossAmount",
        "amount" = ROUND((s."taxableAmount" * 0.88)::numeric, 2)::double precision,
        "platformFeeAmount" = ROUND((s."taxableAmount" - ROUND((s."taxableAmount" * 0.88)::numeric, 2))::numeric, 2)::double precision
    FROM split s
    WHERE t."id" = s."id"
    RETURNING
        t."walletId",
        t."amount" - s."oldDriverAmount" AS "driverAmountDelta"
),
wallet_deltas AS (
    SELECT "walletId", SUM("driverAmountDelta") AS "driverAmountDelta"
    FROM updated
    GROUP BY "walletId"
)
UPDATE "DriverWallet" w
SET
    "balance" = w."balance" + d."driverAmountDelta",
    "lifetimeEarnings" = w."lifetimeEarnings" + d."driverAmountDelta"
FROM wallet_deltas d
WHERE w."id" = d."walletId";
