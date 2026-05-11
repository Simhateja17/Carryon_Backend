CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_bookingId_key" ON "Invoice"("bookingId");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "Invoice_userId_issuedAt_idx" ON "Invoice"("userId", "issuedAt");

ALTER TABLE "Invoice" ALTER COLUMN "taxRate" SET DEFAULT 0.05;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_bookingId_fkey'
  ) THEN
    ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_userId_fkey'
  ) THEN
    ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "Invoice" (
    "id",
    "bookingId",
    "userId",
    "invoiceNumber",
    "subtotal",
    "tax",
    "discount",
    "total",
    "taxRate",
    "currency",
    "issuedAt"
)
WITH missing_delivered AS (
    SELECT
        b."id",
        b."userId",
        b."deliveredAt",
        b."createdAt",
        COALESCE(NULLIF(b."finalPrice", 0), b."estimatedPrice", 0) +
          COALESCE(SUM(ba."amount") FILTER (WHERE COALESCE(ba."status", 'APPLIED') = 'APPLIED'), 0) AS total,
        COALESCE(b."discountAmount", 0) AS discount,
        ROW_NUMBER() OVER (ORDER BY COALESCE(b."deliveredAt", b."createdAt"), b."id") AS rn
    FROM "Booking" b
    LEFT JOIN "Invoice" i ON i."bookingId" = b."id"
    LEFT JOIN "BookingAdjustment" ba ON ba."bookingId" = b."id"
    WHERE b."status" = 'DELIVERED'
      AND i."id" IS NULL
    GROUP BY b."id", b."userId", b."deliveredAt", b."createdAt", b."finalPrice", b."estimatedPrice", b."discountAmount"
)
SELECT
    gen_random_uuid()::text,
    md."id",
    md."userId",
    'CO-' || to_char(COALESCE(md."deliveredAt", md."createdAt", CURRENT_TIMESTAMP), 'YYYYMMDD') || '-B' || LPAD(md.rn::text, 4, '0'),
    ROUND((md.total / 1.05)::numeric, 2)::double precision,
    ROUND((md.total - (md.total / 1.05))::numeric, 2)::double precision,
    md.discount,
    ROUND(md.total::numeric, 2)::double precision,
    0.05,
    'MYR',
    COALESCE(md."deliveredAt", md."createdAt", CURRENT_TIMESTAMP)
FROM missing_delivered md
ON CONFLICT ("bookingId") DO NOTHING;
