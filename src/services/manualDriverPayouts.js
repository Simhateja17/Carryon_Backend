const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('./auditLog');

function trim(value) {
  return String(value || '').trim();
}

function hasRequiredBankDetails(driver) {
  return !!(trim(driver?.bankName) && trim(driver?.bankAccountHolder) && trim(driver?.bankAccountNumber));
}

function assertApprovedBankDetails(driver) {
  if (!hasRequiredBankDetails(driver)) {
    throw new AppError('Bank payout details are required before withdrawing.', 400);
  }
  if (driver.bankDetailsStatus !== 'APPROVED') {
    throw new AppError('Bank payout details must be approved before withdrawing.', 400);
  }
}

function bankDetailsSnapshot(driver) {
  return {
    bankName: trim(driver.bankName),
    bankAccountHolder: trim(driver.bankAccountHolder),
    bankAccountNumber: trim(driver.bankAccountNumber),
    duitNowId: trim(driver.duitNowId),
    approvedAt: driver.bankDetailsReviewedAt ? new Date(driver.bankDetailsReviewedAt).toISOString() : null,
    approvedByAdminId: driver.bankDetailsReviewedByAdminId || null,
  };
}

function maskSensitive(value) {
  const raw = trim(value);
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${'*'.repeat(Math.max(4, raw.length - 4))}${raw.slice(-4)}`;
}

function maskedBankDestination(snapshot = {}) {
  return {
    bankName: trim(snapshot.bankName),
    bankAccountHolder: trim(snapshot.bankAccountHolder),
    bankAccountNumber: maskSensitive(snapshot.bankAccountNumber),
    duitNowId: maskSensitive(snapshot.duitNowId),
    hasDuitNowId: !!trim(snapshot.duitNowId),
  };
}

function payoutRequestedAmount(transaction, payout) {
  return transaction?.grossAmount || Math.abs(transaction?.amount || 0) || payout?.amount || 0;
}

async function failManualDriverPayout(tx, payoutId, reason, actor) {
  const payout = await tx.driverPayout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new AppError('Payout not found', 404);

  if (payout.status === 'FAILED') {
    return payout;
  }
  if (payout.status === 'COMPLETED') {
    throw new AppError('Completed payouts cannot be failed.', 400);
  }

  const transaction = payout.transactionId
    ? await tx.driverWalletTransaction.findUnique({ where: { id: payout.transactionId } })
    : null;
  const refundAmount = payoutRequestedAmount(transaction, payout);

  if (refundAmount > 0) {
    await tx.driverWallet.update({
      where: { id: payout.walletId },
      data: { balance: { increment: refundAmount } },
    });
  }

  if (transaction) {
    await tx.driverWalletTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'FAILED',
        description: `${transaction.description || 'Manual withdrawal'} - failed: ${reason}`,
      },
    });
  }

  const updated = await tx.driverPayout.update({
    where: { id: payout.id },
    data: {
      status: 'FAILED',
      failureMessage: reason,
    },
  });

  await recordAudit(tx, {
    actor,
    action: 'DRIVER_PAYOUT_FAILED',
    entityType: 'DriverPayout',
    entityId: payout.id,
    oldValue: { status: payout.status },
    newValue: { status: 'FAILED', reason, refundedAmount: refundAmount },
  });

  return updated;
}

async function failManualDriverPayoutById(payoutId, reason, actor, { db = prisma } = {}) {
  return db.$transaction((tx) => failManualDriverPayout(tx, payoutId, reason, actor));
}

module.exports = {
  assertApprovedBankDetails,
  bankDetailsSnapshot,
  failManualDriverPayout,
  failManualDriverPayoutById,
  hasRequiredBankDetails,
  maskedBankDestination,
  maskSensitive,
  payoutRequestedAmount,
};
