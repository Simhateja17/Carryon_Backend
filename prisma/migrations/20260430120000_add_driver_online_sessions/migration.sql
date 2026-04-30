CREATE TABLE "DriverOnlineSession" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverOnlineSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverOnlineSession_driverId_startedAt_idx" ON "DriverOnlineSession"("driverId", "startedAt");
CREATE INDEX "DriverOnlineSession_driverId_endedAt_idx" ON "DriverOnlineSession"("driverId", "endedAt");

ALTER TABLE "DriverOnlineSession"
ADD CONSTRAINT "DriverOnlineSession_driverId_fkey"
FOREIGN KEY ("driverId") REFERENCES "Driver"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
