const prisma = require('../lib/prisma');
const { creditStripeTopUp } = require('./walletLedger');
const { failPayout } = require('./driverPayoutReconciliation');
const { createDriverNotificationWithPush } = require('./driverNotifications');
const {
  BOOKING_PAYMENT_PURPOSE,
  markBookingPaymentFailedTx,
  markBookingPaymentSucceededTx,
} = require('./bookingPayments');

async function creditWalletForTopUp(tx, paymentIntent) {
  const paymentIntentId = paymentIntent.id;
  const topUp = await tx.walletTopUpPayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });
  if (!topUp || topUp.status === 'COMPLETED') return;
  await creditStripeTopUp(tx, topUp);
}

async function markTopUp(tx, paymentIntent, status, failureMessage = null) {
  await tx.walletTopUpPayment.updateMany({
    where: {
      stripePaymentIntentId: paymentIntent.id,
      status: { not: 'COMPLETED' },
    },
    data: { status, failureMessage },
  });
}

function accountRequirements(account) {
  return {
    currentlyDue: account.requirements?.currently_due || [],
    eventuallyDue: account.requirements?.eventually_due || [],
    pastDue: account.requirements?.past_due || [],
    disabledReason: account.requirements?.disabled_reason || null,
  };
}

async function syncConnectedAccount(tx, account) {
  if (!account?.id) return;
  const prior = await tx.driver.findUnique({
    where: { stripeConnectAccountId: account.id },
  });

  await tx.driver.updateMany({
    where: { stripeConnectAccountId: account.id },
    data: {
      stripeDetailsSubmitted: !!account.details_submitted,
      stripePayoutsEnabled: !!account.payouts_enabled,
      stripeRequirements: accountRequirements(account),
    },
  });

  const pastDue = account.requirements?.past_due || [];
  if (
    prior?.id &&
    prior.stripePayoutsEnabled === true &&
    account.payouts_enabled !== true &&
    pastDue.length > 0
  ) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await tx.driverNotification.findFirst({
      where: {
        driverId: prior.id,
        type: 'PAYOUT_SETUP_NEEDED',
        createdAt: { gte: since },
      },
    });
    if (!existing) {
      await createDriverNotificationWithPush({
        db: tx,
        driverId: prior.id,
        type: 'PAYOUT_SETUP_NEEDED',
        title: 'Update your payout details',
        message: 'Stripe needs urgent payout details to keep withdrawals active.',
        data: {
          pastDueFields: pastDue.join(','),
          disabledReason: account.requirements?.disabled_reason || '',
        },
      });
    }
  }
}

function payoutAmountLabel(payout) {
  const currency = String(payout.currency || 'myr').toUpperCase();
  return `${currency} ${Number(payout.amount || 0).toFixed(2)}`;
}

async function findDriverPayoutForStripePayout(tx, stripePayout) {
  const stripePayoutId = stripePayout?.id;
  if (stripePayoutId) {
    const byStripePayoutId = await tx.driverPayout.findUnique({
      where: { stripePayoutId },
    });
    if (byStripePayoutId) return byStripePayoutId;
  }

  const metadataPayoutId = stripePayout?.metadata?.payoutId;
  if (metadataPayoutId) {
    return tx.driverPayout.findUnique({ where: { id: metadataPayoutId } });
  }

  return null;
}

async function handlePayoutPaid(tx, stripePayout) {
  const payout = await findDriverPayoutForStripePayout(tx, stripePayout);
  if (!payout) {
    console.warn('[driver-payout-webhook] payout.paid for unknown payout id', stripePayout?.id);
    return;
  }
  if (payout.status === 'COMPLETED' || payout.status === 'FAILED') return;

  if (payout.transactionId) {
    await tx.driverWalletTransaction.update({
      where: { id: payout.transactionId },
      data: { status: 'COMPLETED' },
    });
  }
  await tx.driverPayout.update({
    where: { id: payout.id },
    data: {
      status: 'COMPLETED',
      failureMessage: null,
      stripePayoutId: stripePayout.id,
    },
  });

  await createDriverNotificationWithPush({
    db: tx,
    driverId: payout.driverId,
    type: 'PAYOUT_PAID',
    title: 'Withdrawal successful',
    message: `Your withdrawal of ${payoutAmountLabel(payout)} has reached your bank account.`,
    data: {
      payoutId: payout.id,
      stripePayoutId: stripePayout.id,
      transactionId: payout.transactionId || '',
      amount: payout.amount,
    },
  });
}

async function handlePayoutFailed(tx, stripePayout) {
  const payout = await findDriverPayoutForStripePayout(tx, stripePayout);
  if (!payout) {
    console.warn('[driver-payout-webhook] payout.failed for unknown payout id', stripePayout?.id);
    return;
  }
  if (payout.status === 'FAILED' || payout.status === 'COMPLETED') return;

  const reason = stripePayout.failure_message || stripePayout.failure_code || 'Stripe payout failed';
  await failPayout(tx, payout, reason);
  if (stripePayout.id && payout.stripePayoutId !== stripePayout.id) {
    await tx.driverPayout.update({
      where: { id: payout.id },
      data: { stripePayoutId: stripePayout.id },
    });
  }
  await createDriverNotificationWithPush({
    db: tx,
    driverId: payout.driverId,
    type: 'PAYOUT_FAILED',
    title: 'Withdrawal failed',
    message: `Your withdrawal of ${payoutAmountLabel(payout)} failed. Amount refunded to wallet. Reason: ${reason}`,
    data: {
      payoutId: payout.id,
      stripePayoutId: stripePayout.id,
      transactionId: payout.transactionId || '',
      amount: payout.amount,
      failureMessage: reason,
    },
  });
}

async function handleStripeEvent(tx, event) {
  const object = event.data?.object;
  switch (event.type) {
    case 'account.updated':
      await syncConnectedAccount(tx, event.data.object);
      return [];
    case 'payout.paid':
      await handlePayoutPaid(tx, event.data.object);
      return [];
    case 'payout.failed':
      await handlePayoutFailed(tx, event.data.object);
      return [];
    case 'account.external_account.updated':
      if (event.account) {
        await tx.driver.updateMany({
          where: { stripeConnectAccountId: event.account },
          data: { stripePayoutsEnabled: false },
        });
      }
      return [];
    case 'payment_intent.succeeded':
      if (object?.metadata?.purpose === BOOKING_PAYMENT_PURPOSE) {
        return markBookingPaymentSucceededTx(tx, object);
      }
      await creditWalletForTopUp(tx, object);
      return [];
    case 'payment_intent.payment_failed':
      if (object?.metadata?.purpose === BOOKING_PAYMENT_PURPOSE) {
        return markBookingPaymentFailedTx(
          tx,
          object,
          'FAILED',
          object?.last_payment_error?.message || 'Payment failed'
        );
      }
      await markTopUp(tx, object, 'FAILED', object?.last_payment_error?.message || 'Payment failed');
      return [];
    case 'payment_intent.canceled':
      if (object?.metadata?.purpose === BOOKING_PAYMENT_PURPOSE) {
        return markBookingPaymentFailedTx(tx, object, 'CANCELED', 'Payment canceled');
      }
      await markTopUp(tx, object, 'CANCELED', 'Payment canceled');
      return [];
    case 'charge.refunded':
      if (event.data.object?.payment_intent) {
        await markTopUp(tx, { id: event.data.object.payment_intent }, 'REFUNDED', 'Payment refunded');
      }
      return [];
    default:
      return [];
  }
}

module.exports = {
  handleStripeEvent,
  handlePayoutFailed,
  handlePayoutPaid,
  syncConnectedAccount,
};
