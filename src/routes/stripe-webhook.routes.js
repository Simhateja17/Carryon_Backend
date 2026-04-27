const { Router } = require('express');
const prisma = require('../lib/prisma');
const { getStripe } = require('../lib/stripe');
const { creditStripeTopUp } = require('../services/walletLedger');

const router = Router();

async function creditWalletForTopUp(paymentIntent) {
  const paymentIntentId = paymentIntent.id;
  const topUp = await prisma.walletTopUpPayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });
  if (!topUp) {
    console.warn('[stripe-webhook] top-up not found for PaymentIntent:', paymentIntentId);
    return;
  }
  if (topUp.status === 'COMPLETED') return;

  await prisma.$transaction(async (tx) => {
    const current = await tx.walletTopUpPayment.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (!current || current.status === 'COMPLETED') return;

    await creditStripeTopUp(tx, current);
  });
}

async function markTopUp(paymentIntent, status, failureMessage = null) {
  await prisma.walletTopUpPayment.updateMany({
    where: {
      stripePaymentIntentId: paymentIntent.id,
      status: { not: 'COMPLETED' },
    },
    data: { status, failureMessage },
  });
}

router.post('/', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event = req.body;

  try {
    if (webhookSecret) {
      event = getStripe().webhooks.constructEvent(req.body, signature, webhookSecret);
    }
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await creditWalletForTopUp(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await markTopUp(
          event.data.object,
          'FAILED',
          event.data.object?.last_payment_error?.message || 'Payment failed'
        );
        break;
      case 'payment_intent.canceled':
        await markTopUp(event.data.object, 'CANCELED', 'Payment canceled');
        break;
      case 'charge.refunded':
        if (event.data.object?.payment_intent) {
          await markTopUp({ id: event.data.object.payment_intent }, 'REFUNDED', 'Payment refunded');
        }
        break;
      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[stripe-webhook] handler failed:', err);
    res.status(500).json({ received: false });
  }
});

module.exports = router;
