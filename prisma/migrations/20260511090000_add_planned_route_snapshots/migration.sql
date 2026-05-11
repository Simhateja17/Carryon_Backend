CREATE TABLE "PlannedRouteSnapshot" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'google',
  "routeHash" TEXT NOT NULL,
  "distanceMeters" INTEGER NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  "geometry" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlannedRouteSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlannedRouteSnapshot_bookingId_routeHash_key" ON "PlannedRouteSnapshot"("bookingId", "routeHash");
CREATE INDEX "PlannedRouteSnapshot_bookingId_expiresAt_idx" ON "PlannedRouteSnapshot"("bookingId", "expiresAt");
CREATE INDEX "PlannedRouteSnapshot_expiresAt_idx" ON "PlannedRouteSnapshot"("expiresAt");

ALTER TABLE "PlannedRouteSnapshot"
  ADD CONSTRAINT "PlannedRouteSnapshot_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
