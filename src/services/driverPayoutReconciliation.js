const prisma = require('../lib/prisma');
const { getStripe, stripeCurrency } = require('../lib/stripe');

function stalePayoutCutoff(now = new Date(), staleAfterMs = 5 * 60 * 1000) {
  return new Date(now.getTime() - staleAfterMs);
}

async function finalizePayout(tx, payout, transferId) {
  if (payout.transactionId) {
    await tx.driverWalletTransaction.update({
      where: { id: payout.transactionId },
      data: {
        status: 'COMPLETED',
        stripeTransferId: transferId,
      },
    });
  }
  return tx.driverPayout.update({
    where: { id: payout.id },
    data: {
      status: 'COMPLETED',
      stripeTransferId: transferId,
      failureMessage: null,
    },
  });
}

async function failPayout(tx, payout, message) {
  await tx.driverWallet.update({
    where: { id: payout.walletId },
    data: { balance: { increment: payout.amount } },
  });
  if (payout.transactionId) {
    await tx.driverWalletTransaction.update({
      where: { id: payout.transactionId },
      data: { status: 'FAILED' },
    });
  }
  return tx.driverPayout.update({
    where: { id: payout.id },
    data: {
      status: 'FAILED',
      failureMessage: message,
    },
  });
}

async function reconcilePayout(payout, { stripe = getStripe(), currency = stripeCurrency() } = {}) {
  try {
    if (payout.stripeTransferId) {
      const transfer = await stripe.transfers.retrieve(payout.stripeTransferId);
      return prisma.$transaction((tx) => finalizePayout(tx, payout, transfer.id));
    }

    const driver = await prisma.driver.findUnique({ where: { id: payout.driverId } });
    if (!driver?.stripeConnectAccountId) {
      return prisma.$transaction((tx) => failPayout(tx, payout, 'Driver Stripe account is missing'));
    }

    const transfer = await stripe.transfers.create({
      amount: payout.amountMinor,
      currency: payout.currency || currency,
      destination: driver.stripeConnectAccountId,
      metadata: {
        driverId: payout.driverId,
        payoutId: payout.id,
        transactionId: payout.transactionId || '',
        reconciled: 'true',
      },
    }, {
      idempotencyKey: `driver-withdrawal-${payout.id}`,
    });
    return prisma.$transaction((tx) => finalizePayout(tx, payout, transfer.id));
  } catch (err) {
    return prisma.$transaction((tx) => failPayout(tx, payout, err.message || 'Stripe transfer reconciliation failed'));
  }
}

async function reconcileStalePayouts({ now = new Date(), staleAfterMs, limit = 25 } = {}) {
  const payouts = await prisma.driverPayout.findMany({
    where: {
      status: 'PENDING',
      updatedAt: { lte: stalePayoutCutoff(now, staleAfterMs) },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  const results = [];
  for (const payout of payouts) {
    results.push(await reconcilePayout(payout));
  }
  return results;
}

function startDriverPayoutReconciliationLoop({ intervalMs = 60_000, staleAfterMs = 5 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    reconcileStalePayouts({ staleAfterMs }).catch((err) => {
      console.error('[driver-payout-reconciliation] loop failed:', err);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  stalePayoutCutoff,
  reconcilePayout,
  reconcileStalePayouts,
  startDriverPayoutReconciliationLoop,
};
