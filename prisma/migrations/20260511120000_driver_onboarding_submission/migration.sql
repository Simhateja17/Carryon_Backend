-- Persist the full driver onboarding review surface. Operational fields stay
-- queryable on Driver/DriverVehicle, while each final submission keeps an
-- immutable JSON snapshot for audit and future review changes.

ALTER TABLE "Driver"
ADD COLUMN "gender" TEXT NOT NULL DEFAULT '',
ADD COLUMN "nationality" TEXT NOT NULL DEFAULT '',
ADD COLUMN "mykadNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "passportNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "passportExpiry" TEXT,
ADD COLUMN "plksNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "plksExpiry" TEXT,
ADD COLUMN "licenseClass" TEXT NOT NULL DEFAULT '',
ADD COLUMN "licenseExpiry" TEXT,
ADD COLUMN "hasGDL" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "gdlExpiry" TEXT,
ADD COLUMN "addressLine1" TEXT NOT NULL DEFAULT '',
ADD COLUMN "addressLine2" TEXT NOT NULL DEFAULT '',
ADD COLUMN "city" TEXT NOT NULL DEFAULT '',
ADD COLUMN "postcode" TEXT NOT NULL DEFAULT '',
ADD COLUMN "state" TEXT NOT NULL DEFAULT '',
ADD COLUMN "workingStates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "emergencyContactName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "emergencyContactRelation" TEXT NOT NULL DEFAULT '',
ADD COLUMN "emergencyContactPhone" TEXT NOT NULL DEFAULT '',
ADD COLUMN "bankName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "bankAccountNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "bankAccountHolder" TEXT NOT NULL DEFAULT '',
ADD COLUMN "duitNowId" TEXT NOT NULL DEFAULT '',
ADD COLUMN "tngEwalletId" TEXT NOT NULL DEFAULT '',
ADD COLUMN "lhdnTaxNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "sstNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "pdpaConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "backgroundCheckConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "agreementVersion" TEXT NOT NULL DEFAULT '',
ADD COLUMN "noOffencesDeclared" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "onboardingSubmittedAt" TIMESTAMP(3);

ALTER TABLE "DriverVehicle"
ADD COLUMN "chassisNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "engineNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "ownership" TEXT NOT NULL DEFAULT '',
ADD COLUMN "ownerName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "roadTaxExpiry" TEXT,
ADD COLUMN "puspakomExpiry" TEXT,
ADD COLUMN "apadPermitNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "apadPermitExpiry" TEXT,
ADD COLUMN "insurerName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "insurancePolicyNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN "insuranceCoverageType" TEXT NOT NULL DEFAULT '',
ADD COLUMN "insuranceExpiry" TEXT,
ADD COLUMN "hasCommercialCover" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DriverOnboardingSubmission" (
  "id" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "agreementVersion" TEXT NOT NULL DEFAULT '',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DriverOnboardingSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverOnboardingSubmission_driverId_submittedAt_idx"
  ON "DriverOnboardingSubmission"("driverId", "submittedAt");

ALTER TABLE "DriverOnboardingSubmission"
ADD CONSTRAINT "DriverOnboardingSubmission_driverId_fkey"
FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
