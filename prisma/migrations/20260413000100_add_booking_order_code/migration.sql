ALTER TABLE "Booking" ADD COLUMN "orderCode" TEXT;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "Booking"
)
UPDATE "Booking" b
SET "orderCode" = 'ORD-' || LPAD(numbered.rn::text, 6, '0')
FROM numbered
WHERE b.id = numbered.id;

ALTER TABLE "Booking" ALTER COLUMN "orderCode" SET NOT NULL;

CREATE UNIQUE INDEX "Booking_orderCode_key" ON "Booking"("orderCode");
