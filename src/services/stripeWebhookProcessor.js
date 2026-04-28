const prisma = require('../lib/prisma');
const { creditStripeTopUp } = require('./walletLedger');

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

async function handleStripeEvent(tx, event) {
  switch (event.type) {
    case 'payment_intent.succeeded':
      await creditWalletForTopUp(tx, event.data.object);
      break;
    case 'payment_intent.payment_failed':
      await markTopUp(
        tx,
        event.data.object,
        'FAILED',
        event.data.object?.last_payment_error?.message || 'Payment failed'
      );
      break;
    case 'payment_intent.canceled':
      await markTopUp(tx, event.data.object, 'CANCELED', 'Payment canceled');
      break;
    case 'charge.refunded':
      if (event.data.object?.payment_intent) {
        await markTopUp(tx, { id: event.data.object.payment_intent }, 'REFUNDED', 'Payment refunded');
      }
      break;
    default:
      break;
  }
}

module.exports = { handleStripeEvent };
