const { Router } = require('express');
const { getStripe } = require('../lib/stripe');
const { recordStripeEvent, processWebhookEvent } = require('../services/webhookInbox');

const router = Router();

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
    const eventRecord = await recordStripeEvent(event);
    const processed = await processWebhookEvent(eventRecord);
    res.json({ received: true, status: processed?.status || eventRecord.status });
  } catch (err) {
    console.error('[stripe-webhook] handler failed:', err);
    res.status(500).json({ received: false });
  }
});

module.exports = router;
