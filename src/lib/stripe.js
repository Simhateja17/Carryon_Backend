const Stripe = require('stripe');

let stripe;
const STRIPE_API_VERSION = '2026-02-25.clover';

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!stripe) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return stripe;
}

function isStripeLiveMode() {
  return String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
}

function stripeCurrency() {
  return (process.env.STRIPE_CURRENCY || 'myr').toLowerCase();
}

function publicStripeConfig() {
  const touchNGoCustomPaymentMethodId =
    process.env.STRIPE_TOUCH_N_GO_CUSTOM_PAYMENT_METHOD_ID ||
    process.env.STRIPE_CUSTOM_PAYMENT_METHOD_TOUCH_N_GO_ID ||
    'cpmt_1TR8enJy59XaYlU6ILwZNDmf';

  return {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    currency: stripeCurrency(),
    country: process.env.STRIPE_COUNTRY || 'MY',
    walletTopUpMin: Number(process.env.WALLET_TOPUP_MIN || 10),
    walletTopUpMax: Number(process.env.WALLET_TOPUP_MAX || 1000),
    customPaymentMethods: touchNGoCustomPaymentMethodId
      ? [
          {
            id: touchNGoCustomPaymentMethodId,
            label: "Touch 'n Go",
            subtitle: 'Malaysian eWallet',
          },
        ]
      : [],
  };
}

module.exports = {
  STRIPE_API_VERSION,
  getStripe,
  isStripeLiveMode,
  stripeCurrency,
  publicStripeConfig,
};
