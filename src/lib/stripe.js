const Stripe = require('stripe');

let stripe;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!stripe) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

function stripeCurrency() {
  return (process.env.STRIPE_CURRENCY || 'myr').toLowerCase();
}

function publicStripeConfig() {
  return {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    currency: stripeCurrency(),
    country: process.env.STRIPE_COUNTRY || 'MY',
    walletTopUpMin: Number(process.env.WALLET_TOPUP_MIN || 10),
    walletTopUpMax: Number(process.env.WALLET_TOPUP_MAX || 1000),
  };
}

module.exports = {
  getStripe,
  stripeCurrency,
  publicStripeConfig,
};
