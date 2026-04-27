// ── Wallet Ledger Module ────────────────────────────────────
// Owns all money movements for user wallets. Every balance
// change goes through an explicit operation here.

const { fromMinorUnits } = require('../lib/money');
const { REFERRAL_REWARD_AMOUNT } = require('./businessConfig');

// ── Reserve booking payment (debit user wallet) ─────────────

async function reserveBookingPayment(tx, userId, bookingId, orderCode, amount) {
  const wallet = await tx.wallet.findUnique({ where: { userId } });
  if (!wallet || wallet.balance < amount) {
    const currentBalance = wallet?.balance || 0;
    const shortfall = Math.max(0, amount - currentBalance);
    const err = new Error('Insufficient wallet balance. Please top up before booking.');
    err.statusCode = 402;
    err.details = {
      currentBalance,
      amountDue: amount,
      shortfall,
      currency: 'MYR',
    };
    throw err;
  }

  await tx.wallet.update({
    where: { id: wallet.id },
    data: { balance: { decrement: amount } },
  });
  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type: 'PAYMENT',
      amount: -amount,
      description: `Payment for booking ${orderCode}`,
      referenceId: bookingId,
    },
  });

  return wallet;
}

// ── Refund booking (credit user wallet) ─────────────────────

async function refundBooking(prisma, userId, bookingId, amount) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return;

  await prisma.$transaction([
    prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } },
    }),
    prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'REFUND',
        amount,
        description: 'Booking cancellation refund',
        referenceId: bookingId,
      },
    }),
    prisma.booking.update({
      where: { id: bookingId },
      data: { paymentStatus: 'REFUNDED' },
    }),
  ]);
}

// ── Credit Stripe top-up ────────────────────────────────────

async function creditStripeTopUp(tx, topUp) {
  const wallet = await tx.wallet.upsert({
    where: { userId: topUp.userId },
    create: { userId: topUp.userId, balance: fromMinorUnits(topUp.amountMinor) },
    update: { balance: { increment: fromMinorUnits(topUp.amountMinor) } },
  });

  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type: 'TOP_UP',
      amount: fromMinorUnits(topUp.amountMinor),
      description: 'Stripe wallet top-up',
      referenceId: topUp.stripePaymentIntentId,
      stripePaymentIntentId: topUp.stripePaymentIntentId,
    },
  });

  await tx.walletTopUpPayment.update({
    where: { id: topUp.id },
    data: {
      walletId: wallet.id,
      status: 'COMPLETED',
      creditedAt: new Date(),
    },
  });

  return wallet;
}

// ── Apply referral bonus ────────────────────────────────────

async function applyReferralBonus(tx, referrerId, refereeId, referralCode) {
  const rewardAmount = REFERRAL_REWARD_AMOUNT;

  await tx.referral.create({
    data: {
      referrerId,
      refereeId,
      referralCode,
      rewardAmount,
      status: 'COMPLETED',
    },
  });

  for (const userId of [referrerId, refereeId]) {
    const wallet = await tx.wallet.upsert({
      where: { userId },
      create: { userId, balance: rewardAmount },
      update: { balance: { increment: rewardAmount } },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'REFERRAL_BONUS',
        amount: rewardAmount,
        description: 'Referral bonus',
      },
    });
  }

  return rewardAmount;
}

// ── Wallet payment for existing booking ─────────────────────

async function payBookingFromWallet(tx, userId, booking) {
  const amount = booking.estimatedPrice - booking.discountAmount;

  const wallet = await tx.wallet.findUnique({ where: { userId } });
  if (!wallet || wallet.balance < amount) {
    const err = new Error('Insufficient wallet balance');
    err.statusCode = 400;
    throw err;
  }

  await tx.wallet.update({
    where: { id: wallet.id },
    data: { balance: { decrement: amount } },
  });
  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type: 'PAYMENT',
      amount: -amount,
      description: 'Payment for booking',
      referenceId: booking.id,
    },
  });
  await tx.booking.update({
    where: { id: booking.id },
    data: { paymentMethod: 'WALLET', paymentStatus: 'COMPLETED', finalPrice: amount },
  });

  return tx.wallet.findUnique({ where: { id: wallet.id } });
}

module.exports = {
  reserveBookingPayment,
  refundBooking,
  creditStripeTopUp,
  applyReferralBonus,
  payBookingFromWallet,
};
