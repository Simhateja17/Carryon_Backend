-- CreateEnum
CREATE TYPE "StripeLedgerStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELED', 'REFUNDED');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "Driver"
ADD COLUMN "stripeConnectAccountId" TEXT,
ADD COLUMN "stripeDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "stripeRequirements" JSONB;

-- AlterTable
ALTER TABLE "WalletTransaction"
ADD COLUMN "stripePaymentIntentId" TEXT;

-- AlterTable
ALTER TABLE "DriverWalletTransaction"
ADD COLUMN "grossAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "platformFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "stripeTransferId" TEXT;

-- CreateTable
CREATE TABLE "WalletTopUpPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'myr',
    "status" "StripeLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "stripePaymentIntentId" TEXT NOT NULL,
    "failureMessage" TEXT,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletTopUpPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverPayout" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transactionId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'myr',
    "stripeTransferId" TEXT,
    "status" "DriverTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_stripeConnectAccountId_key" ON "Driver"("stripeConnectAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_stripePaymentIntentId_key" ON "WalletTransaction"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverWalletTransaction_stripeTransferId_key" ON "DriverWalletTransaction"("stripeTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTopUpPayment_stripePaymentIntentId_key" ON "WalletTopUpPayment"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverPayout_transactionId_key" ON "DriverPayout"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverPayout_stripeTransferId_key" ON "DriverPayout"("stripeTransferId");

-- AddForeignKey
ALTER TABLE "WalletTopUpPayment" ADD CONSTRAINT "WalletTopUpPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPayout" ADD CONSTRAINT "DriverPayout_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
