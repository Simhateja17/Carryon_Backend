-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('FCM');

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "driverId" TEXT,
    "platform" "PushPlatform" NOT NULL,
    "provider" "PushProvider" NOT NULL DEFAULT 'FCM',
    "deviceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "appVersion" TEXT,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_userId_deviceId_key" ON "PushDevice"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_driverId_deviceId_key" ON "PushDevice"("driverId", "deviceId");

-- CreateIndex
CREATE INDEX "PushDevice_userId_notificationsEnabled_idx" ON "PushDevice"("userId", "notificationsEnabled");

-- CreateIndex
CREATE INDEX "PushDevice_driverId_notificationsEnabled_idx" ON "PushDevice"("driverId", "notificationsEnabled");

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "PushDevice"
    ADD CONSTRAINT "PushDevice_exactly_one_actor_check"
    CHECK (
        (CASE WHEN "userId" IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN "driverId" IS NULL THEN 0 ELSE 1 END) = 1
    );

-- Backfill legacy single-token driver registrations.
INSERT INTO "PushDevice" (
    "id",
    "driverId",
    "platform",
    "provider",
    "deviceId",
    "token",
    "notificationsEnabled",
    "lastSeenAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'legacy-driver-' || "id",
    "id",
    'ANDROID'::"PushPlatform",
    'FCM'::"PushProvider",
    'legacy-driver-device',
    "fcmToken",
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Driver"
WHERE "fcmToken" IS NOT NULL
  AND length(trim("fcmToken")) > 0
ON CONFLICT ("token") DO NOTHING;
