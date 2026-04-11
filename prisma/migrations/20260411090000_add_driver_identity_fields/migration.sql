-- AlterTable
ALTER TABLE "Driver"
ADD COLUMN "driversLicenseNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "dateOfBirth" TEXT NOT NULL DEFAULT '';
